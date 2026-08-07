const path = require("path");
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");

const documentTemplateRepository = require("../repositories/documentTemplateRepository");
const { userContext } = require("./enterpriseAuditService");

const DOCUMENT_CATEGORIES = [
  "Offer Letter",
  "Appointment Letter",
  "Experience Letter",
  "Relieving Letter",
  "Promotion Letter",
  "Transfer Letter",
  "Warning Letter"
];

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function createR2Client() {
  return new S3Client({
    region: "auto",
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
    }
  });
}

function sanitizeFileName(fileName) {
  return String(fileName || "template.docx")
    .replace(/[^\w.\-() ]+/g, "_")
    .trim() || "template.docx";
}

function buildTemplateId(templateCode, version) {
  const safeCode = String(templateCode || "TEMPLATE")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toUpperCase();
  const safeVersion = String(version || "1.0").replace(/\./g, "_");

  return `TMPL-${safeCode}-${safeVersion}-${Date.now()}`;
}

async function streamToBuffer(stream) {
  const chunks = [];

  for await (const chunk of stream) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

async function uploadTemplateDocxToR2(file, templateId) {
  const fileName = sanitizeFileName(file.originalname);
  const objectKey = `document-templates/${templateId}/${Date.now()}-${fileName}`;

  await createR2Client().send(
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: objectKey,
      Body: file.buffer,
      ContentType: file.mimetype || DOCX_MIME
    })
  );

  return {
    document_path: objectKey,
    file_name: fileName
  };
}

async function downloadTemplateDocxFromR2(documentPath) {
  const response = await createR2Client().send(
    new GetObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: documentPath
    })
  );

  const buffer = await streamToBuffer(response.Body);

  return {
    buffer,
    contentType: response.ContentType || DOCX_MIME
  };
}

function validateCategory(documentCategory) {
  if (!DOCUMENT_CATEGORIES.includes(documentCategory)) {
    throw httpError(`Invalid document category: ${documentCategory}`, 400);
  }
}

async function getTemplates(pool) {
  const rows = await documentTemplateRepository.findAllTemplates(pool);
  return rows.map(documentTemplateRepository.mapTemplateRow);
}

async function getTemplateById(pool, templateId) {
  const row = await documentTemplateRepository.findTemplateById(pool, templateId);

  if (!row) {
    throw httpError(`Document template not found: ${templateId}`, 404);
  }

  return documentTemplateRepository.mapTemplateRow(row);
}

async function createTemplate(pool, payload, req) {
  const templateCode = String(payload?.template_code || payload?.templateCode || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "_");
  const templateName = String(payload?.template_name || payload?.templateName || "").trim();
  const documentCategory = String(
    payload?.document_category || payload?.documentCategory || ""
  ).trim();
  const version = String(payload?.version || "1.0").trim();
  const actor = userContext(req);

  if (!templateCode) {
    throw httpError("template_code is required.", 400);
  }

  if (!templateName) {
    throw httpError("template_name is required.", 400);
  }

  if (!documentCategory) {
    throw httpError("document_category is required.", 400);
  }

  validateCategory(documentCategory);

  const templateId = buildTemplateId(templateCode, version);

  const row = await documentTemplateRepository.insertTemplate(pool, {
    template_id: templateId,
    template_code: templateCode,
    template_name: templateName,
    document_category: documentCategory,
    version,
    effective_from: payload?.effective_from || payload?.effectiveFrom || null,
    effective_to: payload?.effective_to || payload?.effectiveTo || null,
    status: "Draft",
    is_default: false,
    created_by: actor.name || actor.email_id || "system",
    modified_by: actor.name || actor.email_id || "system"
  });

  return documentTemplateRepository.mapTemplateRow(row);
}

async function uploadTemplateDocument(pool, templateId, file, req) {
  if (!file?.buffer?.length) {
    throw httpError("A DOCX file is required.", 400);
  }

  const row = await documentTemplateRepository.findTemplateById(pool, templateId);

  if (!row) {
    throw httpError(`Document template not found: ${templateId}`, 404);
  }

  const actor = userContext(req);
  const stored = await uploadTemplateDocxToR2(file, templateId);
  const updated = await documentTemplateRepository.updateTemplateFile(
    pool,
    templateId,
    stored,
    actor.name || actor.email_id || "system"
  );

  return documentTemplateRepository.mapTemplateRow(updated);
}

async function activateTemplateVersion(pool, templateId, req) {
  const row = await documentTemplateRepository.findTemplateById(pool, templateId);

  if (!row) {
    throw httpError(`Document template not found: ${templateId}`, 404);
  }

  if (!row.document_path) {
    throw httpError("Upload a DOCX file before activating this template version.", 400);
  }

  const actor = userContext(req);
  const modifiedBy = actor.name || actor.email_id || "system";

  await documentTemplateRepository.deactivateActiveVersions(
    pool,
    row.template_code,
    templateId
  );

  const activated = await documentTemplateRepository.activateTemplate(
    pool,
    templateId,
    modifiedBy
  );

  if (row.is_default) {
    await documentTemplateRepository.clearDefaultForCategory(
      pool,
      row.document_category,
      templateId
    );
    await documentTemplateRepository.setTemplateDefault(
      pool,
      templateId,
      true,
      modifiedBy
    );
  }

  const latest = await documentTemplateRepository.findTemplateById(pool, templateId);
  return documentTemplateRepository.mapTemplateRow(latest);
}

async function downloadTemplateDocument(pool, templateId) {
  const row = await documentTemplateRepository.findTemplateById(pool, templateId);

  if (!row) {
    throw httpError(`Document template not found: ${templateId}`, 404);
  }

  if (!row.document_path) {
    throw httpError("No document has been uploaded for this template.", 404);
  }

  const file = await downloadTemplateDocxFromR2(row.document_path);

  return {
    buffer: file.buffer,
    contentType: file.contentType,
    fileName: row.file_name || path.basename(row.document_path)
  };
}

module.exports = {
  DOCUMENT_CATEGORIES,
  getTemplates,
  getTemplateById,
  createTemplate,
  uploadTemplateDocument,
  activateTemplateVersion,
  downloadTemplateDocument
};
