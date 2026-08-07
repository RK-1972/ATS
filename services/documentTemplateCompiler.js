const documentTemplateRepository = require("../repositories/documentTemplateRepository");
const documentTemplatePlaceholderRepository = require("../repositories/documentTemplatePlaceholderRepository");
const documentTemplateService = require("./documentTemplateService");
const { scanDocxBuffer, buildPlaceholderRecord } = require("./documentPlaceholderScanner");
const { validateScanResults } = require("./documentValidationService");

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function dedupePlaceholderRecords(records) {
  const byToken = new Map();

  records.forEach((record) => {
    if (!byToken.has(record.placeholder_token)) {
      byToken.set(record.placeholder_token, record);
    }
  });

  return [...byToken.values()];
}

async function compileTemplate(pool, templateId) {
  const template = await documentTemplateRepository.findTemplateById(pool, templateId);

  if (!template) {
    throw httpError(`Document template not found: ${templateId}`, 404);
  }

  if (!template.document_path) {
    throw httpError("Upload a DOCX file before compiling this template.", 400);
  }

  const file = await documentTemplateService.downloadTemplateDocument(pool, templateId);
  const scanResults = await scanDocxBuffer(file.buffer);
  const validation = validateScanResults(scanResults);

  const storageRecords = dedupePlaceholderRecords([
    ...validation.detectedPlaceholders.map((item) =>
      buildPlaceholderRecord(templateId, item.token, {
        isValid: item.isValid,
        placeholderType: item.placeholderType,
        namespace: item.namespace,
        placeholderKey: item.placeholderKey
      })
    ),
    ...validation.unknownPlaceholders.map((item) =>
      buildPlaceholderRecord(templateId, item.token, {
        isValid: false,
        placeholderType: "unknown",
        namespace: null,
        placeholderKey: null
      })
    )
  ]);

  const stored = await documentTemplatePlaceholderRepository.replacePlaceholdersForTemplate(
    pool,
    templateId,
    storageRecords
  );

  return {
    templateId,
    templateName: template.template_name,
    version: template.version,
    validationStatus: validation.validationStatus,
    totalPlaceholders: validation.totalPlaceholders,
    valid: validation.valid,
    invalid: validation.invalid,
    validationMessages: validation.validationMessages,
    detectedPlaceholders: validation.detectedPlaceholders,
    unknownPlaceholders: validation.unknownPlaceholders,
    missingRegistryEntries: validation.missingRegistryEntries,
    scannedSections: validation.scannedSections,
    storedPlaceholders: stored.map(
      documentTemplatePlaceholderRepository.mapPlaceholderRow
    )
  };
}

async function getTemplatePlaceholders(pool, templateId) {
  const template = await documentTemplateRepository.findTemplateById(pool, templateId);

  if (!template) {
    throw httpError(`Document template not found: ${templateId}`, 404);
  }

  const rows = await documentTemplatePlaceholderRepository.findByTemplateId(
    pool,
    templateId
  );
  const placeholders = rows.map(documentTemplatePlaceholderRepository.mapPlaceholderRow);

  const valid = placeholders.filter((item) => item.isValid);
  const invalid = placeholders.filter((item) => !item.isValid);
  const unknownPlaceholders = placeholders.filter(
    (item) => item.placeholderType === "unknown"
  );
  const missingRegistryEntries = placeholders.filter(
    (item) => item.placeholderType !== "unknown" && !item.isValid
  );

  return {
    templateId,
    templateName: template.template_name,
    version: template.version,
    validationStatus: placeholders.length && invalid.length === 0 ? "Valid" : placeholders.length ? "Invalid" : "Not Compiled",
    totalPlaceholders: placeholders.length,
    valid: valid.length,
    invalid: invalid.length,
    detectedPlaceholders: placeholders.filter((item) => item.placeholderType !== "unknown"),
    unknownPlaceholders,
    missingRegistryEntries,
    placeholders
  };
}

module.exports = {
  compileTemplate,
  getTemplatePlaceholders
};
