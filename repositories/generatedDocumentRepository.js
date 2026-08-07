const FILE_TYPES = {
  DOCX: "DOCX",
  PDF: "PDF"
};

const DOCUMENT_STATUSES = {
  GENERATED: "Generated",
  PENDING: "Pending"
};

function mapGeneratedDocumentRow(row) {
  if (!row) {
    return null;
  }

  return {
    documentId: row.document_id,
    documentType: row.document_type,
    fileType: row.file_type,
    businessObjectType: row.business_object_type,
    businessObjectId: row.business_object_id,
    templateId: row.template_id,
    templateVersion: row.template_version,
    versionNo: row.version_no != null ? Number(row.version_no) : 1,
    documentPath: row.document_path,
    status: row.status,
    generatedBy: row.generated_by,
    generatedOn: row.generated_on?.toISOString?.() || row.generated_on,
    generationDurationMs:
      row.generation_duration_ms != null
        ? Number(row.generation_duration_ms)
        : null,
    createdOn: row.created_on?.toISOString?.() || row.created_on,
    modifiedOn: row.modified_on?.toISOString?.() || row.modified_on
  };
}

async function insertGeneratedDocument(pool, document) {
  const result = await pool.query(
    `INSERT INTO om_generated_documents (
       document_id,
       document_type,
       file_type,
       business_object_type,
       business_object_id,
       template_id,
       template_version,
       version_no,
       document_path,
       status,
       generated_by,
       generated_on,
       generation_duration_ms,
       created_on,
       modified_on
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), $12, NOW(), NOW())
     RETURNING *`,
    [
      document.document_id,
      document.document_type,
      document.file_type,
      document.business_object_type,
      document.business_object_id,
      document.template_id || null,
      document.template_version || null,
      document.version_no != null ? Number(document.version_no) : 1,
      document.document_path,
      document.status || DOCUMENT_STATUSES.GENERATED,
      document.generated_by || null,
      document.generation_duration_ms != null
        ? Number(document.generation_duration_ms)
        : null
    ]
  );

  return result.rows[0];
}

async function getNextVersionNo(pool, businessObjectType, businessObjectId) {
  const result = await pool.query(
    `SELECT COALESCE(MAX(version_no), 0) + 1 AS next_version_no
     FROM om_generated_documents
     WHERE business_object_type = $1
       AND business_object_id = $2`,
    [businessObjectType, businessObjectId]
  );

  return Number(result.rows[0]?.next_version_no || 1);
}

async function findLatestVersionNo(pool, businessObjectType, businessObjectId) {
  const result = await pool.query(
    `SELECT COALESCE(MAX(version_no), 0) AS latest_version_no
     FROM om_generated_documents
     WHERE business_object_type = $1
       AND business_object_id = $2`,
    [businessObjectType, businessObjectId]
  );

  return Number(result.rows[0]?.latest_version_no || 0);
}

async function findLatestVersionDocuments(
  pool,
  businessObjectType,
  businessObjectId,
  documentType = null
) {
  const latestVersionNo = await findLatestVersionNo(
    pool,
    businessObjectType,
    businessObjectId
  );

  if (!latestVersionNo) {
    return [];
  }

  const params = [businessObjectType, businessObjectId, latestVersionNo];
  let documentTypeClause = "";

  if (documentType) {
    documentTypeClause = " AND document_type = $4";
    params.push(documentType);
  }

  const result = await pool.query(
    `SELECT *
     FROM om_generated_documents
     WHERE business_object_type = $1
       AND business_object_id = $2
       AND version_no = $3
       ${documentTypeClause}
     ORDER BY file_type ASC, generated_on DESC`,
    params
  );

  return result.rows;
}

async function findLatestByBusinessObjectFileType(
  pool,
  businessObjectType,
  businessObjectId,
  documentType,
  fileType
) {
  const result = await pool.query(
    `SELECT *
     FROM om_generated_documents
     WHERE business_object_type = $1
       AND business_object_id = $2
       AND document_type = $3
       AND file_type = $4
     ORDER BY version_no DESC, generated_on DESC
     LIMIT 1`,
    [businessObjectType, businessObjectId, documentType, fileType]
  );

  return result.rows[0] || null;
}

async function findByBusinessObject(pool, businessObjectType, businessObjectId) {
  const row = await findLatestByBusinessObjectFileType(
    pool,
    businessObjectType,
    businessObjectId,
    "Offer Letter",
    FILE_TYPES.PDF
  );

  if (row) {
    return row;
  }

  const result = await pool.query(
    `SELECT *
     FROM om_generated_documents
     WHERE business_object_type = $1
       AND business_object_id = $2
     ORDER BY version_no DESC, generated_on DESC
     LIMIT 1`,
    [businessObjectType, businessObjectId]
  );

  return result.rows[0] || null;
}

async function findById(pool, documentId) {
  const result = await pool.query(
    `SELECT *
     FROM om_generated_documents
     WHERE document_id = $1`,
    [documentId]
  );

  return result.rows[0] || null;
}

async function deleteByBusinessObject(pool, businessObjectType, businessObjectId) {
  await pool.query(
    `DELETE FROM om_generated_documents
     WHERE business_object_type = $1
       AND business_object_id = $2`,
    [businessObjectType, businessObjectId]
  );
}

module.exports = {
  FILE_TYPES,
  DOCUMENT_STATUSES,
  mapGeneratedDocumentRow,
  insertGeneratedDocument,
  getNextVersionNo,
  findLatestVersionNo,
  findLatestVersionDocuments,
  findLatestByBusinessObjectFileType,
  findByBusinessObject,
  findById,
  deleteByBusinessObject
};
