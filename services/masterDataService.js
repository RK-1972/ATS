const crypto = require("crypto");

const {
  MASTER_DATA_DOMAINS,
  DEFAULT_USED_BY,
  ENTITY_TYPE_KEYS,
  kebabToSnake,
  isValidEntityType
} = require("../masterData/entityTypes");
const skillsMasterDataService = require("./skillsMasterDataService");

function buildRecordId(entityType, code) {
  const slug = code.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return `md-${entityType}-${slug}`;
}

function buildAuditId() {
  return `audit-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
}

function userContext(req) {
  return {
    name: req.user?.full_name || req.user?.email_id || "System User",
    role: req.user?.role_name || "Admin",
    id: req.user?.user_id || null
  };
}

function rowToRecord(row, history = [], skillCategoryMap = null) {
  const record = {
    id: row.id,
    entityType: row.entity_type,
    code: row.code,
    name: row.name,
    description: row.description || "",
    status: row.status,
    version: String(Number(row.version).toFixed(1)),
    versionStatus: row.version_status,
    usedBy: row.used_by || [],
    lastUpdated: row.modified_on?.toISOString?.() || new Date().toISOString(),
    effectiveFrom: row.effective_from?.toISOString?.() || null,
    effectiveTo: row.effective_to?.toISOString?.() || null,
    history: history.map((item) => ({
      version: String(Number(item.version).toFixed(1)),
      status: item.status,
      date: item.changed_on?.toISOString?.() || new Date().toISOString(),
      user: item.changed_by || "System User",
      reason: item.reason || ""
    }))
  };

  if (row.entity_type === skillsMasterDataService.SKILLS_ENTITY) {
    record.skillCategoryCode = row.skill_category_code || null;
    record.skillCategory = row.skill_category_name
      || skillCategoryMap?.get(row.skill_category_code)
      || row.skill_category_code
      || "";
  }

  return record;
}

async function fetchHistory(pool, recordId) {
  const result = await pool.query(
    `SELECT version, status, changed_by, reason, changed_on
     FROM md_record_history
     WHERE record_id = $1
     ORDER BY changed_on ASC`,
    [recordId]
  );
  return result.rows;
}

async function writeAudit(pool, payload) {
  const auditId = buildAuditId();

  await pool.query(
    `INSERT INTO md_enterprise_audit (
      audit_id, event_type, module, entity, entity_id,
      action, previous_value, new_value, user_name, user_role,
      correlation_id, metadata
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      auditId,
      payload.eventType,
      payload.module,
      payload.entity,
      payload.entityId,
      payload.action,
      payload.previousValue ?? null,
      payload.newValue ?? null,
      payload.userName,
      payload.userRole,
      payload.correlationId || null,
      JSON.stringify(payload.metadata || {})
    ]
  );

  return auditId;
}

async function appendHistory(pool, {
  recordId,
  entityType,
  version,
  status,
  changedBy,
  reason
}) {
  await pool.query(
    `INSERT INTO md_record_history
      (record_id, entity_type, version, status, changed_by, reason)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [recordId, entityType, version, status, changedBy, reason || null]
  );
}

async function getRecordById(pool, entityType, id) {
  const result = await pool.query(
    `SELECT * FROM md_records
     WHERE entity_type = $1 AND id = $2 AND is_deleted = FALSE`,
    [entityType, id]
  );

  if (!result.rows.length) {
    return null;
  }

  const history = await fetchHistory(pool, id);
  return rowToRecord(result.rows[0], history);
}

async function validateUniqueCode(pool, entityType, code, excludeId = null) {
  const params = [entityType, code.toLowerCase()];
  let sql = `
    SELECT id FROM md_records
    WHERE entity_type = $1 AND LOWER(code) = $2 AND is_deleted = FALSE
  `;

  if (excludeId) {
    params.push(excludeId);
    sql += ` AND id <> $3`;
  }

  const result = await pool.query(sql, params);
  return result.rows.length === 0;
}

async function validateUniqueName(pool, entityType, name, excludeId = null) {
  const params = [entityType, name.toLowerCase()];
  let sql = `
    SELECT id FROM md_records
    WHERE entity_type = $1 AND LOWER(name) = $2 AND is_deleted = FALSE
  `;

  if (excludeId) {
    params.push(excludeId);
    sql += ` AND id <> $3`;
  }

  const result = await pool.query(sql, params);
  return result.rows.length === 0;
}

function validateEffectiveDates(effectiveFrom, effectiveTo) {
  if (effectiveFrom && effectiveTo) {
    return new Date(effectiveFrom) <= new Date(effectiveTo);
  }
  return true;
}

function validateStatusTransition(currentStatus, nextStatus) {
  const allowed = {
    Draft: ["Draft", "Published"],
    Published: ["Published", "Archived"],
    Archived: ["Archived", "Published"]
  };

  return (allowed[currentStatus] || []).includes(nextStatus);
}

async function buildMasterDataBundle(pool) {
  const recordsResult = await pool.query(
    `SELECT r.*, cat.name AS skill_category_name
     FROM md_records r
     LEFT JOIN md_records cat
       ON r.entity_type = 'skills'
       AND cat.entity_type = 'skill_categories'
       AND cat.code = r.skill_category_code
       AND cat.is_deleted = FALSE
     WHERE r.is_deleted = FALSE
     ORDER BY r.entity_type, r.name`
  );

  const records = {};

  ENTITY_TYPE_KEYS.forEach((key) => {
    records[key] = [];
  });

  const skillCategoryMap = await skillsMasterDataService.getCategoryMap(pool);

  for (const row of recordsResult.rows) {
    const history = await fetchHistory(pool, row.id);
    if (!records[row.entity_type]) {
      records[row.entity_type] = [];
    }
    records[row.entity_type].push(
      skillsMasterDataService.enrichSkillRecord(
        rowToRecord(row, history, skillCategoryMap),
        skillCategoryMap
      )
    );
  }

  const totalRecords = recordsResult.rows.length;
  const publishedRecords = recordsResult.rows.filter(
    (row) => row.version_status === "Published"
  ).length;

  const lastPublishedResult = await pool.query(
    `SELECT MAX(modified_on) AS last_published FROM md_records
     WHERE version_status = 'Published' AND is_deleted = FALSE`
  );

  return {
    meta: {
      org_name: "IGS Engineering Quality",
      last_published:
        lastPublishedResult.rows[0]?.last_published?.toISOString?.()
        || new Date().toISOString(),
      environment: process.env.NODE_ENV === "production" ? "Production" : "Development",
      total_records: totalRecords,
      published_records: publishedRecords,
      entity_type_count: ENTITY_TYPE_KEYS.length
    },
    domains: MASTER_DATA_DOMAINS,
    records
  };
}

async function listByEntityType(pool, entityType) {
  const result = await pool.query(
    `SELECT * FROM md_records
     WHERE entity_type = $1 AND is_deleted = FALSE
     ORDER BY name`,
    [entityType]
  );

  const items = [];

  for (const row of result.rows) {
    const history = await fetchHistory(pool, row.id);
    items.push(rowToRecord(row, history));
  }

  return items;
}

async function createRecord(pool, entityType, body, req) {
  const user = userContext(req);
  const code = (body.code || "").trim();
  const name = (body.name || "").trim();

  if (!code || !name) {
    const error = new Error("Code and name are required");
    error.status = 400;
    throw error;
  }

  if (!(await validateUniqueCode(pool, entityType, code))) {
    const error = new Error(`Duplicate code '${code}' for ${entityType}`);
    error.status = 409;
    throw error;
  }

  if (!(await validateUniqueName(pool, entityType, name))) {
    const error = new Error(`Duplicate name '${name}' for ${entityType}`);
    error.status = 409;
    throw error;
  }

  if (!validateEffectiveDates(body.effectiveFrom, body.effectiveTo)) {
    const error = new Error("effective_from must be before effective_to");
    error.status = 400;
    throw error;
  }

  const id = body.id || buildRecordId(entityType, code);
  const version = 0.1;
  const versionStatus = body.versionStatus || "Draft";
  const usedBy = body.usedBy?.length
    ? body.usedBy
    : DEFAULT_USED_BY[entityType] || [];

  const reason = body.reason || "Record created";

  await pool.query(
    `INSERT INTO md_records (
      id, entity_type, code, name, description, status, version, version_status,
      used_by, effective_from, effective_to, created_by, modified_by
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)`,
    [
      id,
      entityType,
      code,
      name,
      body.description || "",
      body.status || "Active",
      version,
      versionStatus,
      JSON.stringify(usedBy),
      body.effectiveFrom || null,
      body.effectiveTo || null,
      user.name
    ]
  );

  await appendHistory(pool, {
    recordId: id,
    entityType,
    version,
    status: versionStatus,
    changedBy: user.name,
    reason
  });

  await writeAudit(pool, {
    eventType: "MasterDataCreated",
    module: "Enterprise Master Data",
    entity: entityType,
    entityId: id,
    action: `${name} created`,
    newValue: name,
    userName: user.name,
    userRole: user.role,
    metadata: { reason, code }
  });

  return getRecordById(pool, entityType, id);
}

async function updateRecord(pool, entityType, id, body, req) {
  const user = userContext(req);
  const existing = await pool.query(
    `SELECT * FROM md_records WHERE entity_type = $1 AND id = $2 AND is_deleted = FALSE`,
    [entityType, id]
  );

  if (!existing.rows.length) {
    const error = new Error("Record not found");
    error.status = 404;
    throw error;
  }

  const current = existing.rows[0];

  if (current.version_status === "Archived" && body.versionStatus !== "Published") {
    const error = new Error("Archived records must be rolled back or republished via workflow");
    error.status = 422;
    throw error;
  }

  const code = (body.code || current.code).trim();
  const name = (body.name || current.name).trim();

  if (!(await validateUniqueCode(pool, entityType, code, id))) {
    const error = new Error(`Duplicate code '${code}' for ${entityType}`);
    error.status = 409;
    throw error;
  }

  if (!(await validateUniqueName(pool, entityType, name, id))) {
    const error = new Error(`Duplicate name '${name}' for ${entityType}`);
    error.status = 409;
    throw error;
  }

  const effectiveFrom = body.effectiveFrom ?? current.effective_from;
  const effectiveTo = body.effectiveTo ?? current.effective_to;

  if (!validateEffectiveDates(effectiveFrom, effectiveTo)) {
    const error = new Error("effective_from must be before effective_to");
    error.status = 400;
    throw error;
  }

  const reason = body.reason || "Record updated";
  const version = Number(current.version);
  const versionStatus = body.versionStatus || current.version_status;

  await pool.query(
    `UPDATE md_records SET
      code = $1,
      name = $2,
      description = $3,
      status = $4,
      version = $5,
      version_status = $6,
      used_by = $7,
      effective_from = $8,
      effective_to = $9,
      modified_by = $10,
      modified_on = NOW()
     WHERE id = $11`,
    [
      code,
      name,
      body.description ?? current.description ?? "",
      body.status || current.status,
      version,
      versionStatus,
      JSON.stringify(body.usedBy || current.used_by || []),
      effectiveFrom,
      effectiveTo,
      user.name,
      id
    ]
  );

  await appendHistory(pool, {
    recordId: id,
    entityType,
    version,
    status: versionStatus,
    changedBy: user.name,
    reason
  });

  await writeAudit(pool, {
    eventType: "MasterDataUpdated",
    module: "Enterprise Master Data",
    entity: entityType,
    entityId: id,
    action: `${name} updated`,
    previousValue: current.name,
    newValue: name,
    userName: user.name,
    userRole: user.role,
    metadata: { reason, code }
  });

  return getRecordById(pool, entityType, id);
}

async function publishRecord(pool, entityType, id, body, req) {
  const user = userContext(req);
  const existing = await pool.query(
    `SELECT * FROM md_records WHERE entity_type = $1 AND id = $2 AND is_deleted = FALSE`,
    [entityType, id]
  );

  if (!existing.rows.length) {
    const error = new Error("Record not found");
    error.status = 404;
    throw error;
  }

  const current = existing.rows[0];

  if (!validateStatusTransition(current.version_status, "Published")) {
    const error = new Error(`Cannot publish record in ${current.version_status} state`);
    error.status = 422;
    throw error;
  }

  const nextVersion = Number((Number(current.version) + 0.1).toFixed(1));
  const reason = body.reason || "Published to production";

  await pool.query(
    `UPDATE md_records SET
      version = $1,
      version_status = 'Published',
      modified_by = $2,
      modified_on = NOW()
     WHERE id = $3`,
    [nextVersion, user.name, id]
  );

  await appendHistory(pool, {
    recordId: id,
    entityType,
    version: nextVersion,
    status: "Published",
    changedBy: user.name,
    reason
  });

  await writeAudit(pool, {
    eventType: "MasterDataPublished",
    module: "Enterprise Master Data",
    entity: entityType,
    entityId: id,
    action: `${current.name} published`,
    previousValue: current.version_status,
    newValue: "Published",
    userName: user.name,
    userRole: user.role,
    metadata: { reason, version: String(nextVersion) }
  });

  return getRecordById(pool, entityType, id);
}

async function archiveRecord(pool, entityType, id, body, req) {
  const user = userContext(req);
  const existing = await pool.query(
    `SELECT * FROM md_records WHERE entity_type = $1 AND id = $2 AND is_deleted = FALSE`,
    [entityType, id]
  );

  if (!existing.rows.length) {
    const error = new Error("Record not found");
    error.status = 404;
    throw error;
  }

  const current = existing.rows[0];
  const reason = body.reason || "Record archived";

  await pool.query(
    `UPDATE md_records SET
      status = 'Inactive',
      version_status = 'Archived',
      modified_by = $1,
      modified_on = NOW()
     WHERE id = $2`,
    [user.name, id]
  );

  await appendHistory(pool, {
    recordId: id,
    entityType,
    version: Number(current.version),
    status: "Archived",
    changedBy: user.name,
    reason
  });

  await writeAudit(pool, {
    eventType: "MasterDataArchived",
    module: "Enterprise Master Data",
    entity: entityType,
    entityId: id,
    action: "Record archived",
    userName: user.name,
    userRole: user.role,
    metadata: { reason }
  });

  return getRecordById(pool, entityType, id);
}

async function rollbackRecord(pool, entityType, id, body, req) {
  const user = userContext(req);
  const targetVersion = Number(body.targetVersion);

  if (!targetVersion) {
    const error = new Error("targetVersion is required");
    error.status = 400;
    throw error;
  }

  const historyResult = await pool.query(
    `SELECT * FROM md_record_history
     WHERE record_id = $1 AND version = $2 AND status = 'Published'
     ORDER BY changed_on DESC LIMIT 1`,
    [id, targetVersion]
  );

  if (!historyResult.rows.length) {
    const error = new Error(`Published version ${targetVersion} not found in history`);
    error.status = 404;
    throw error;
  }

  const existing = await pool.query(
    `SELECT * FROM md_records WHERE entity_type = $1 AND id = $2 AND is_deleted = FALSE`,
    [entityType, id]
  );

  if (!existing.rows.length) {
    const error = new Error("Record not found");
    error.status = 404;
    throw error;
  }

  const current = existing.rows[0];
  const reason = body.reason || `Rolled back to v${targetVersion}`;

  await pool.query(
    `UPDATE md_records SET
      version = $1,
      version_status = 'Published',
      status = 'Active',
      modified_by = $2,
      modified_on = NOW()
     WHERE id = $3`,
    [targetVersion, user.name, id]
  );

  await appendHistory(pool, {
    recordId: id,
    entityType,
    version: targetVersion,
    status: "Published",
    changedBy: user.name,
    reason
  });

  await writeAudit(pool, {
    eventType: "MasterDataRollback",
    module: "Enterprise Master Data",
    entity: entityType,
    entityId: id,
    action: `Rollback to v${targetVersion}`,
    previousValue: String(Number(current.version).toFixed(1)),
    newValue: String(targetVersion),
    userName: user.name,
    userRole: user.role,
    metadata: { reason }
  });

  return getRecordById(pool, entityType, id);
}

async function deleteRecord(pool, entityType, id, req) {
  const user = userContext(req);

  const result = await pool.query(
    `UPDATE md_records SET is_deleted = TRUE, modified_by = $1, modified_on = NOW()
     WHERE entity_type = $2 AND id = $3 AND is_deleted = FALSE
     RETURNING id`,
    [user.name, entityType, id]
  );

  if (!result.rows.length) {
    const error = new Error("Record not found");
    error.status = 404;
    throw error;
  }

  await writeAudit(pool, {
    eventType: "MasterDataArchived",
    module: "Enterprise Master Data",
    entity: entityType,
    entityId: id,
    action: "Record deleted",
    userName: user.name,
    userRole: user.role,
    metadata: {}
  });

  return { id, deleted: true };
}

async function previewImport(pool, entityType, rows) {
  const existing = await pool.query(
    `SELECT LOWER(code) AS code FROM md_records
     WHERE entity_type = $1 AND is_deleted = FALSE`,
    [entityType]
  );

  const existingCodes = new Set(existing.rows.map((row) => row.code));

  return rows.map((row, index) => ({
    row: index + 1,
    code: row.code,
    name: row.name,
    description: row.description || "",
    status: existingCodes.has(String(row.code || "").toLowerCase()) ? "Duplicate" : "Valid"
  }));
}

async function commitImport(pool, entityType, rows, req, reason = "") {
  const user = userContext(req);
  const preview = await previewImport(pool, entityType, rows);
  const validRows = rows.filter((_, index) => preview[index]?.status === "Valid");

  const created = [];

  for (const row of validRows) {
    const record = await createRecord(pool, entityType, {
      code: row.code,
      name: row.name,
      description: row.description,
      versionStatus: "Draft",
      reason: reason || "Imported from file"
    }, req);
    created.push(record);
  }

  if (created.length) {
    await writeAudit(pool, {
      eventType: "MasterDataImported",
      module: "Enterprise Master Data",
      entity: entityType,
      entityId: entityType,
      action: `${created.length} records imported`,
      newValue: created.map((item) => item.code).join(", "),
      userName: user.name,
      userRole: user.role,
      metadata: { reason, count: created.length }
    });
  }

  return { imported: created.length, records: created, preview };
}

async function exportEntity(pool, entityType) {
  return listByEntityType(pool, entityType);
}

function resolveEntityType(param) {
  const entityType = kebabToSnake(param);

  if (!isValidEntityType(entityType)) {
    const error = new Error(`Unknown master data entity type: ${param}`);
    error.status = 400;
    throw error;
  }

  return entityType;
}

module.exports = {
  buildMasterDataBundle,
  listByEntityType,
  getRecordById,
  createRecord,
  updateRecord,
  publishRecord,
  archiveRecord,
  rollbackRecord,
  deleteRecord,
  previewImport,
  commitImport,
  exportEntity,
  resolveEntityType
};
