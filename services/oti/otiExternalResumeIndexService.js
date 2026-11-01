/**
 * Phase 2-style indexing for external lead documents (separate from cand_mstr).
 */

const masterDataService = require("../masterDataService");
const otiResumeExtractionService = require("./otiResumeExtractionService");
const otiResumeStorageService = require("./otiResumeStorageService");
const { extractSkillsFromText } = require("./otiResumeIndexService");
const { truncateForIndex, normalizeResumeText } = require("./otiResumeTextUtils");

function resolveByteLength(documentRow, buffer) {
  const fromMetadata = Number(documentRow?.byte_length);

  if (Number.isFinite(fromMetadata) && fromMetadata > 0) {
    return Math.trunc(fromMetadata);
  }

  if (Buffer.isBuffer(buffer) && buffer.length > 0) {
    return buffer.length;
  }

  throw new Error("Document byte length is unavailable for resume indexing.");
}

async function hydrateDocumentRow(pool, documentRow) {
  const hasMetadata =
    documentRow?.document_id &&
    documentRow?.storage_key &&
    documentRow?.content_hash &&
    documentRow?.detected_format != null &&
    Number(documentRow?.byte_length) > 0;

  if (hasMetadata) {
    return documentRow;
  }

  const documentId = Number(documentRow?.document_id);

  if (!Number.isFinite(documentId) || documentId <= 0) {
    throw new Error("Document metadata is incomplete for external resume indexing.");
  }

  const result = await pool.query(
    `SELECT document_id, storage_key, content_hash, detected_format, byte_length
     FROM oti_external_resume_document
     WHERE document_id = $1
     LIMIT 1`,
    [documentId]
  );

  const stored = result.rows[0];

  if (!stored) {
    throw new Error("Stored external resume document was not found for indexing.");
  }

  if (!Number(stored.byte_length) || Number(stored.byte_length) <= 0) {
    throw new Error("Stored external resume document is missing a valid byte length.");
  }

  return {
    ...documentRow,
    ...stored
  };
}

async function ensureExternalIndexRow(pool, externalLeadId) {
  const existing = await pool.query(
    "SELECT index_id FROM oti_external_resume_index WHERE external_lead_id = $1 LIMIT 1",
    [externalLeadId]
  );

  if (existing.rows[0]) {
    return existing.rows[0];
  }

  const inserted = await pool.query(
    `INSERT INTO oti_external_resume_index (external_lead_id, extraction_status)
     VALUES ($1, 'pending')
     RETURNING *`,
    [externalLeadId]
  );

  return inserted.rows[0];
}

async function loadPublishedSkills(pool) {
  const records = await masterDataService.listByEntityType(pool, "skills");
  return records.filter(
    (record) =>
      String(record?.status || "").trim() === "Active" &&
      String(record?.versionStatus || record?.version_status || "").trim() === "Published"
  );
}

async function indexExternalLeadDocument(pool, externalLeadId, documentRow, deps = {}) {
  await ensureExternalIndexRow(pool, externalLeadId);

  const hydratedDocumentRow = await hydrateDocumentRow(pool, documentRow);

  const download = deps.downloadResumeBuffer || otiResumeStorageService.downloadResumeBuffer;
  const extract = deps.extractResumeText || otiResumeExtractionService.extractResumeText;

  const existing = await pool.query(
    "SELECT content_hash, extraction_status FROM oti_external_resume_index WHERE external_lead_id = $1",
    [externalLeadId]
  );

  if (
    existing.rows[0]?.content_hash === hydratedDocumentRow.content_hash &&
    existing.rows[0]?.extraction_status === "indexed"
  ) {
    return getPublicExternalIndexStatus(pool, externalLeadId);
  }

  if (hydratedDocumentRow.detected_format !== "pdf") {
    const byteLength = resolveByteLength(hydratedDocumentRow, null);

    await pool.query(
      `UPDATE oti_external_resume_index
       SET document_id = $2,
           storage_key = $3,
           content_hash = $4,
           extraction_status = 'unsupported',
           failure_reason = $5,
           byte_length = $6,
           last_attempt_on = NOW(),
           attempt_count = attempt_count + 1,
           updated_on = NOW()
       WHERE external_lead_id = $1`,
      [
        externalLeadId,
        hydratedDocumentRow.document_id,
        hydratedDocumentRow.storage_key,
        hydratedDocumentRow.content_hash,
        "Only PDF documents are indexed for full-text search in Phase 4.",
        byteLength
      ]
    );

    await pool.query(
      `UPDATE oti_external_lead SET resume_index_status = 'unsupported', updated_on = NOW() WHERE external_lead_id = $1`,
      [externalLeadId]
    );

    return getPublicExternalIndexStatus(pool, externalLeadId);
  }

  let buffer;

  try {
    buffer = await download(hydratedDocumentRow.storage_key);
  } catch (error) {
    await pool.query(
      `UPDATE oti_external_resume_index
       SET extraction_status = 'failed', failure_reason = $2, updated_on = NOW()
       WHERE external_lead_id = $1`,
      [externalLeadId, error.message || "Document download failed."]
    );
    await pool.query(
      `UPDATE oti_external_lead SET resume_index_status = 'failed', updated_on = NOW() WHERE external_lead_id = $1`,
      [externalLeadId]
    );
    return getPublicExternalIndexStatus(pool, externalLeadId);
  }

  const extraction = await extract({
    resumePath: `${hydratedDocumentRow.storage_key}.pdf`,
    buffer
  });

  const byteLength = resolveByteLength(hydratedDocumentRow, buffer);

  if (!extraction.ok) {
    await pool.query(
      `UPDATE oti_external_resume_index
       SET extraction_status = $2,
           failure_reason = $3,
           document_id = $4,
           storage_key = $5,
           content_hash = $6,
           byte_length = $7,
           last_attempt_on = NOW(),
           attempt_count = attempt_count + 1,
           updated_on = NOW()
       WHERE external_lead_id = $1`,
      [
        externalLeadId,
        extraction.status,
        extraction.reason,
        hydratedDocumentRow.document_id,
        hydratedDocumentRow.storage_key,
        hydratedDocumentRow.content_hash,
        byteLength
      ]
    );
    await pool.query(
      `UPDATE oti_external_lead SET resume_index_status = 'failed', updated_on = NOW() WHERE external_lead_id = $1`,
      [externalLeadId]
    );
    return getPublicExternalIndexStatus(pool, externalLeadId);
  }

  const searchText = truncateForIndex(extraction.text);
  const publishedSkills = await loadPublishedSkills(pool);
  const extractedSkills = extractSkillsFromText(normalizeResumeText(searchText), publishedSkills);

  await pool.query(
    `UPDATE oti_external_resume_index
     SET document_id = $2,
         storage_key = $3,
         content_hash = $4,
         extraction_status = 'indexed',
         failure_reason = NULL,
         extracted_text = $5,
         search_text = $5,
         search_vector = to_tsvector('english', COALESCE($5, '')),
         extracted_skills = $6,
         text_length = $7,
         byte_length = $8,
         indexed_on = NOW(),
         last_attempt_on = NOW(),
         attempt_count = attempt_count + 1,
         updated_on = NOW()
     WHERE external_lead_id = $1`,
    [
      externalLeadId,
      hydratedDocumentRow.document_id,
      hydratedDocumentRow.storage_key,
      hydratedDocumentRow.content_hash,
      searchText,
      JSON.stringify(extractedSkills),
      searchText.length,
      byteLength
    ]
  );

  await pool.query(
    `UPDATE oti_external_lead SET resume_index_status = 'indexed', updated_on = NOW() WHERE external_lead_id = $1`,
    [externalLeadId]
  );

  return getPublicExternalIndexStatus(pool, externalLeadId);
}

async function getPublicExternalIndexStatus(pool, externalLeadId) {
  const result = await pool.query(
    `SELECT external_lead_id, extraction_status, indexed_on, failure_reason, content_hash,
            text_length, attempt_count
     FROM oti_external_resume_index
     WHERE external_lead_id = $1`,
    [externalLeadId]
  );

  const row = result.rows[0];

  if (!row) {
    return {
      external_lead_id: externalLeadId,
      extraction_status: "not_indexed"
    };
  }

  return {
    external_lead_id: row.external_lead_id,
    extraction_status: row.extraction_status,
    indexed_on: row.indexed_on,
    failure_reason: row.failure_reason,
    content_hash: row.content_hash,
    text_length: row.text_length,
    attempt_count: row.attempt_count
  };
}

module.exports = {
  indexExternalLeadDocument,
  getPublicExternalIndexStatus
};
