const PizZip = require("pizzip");
const Docxtemplater = require("docxtemplater");
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");

const documentTemplateRepository = require("../repositories/documentTemplateRepository");
const documentTemplatePlaceholderRepository = require("../repositories/documentTemplatePlaceholderRepository");
const generatedDocumentRepository = require("../repositories/generatedDocumentRepository");
const offerLetterRepository = require("../repositories/offerLetterRepository");
const offerLetterValidation = require("./offerLetterValidation");
const offerLetterGenerationService = require("./offerLetterGenerationService");
const placeholderRegistry = require("./placeholderRegistry");
const { resolvePlaceholder } = require("./placeholderResolver");
const { userContext } = require("./enterpriseAuditService");

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const COMPANY_NAME = "IGS Engineering Quality";
const COMPANY_ADDRESS = "Bengaluru, Karnataka, India";

const DOCX_PART_PATTERN =
  /^word\/(document\.xml|header\d+\.xml|footer\d+\.xml)$/i;

const TABLE_TOKEN = "{{TABLE:Compensation}}";
const TABLE_MARKER = "[[OPTALYNX_COMPENSATION_TABLE]]";
const PERSISTED_EARNINGS_COMPONENTS = new Set(["Basic + DA", "HRA"]);
const AWAITING_LETTER_STATUS = "Awaiting Letter";

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatCurrency(amount, currency = "INR") {
  const numeric = Number(amount || 0);

  if (currency === "INR") {
    return `INR ${numeric.toLocaleString("en-IN", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    })}`;
  }

  return `${currency} ${numeric.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

function formatDate(value) {
  if (!value) {
    return "";
  }

  return new Date(value).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric"
  });
}

function buildCompensationTableXml(rows) {
  const tableRows = [
    `<w:tr>
      <w:tc><w:p><w:r><w:t>Component</w:t></w:r></w:p></w:tc>
      <w:tc><w:p><w:r><w:t>Amount</w:t></w:r></w:p></w:tc>
    </w:tr>`
  ];

  (rows || []).forEach((row) => {
    tableRows.push(
      `<w:tr>
        <w:tc><w:p><w:r><w:t>${escapeXml(row.componentName)}</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>${escapeXml(formatCurrency(row.amount))}</w:t></w:r></w:p></w:tc>
      </w:tr>`
    );
  });

  return `<w:tbl>
    <w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr>
    <w:tblGrid><w:gridCol w:w="5000"/><w:gridCol w:w="5000"/></w:tblGrid>
    ${tableRows.join("")}
  </w:tbl>`;
}

function injectCompensationTables(xml, compensationRows) {
  const tableXml = buildCompensationTableXml(compensationRows);

  if (!xml.includes(TABLE_MARKER) && !xml.includes(TABLE_TOKEN)) {
    return xml;
  }

  let updated = xml.split(TABLE_TOKEN).join(TABLE_MARKER);

  updated = updated.replace(
    new RegExp(
      `<w:p[^>]*>(?:(?!</w:p>).)*${TABLE_MARKER}(?:(?!</w:p>).)*</w:p>`,
      "g"
    ),
    tableXml
  );

  return updated.split(TABLE_MARKER).join("");
}

function prepareTableMarkers(zip) {
  Object.keys(zip.files).forEach((partName) => {
    if (!DOCX_PART_PATTERN.test(partName)) {
      return;
    }

    const file = zip.files[partName];
    let content = file.asText();
    content = content.split(TABLE_TOKEN).join(TABLE_MARKER);
    zip.file(partName, content);
  });
}

function injectTablesIntoZip(zip, compensationRows) {
  Object.keys(zip.files).forEach((partName) => {
    if (!DOCX_PART_PATTERN.test(partName)) {
      return;
    }

    const file = zip.files[partName];
    const updated = injectCompensationTables(file.asText(), compensationRows);
    zip.file(partName, updated);
  });
}

function mergeScalarPlaceholders(templateBuffer, mergeData) {
  const zip = new PizZip(templateBuffer);
  prepareTableMarkers(zip);

  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
    delimiters: {
      start: "{{",
      end: "}}"
    }
  });

  doc.render(mergeData);

  return doc.getZip().generate({ type: "nodebuffer" });
}

function mergeDocxTemplate(templateBuffer, mergeData, compensationRows) {
  const mergedScalars = mergeScalarPlaceholders(templateBuffer, mergeData);
  const zip = new PizZip(mergedScalars);
  injectTablesIntoZip(zip, compensationRows);

  return zip.generate({ type: "nodebuffer" });
}

function scanRemainingPlaceholders(buffer) {
  const zip = new PizZip(buffer);
  const unknown = new Set();

  Object.keys(zip.files).forEach((partName) => {
    if (!DOCX_PART_PATTERN.test(partName)) {
      return;
    }

    const content = zip.file(partName).asText();
    const matches = content.match(/\{\{[^}]+\}\}/g) || [];
    matches.forEach((token) => unknown.add(token));
  });

  return [...unknown];
}

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

async function streamToBuffer(stream) {
  const chunks = [];

  for await (const chunk of stream) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

async function uploadGeneratedDocx(buffer, businessObjectType, businessObjectId) {
  const objectKey = `generated-documents/${businessObjectType}/${businessObjectId}/${Date.now()}.docx`;

  await createR2Client().send(
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: objectKey,
      Body: buffer,
      ContentType: DOCX_MIME
    })
  );

  return objectKey;
}

async function downloadGeneratedDocx(documentPath) {
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

async function findOfferMergeContext(pool, offerId) {
  const result = await pool.query(
    `SELECT
       o.offer_id,
       o.candidate_id,
       o.candidate_name,
       o.position_title,
       o.offered_ctc,
       o.currency,
       o.hiring_manager,
       o.recruiter_id,
       o.valid_until,
       o.offer_status,
       o.requisition_code,
       c.email_id AS candidate_email,
       u.full_name AS recruiter_name
     FROM om_offers o
     LEFT JOIN cand_mstr c ON c.candidate_id = o.candidate_id
     LEFT JOIN user_mstr u ON u.employee_code = o.recruiter_id
     WHERE o.offer_id = $1`,
    [offerId]
  );

  return result.rows[0] || null;
}

async function resolveTemplate(pool, templateId, documentCategory = "Offer Letter") {
  let template = null;

  if (templateId) {
    template = await documentTemplateRepository.findTemplateById(pool, templateId);
  } else {
    template = await documentTemplateRepository.findActiveDefaultByCategory(
      pool,
      documentCategory
    );
  }

  if (!template) {
    throw httpError("Active template is not available for this document type.", 400);
  }

  if (template.status !== "Active") {
    throw httpError(`Template ${template.template_id} is not active.`, 400);
  }

  if (!template.document_path) {
    throw httpError("Template DOCX is missing in Cloudflare R2.", 400);
  }

  return template;
}

async function validateCompiledTemplate(pool, templateId) {
  const placeholders = await documentTemplatePlaceholderRepository.findByTemplateId(
    pool,
    templateId
  );

  if (!placeholders.length) {
    throw httpError(
      "Template has not been compiled. Compile the template before generating documents.",
      400
    );
  }

  const invalid = placeholders.filter((item) => !item.is_valid);

  if (invalid.length) {
    throw httpError(
      `Template contains invalid placeholders: ${invalid
        .map((item) => item.placeholder_token)
        .join(", ")}`,
      400
    );
  }

  return placeholders;
}

async function loadPersistedCompensationBreakup(pool, offerId) {
  const letter = await offerLetterRepository.findLetterByOfferId(pool, offerId);

  if (!letter?.letter_id) {
    throw httpError(
      "Compensation calculation required before document generation.",
      400
    );
  }

  const rows = await offerLetterRepository.findCtcComponents(pool, letter.letter_id);

  if (!rows.length) {
    throw httpError(
      "Compensation calculation required before document generation.",
      400
    );
  }

  const compensationRows = rows
    .map((row) => ({
      componentName: row.component_name,
      amount: Number(row.amount || 0),
      displayOrder: Number(row.display_order || 0)
    }))
    .sort((left, right) => left.displayOrder - right.displayOrder);

  const totalCtc = Number(
    compensationRows.reduce((sum, item) => sum + item.amount, 0).toFixed(2)
  );

  const gross = Number(
    compensationRows
      .filter((item) => PERSISTED_EARNINGS_COMPONENTS.has(item.componentName))
      .reduce((sum, item) => sum + item.amount, 0)
      .toFixed(2)
  );

  return {
    letterId: letter.letter_id,
    rows: compensationRows,
    gross,
    totalCtc
  };
}

function buildOfferMergeData(offerRow, compensation) {
  const companyName = COMPANY_NAME;
  const companyAddress = COMPANY_ADDRESS;

  return {
    Candidate: {
      Name: offerRow.candidate_name || "",
      Email: offerRow.candidate_email || ""
    },
    Offer: {
      Number: offerRow.offer_id || "",
      Designation: offerRow.position_title || "",
      JoiningDate: formatDate(offerRow.valid_until),
      AnnualCTC: formatCurrency(offerRow.offered_ctc, offerRow.currency)
    },
    Company: {
      Name: companyName,
      Address: companyAddress
    },
    Organization: {
      Name: companyName,
      Address: companyAddress
    },
    Recruiter: {
      Name: offerRow.recruiter_name || offerRow.recruiter_id || ""
    },
    ReportingManager: {
      Name: offerRow.hiring_manager || ""
    },
    Compensation: {
      TotalCTC: formatCurrency(compensation.totalCtc, offerRow.currency)
    }
  };
}

function assertRequiredMergeValues(mergeData, placeholders) {
  const messages = [];

  placeholders.forEach((row) => {
    if (row.placeholder_type === "table") {
      return;
    }

    const resolved = resolvePlaceholder(row.placeholder_token, placeholderRegistry);

    if (!resolved.recognized) {
      messages.push(`Unknown placeholder: ${row.placeholder_token}`);
      return;
    }

    const namespace = resolved.parsed.namespace;
    const key = resolved.parsed.key;
    const value = mergeData?.[namespace]?.[key];

    if (value == null || String(value).trim() === "") {
      messages.push(`Required placeholder missing data: ${row.placeholder_token}`);
    }
  });

  if (messages.length) {
    throw httpError(messages.join(" "), 400);
  }
}

async function generateDocument(pool, payload, req) {
  const businessObjectType = String(
    payload?.businessObjectType || payload?.business_object_type || ""
  )
    .trim()
    .toUpperCase();
  const businessObjectId = String(
    payload?.businessObjectId || payload?.business_object_id || ""
  ).trim();

  if (!businessObjectType) {
    throw httpError("businessObjectType is required.", 400);
  }

  if (!businessObjectId) {
    throw httpError("businessObjectId is required.", 400);
  }

  if (businessObjectType !== "OFFER") {
    throw httpError(`Unsupported business object type: ${businessObjectType}`, 400);
  }

  return offerLetterGenerationService.generateOfferLetterDocument(
    pool,
    businessObjectId,
    req
  );
}

async function getGeneratedDocument(pool, documentId) {
  const row = await generatedDocumentRepository.findById(pool, documentId);

  if (!row) {
    throw httpError(`Generated document not found: ${documentId}`, 404);
  }

  if (String(row.business_object_type || "").trim().toUpperCase() === "OFFER") {
    const offerRow = await offerLetterRepository.findOfferLetterDetail(
      pool,
      row.business_object_id
    );

    if (!offerRow) {
      throw httpError(`Offer not found: ${row.business_object_id}`, 404);
    }

    offerLetterValidation.assertGeneratedLetterAccess(offerRow);
  }

  return generatedDocumentRepository.mapGeneratedDocumentRow(row);
}

async function downloadGeneratedDocument(pool, documentId) {
  const row = await generatedDocumentRepository.findById(pool, documentId);

  if (!row) {
    throw httpError(`Generated document not found: ${documentId}`, 404);
  }

  if (String(row.business_object_type || "").trim().toUpperCase() === "OFFER") {
    const offerRow = await offerLetterRepository.findOfferLetterDetail(
      pool,
      row.business_object_id
    );

    if (!offerRow) {
      throw httpError(`Offer not found: ${row.business_object_id}`, 404);
    }

    offerLetterValidation.assertGeneratedLetterAccess(offerRow);
  }

  const file = await downloadGeneratedDocx(row.document_path);

  return {
    buffer: file.buffer,
    contentType: file.contentType,
    fileName: `${row.document_type || "Document"}.docx`
  };
}

async function downloadGeneratedDocumentForOffer(pool, offerId) {
  return offerLetterGenerationService.downloadOfferLetterPdf(pool, offerId);
}

module.exports = {
  mergeDocxTemplate,
  scanRemainingPlaceholders,
  formatCurrency,
  formatDate,
  loadPersistedCompensationBreakup,
  generateDocument,
  getGeneratedDocument,
  downloadGeneratedDocument,
  downloadGeneratedDocumentForOffer
};
