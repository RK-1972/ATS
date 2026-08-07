function mapTemplateRow(row) {
  return {
    templateId: row.template_id,
    templateCode: row.template_code,
    templateName: row.template_name,
    documentCategory: row.document_category,
    documentPath: row.document_path,
    fileName: row.file_name,
    version: row.version,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    status: row.status,
    isDefault: Boolean(row.is_default),
    createdOn: row.created_on?.toISOString?.() || row.created_on,
    createdBy: row.created_by,
    modifiedOn: row.modified_on?.toISOString?.() || row.modified_on,
    modifiedBy: row.modified_by
  };
}

async function findAllTemplates(pool) {
  const result = await pool.query(
    `SELECT *
     FROM cm_document_templates
     ORDER BY document_category ASC, template_name ASC, version DESC`
  );

  return result.rows;
}

async function findTemplateById(pool, templateId) {
  const result = await pool.query(
    `SELECT *
     FROM cm_document_templates
     WHERE template_id = $1`,
    [templateId]
  );

  return result.rows[0] || null;
}

async function findActiveDefaultByCategory(pool, documentCategory) {
  const result = await pool.query(
    `SELECT *
     FROM cm_document_templates
     WHERE document_category = $1
       AND status = 'Active'
       AND is_default = TRUE
     ORDER BY modified_on DESC
     LIMIT 1`,
    [documentCategory]
  );

  return result.rows[0] || null;
}

async function findLatestVersionByCode(pool, templateCode) {
  const result = await pool.query(
    `SELECT *
     FROM cm_document_templates
     WHERE template_code = $1
     ORDER BY created_on DESC
     LIMIT 1`,
    [templateCode]
  );

  return result.rows[0] || null;
}

async function insertTemplate(pool, template) {
  const result = await pool.query(
    `INSERT INTO cm_document_templates (
       template_id,
       template_code,
       template_name,
       document_category,
       version,
       effective_from,
       effective_to,
       status,
       is_default,
       created_by,
       modified_by
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [
      template.template_id,
      template.template_code,
      template.template_name,
      template.document_category,
      template.version,
      template.effective_from || null,
      template.effective_to || null,
      template.status || "Draft",
      Boolean(template.is_default),
      template.created_by || null,
      template.modified_by || null
    ]
  );

  return result.rows[0];
}

async function updateTemplateFile(pool, templateId, fileMeta, modifiedBy) {
  const result = await pool.query(
    `UPDATE cm_document_templates
     SET document_path = $2,
         file_name = $3,
         modified_on = NOW(),
         modified_by = $4
     WHERE template_id = $1
     RETURNING *`,
    [templateId, fileMeta.document_path, fileMeta.file_name, modifiedBy || null]
  );

  return result.rows[0] || null;
}

async function deactivateActiveVersions(pool, templateCode, excludeTemplateId) {
  await pool.query(
    `UPDATE cm_document_templates
     SET status = 'Inactive',
         modified_on = NOW()
     WHERE template_code = $1
       AND template_id <> $2
       AND status = 'Active'`,
    [templateCode, excludeTemplateId]
  );
}

async function clearDefaultForCategory(pool, documentCategory, excludeTemplateId) {
  await pool.query(
    `UPDATE cm_document_templates
     SET is_default = FALSE,
         modified_on = NOW()
     WHERE document_category = $1
       AND template_id <> $2
       AND is_default = TRUE`,
    [documentCategory, excludeTemplateId]
  );
}

async function activateTemplate(pool, templateId, modifiedBy) {
  const result = await pool.query(
    `UPDATE cm_document_templates
     SET status = 'Active',
         modified_on = NOW(),
         modified_by = $2
     WHERE template_id = $1
     RETURNING *`,
    [templateId, modifiedBy || null]
  );

  return result.rows[0] || null;
}

async function setTemplateDefault(pool, templateId, isDefault, modifiedBy) {
  const result = await pool.query(
    `UPDATE cm_document_templates
     SET is_default = $2,
         modified_on = NOW(),
         modified_by = $3
     WHERE template_id = $1
     RETURNING *`,
    [templateId, Boolean(isDefault), modifiedBy || null]
  );

  return result.rows[0] || null;
}

module.exports = {
  mapTemplateRow,
  findAllTemplates,
  findTemplateById,
  findActiveDefaultByCategory,
  findLatestVersionByCode,
  insertTemplate,
  updateTemplateFile,
  deactivateActiveVersions,
  clearDefaultForCategory,
  activateTemplate,
  setTemplateDefault
};
