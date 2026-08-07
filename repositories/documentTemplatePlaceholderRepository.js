const crypto = require("crypto");

function mapPlaceholderRow(row) {
  return {
    templatePlaceholderId: row.template_placeholder_id,
    templateId: row.template_id,
    placeholderToken: row.placeholder_token,
    namespace: row.namespace,
    placeholderKey: row.placeholder_key,
    placeholderType: row.placeholder_type,
    isValid: Boolean(row.is_valid),
    createdOn: row.created_on?.toISOString?.() || row.created_on
  };
}

async function deleteByTemplateId(pool, templateId) {
  await pool.query(
    `DELETE FROM cm_document_template_placeholders
     WHERE template_id = $1`,
    [templateId]
  );
}

function buildPlaceholderStorageId(templateId, placeholderToken) {
  const digest = crypto
    .createHash("sha256")
    .update(`${templateId}:${placeholderToken}`)
    .digest("hex")
    .slice(0, 32);

  return `TP-${digest}`;
}

async function insertPlaceholders(pool, templateId, placeholders) {
  if (!placeholders.length) {
    return [];
  }

  const values = [];
  const params = [];
  let index = 1;

  placeholders.forEach((item) => {
    const templatePlaceholderId = buildPlaceholderStorageId(
      templateId,
      item.placeholder_token
    );

    console.log(
      `[documentTemplatePlaceholder] compile id=${templatePlaceholderId} token=${item.placeholder_token}`
    );

    values.push(
      `($${index++}, $${index++}, $${index++}, $${index++}, $${index++}, $${index++}, $${index++})`
    );
    params.push(
      templatePlaceholderId,
      templateId,
      item.placeholder_token,
      item.namespace || null,
      item.placeholder_key || null,
      item.placeholder_type,
      Boolean(item.is_valid)
    );
  });

  const result = await pool.query(
    `INSERT INTO cm_document_template_placeholders (
       template_placeholder_id,
       template_id,
       placeholder_token,
       namespace,
       placeholder_key,
       placeholder_type,
       is_valid
     ) VALUES ${values.join(", ")}
     RETURNING *`,
    params
  );

  return result.rows;
}

async function replacePlaceholdersForTemplate(pool, templateId, placeholders) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(
      `DELETE FROM cm_document_template_placeholders
       WHERE template_id = $1`,
      [templateId]
    );

    if (!placeholders.length) {
      await client.query("COMMIT");
      return [];
    }

    const values = [];
    const params = [];
    let index = 1;

    placeholders.forEach((item) => {
      const templatePlaceholderId = buildPlaceholderStorageId(
        templateId,
        item.placeholder_token
      );

      console.log(
        `[documentTemplatePlaceholder] compile id=${templatePlaceholderId} token=${item.placeholder_token}`
      );

      values.push(
        `($${index++}, $${index++}, $${index++}, $${index++}, $${index++}, $${index++}, $${index++})`
      );
      params.push(
        templatePlaceholderId,
        templateId,
        item.placeholder_token,
        item.namespace || null,
        item.placeholder_key || null,
        item.placeholder_type,
        Boolean(item.is_valid)
      );
    });

    const result = await client.query(
      `INSERT INTO cm_document_template_placeholders (
         template_placeholder_id,
         template_id,
         placeholder_token,
         namespace,
         placeholder_key,
         placeholder_type,
         is_valid
       ) VALUES ${values.join(", ")}
       RETURNING *`,
      params
    );

    await client.query("COMMIT");
    return result.rows;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function findByTemplateId(pool, templateId) {
  const result = await pool.query(
    `SELECT *
     FROM cm_document_template_placeholders
     WHERE template_id = $1
     ORDER BY placeholder_token ASC`,
    [templateId]
  );

  return result.rows;
}

module.exports = {
  mapPlaceholderRow,
  buildPlaceholderStorageId,
  deleteByTemplateId,
  insertPlaceholders,
  replacePlaceholdersForTemplate,
  findByTemplateId
};
