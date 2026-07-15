const crypto = require("crypto");

const { DEFAULT_USED_BY } = require("../masterData/entityTypes");

const SKILLS_ENTITY = "skills";
const SKILL_CATEGORIES_ENTITY = "skill_categories";

function buildRecordId(code) {
  const slug = code.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return `md-${SKILLS_ENTITY}-${slug}`;
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

function mapSkillRow(row, history = [], categoryMap = null) {
  const skillCategoryCode = row.skill_category_code || null;
  const skillCategory = row.skill_category_name
    || categoryMap?.get(skillCategoryCode)
    || skillCategoryCode
    || "";

  return {
    id: row.id,
    entityType: row.entity_type,
    code: row.code,
    name: row.name,
    description: row.description || "",
    skillCategoryCode,
    skillCategory,
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
  version,
  status,
  changedBy,
  reason
}) {
  await pool.query(
    `INSERT INTO md_record_history
      (record_id, entity_type, version, status, changed_by, reason)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [recordId, SKILLS_ENTITY, version, status, changedBy, reason || null]
  );
}

async function getCategoryMap(pool) {
  const result = await pool.query(
    `SELECT code, name FROM md_records
     WHERE entity_type = $1 AND is_deleted = FALSE`,
    [SKILL_CATEGORIES_ENTITY]
  );

  return new Map(result.rows.map((row) => [row.code, row.name]));
}

async function resolveSkillCategoryCode(pool, input) {
  const value = String(input || "").trim();

  if (!value) {
    return null;
  }

  const result = await pool.query(
    `SELECT code, name FROM md_records
     WHERE entity_type = $1 AND is_deleted = FALSE
       AND (LOWER(code) = LOWER($2) OR LOWER(name) = LOWER($2))`,
    [SKILL_CATEGORIES_ENTITY, value]
  );

  return result.rows[0]?.code || null;
}

async function validateSkillCategory(pool, input) {
  const code = await resolveSkillCategoryCode(pool, input);

  if (!code) {
    const error = new Error(
      `Skill Category "${input}" not found in Master Data (skill_categories).`
    );
    error.status = 400;
    throw error;
  }

  return code;
}

async function validateUniqueCode(pool, code, excludeId = null) {
  const params = [SKILLS_ENTITY, code.toLowerCase()];
  let sql = `
    SELECT id FROM md_records
    WHERE entity_type = $1 AND LOWER(code) = $2 AND is_deleted = FALSE
  `;

  if (excludeId) {
    params.push(excludeId);
    sql += " AND id <> $3";
  }

  const result = await pool.query(sql, params);
  return result.rows.length === 0;
}

async function validateUniqueName(pool, name, excludeId = null) {
  const params = [SKILLS_ENTITY, name.toLowerCase()];
  let sql = `
    SELECT id FROM md_records
    WHERE entity_type = $1 AND LOWER(name) = $2 AND is_deleted = FALSE
  `;

  if (excludeId) {
    params.push(excludeId);
    sql += " AND id <> $3";
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

async function getSkillById(pool, id) {
  const categoryMap = await getCategoryMap(pool);
  const result = await pool.query(
    `SELECT r.*, cat.name AS skill_category_name
     FROM md_records r
     LEFT JOIN md_records cat
       ON cat.entity_type = $2
       AND cat.code = r.skill_category_code
       AND cat.is_deleted = FALSE
     WHERE r.entity_type = $1 AND r.id = $3 AND r.is_deleted = FALSE`,
    [SKILLS_ENTITY, SKILL_CATEGORIES_ENTITY, id]
  );

  if (!result.rows.length) {
    return null;
  }

  const history = await fetchHistory(pool, id);
  return mapSkillRow(result.rows[0], history, categoryMap);
}

async function listSkills(pool) {
  const categoryMap = await getCategoryMap(pool);
  const result = await pool.query(
    `SELECT r.*, cat.name AS skill_category_name
     FROM md_records r
     LEFT JOIN md_records cat
       ON cat.entity_type = $2
       AND cat.code = r.skill_category_code
       AND cat.is_deleted = FALSE
     WHERE r.entity_type = $1 AND r.is_deleted = FALSE
     ORDER BY r.name`,
    [SKILLS_ENTITY, SKILL_CATEGORIES_ENTITY]
  );

  const items = [];

  for (const row of result.rows) {
    const history = await fetchHistory(pool, row.id);
    items.push(mapSkillRow(row, history, categoryMap));
  }

  return items;
}

async function createSkill(pool, body, req) {
  const user = userContext(req);
  const code = (body.code || "").trim();
  const name = (body.name || "").trim();
  const skillCategoryInput = body.skillCategoryCode || body.skillCategory || body.skill_category;

  if (!code || !name) {
    const error = new Error("Code and name are required");
    error.status = 400;
    throw error;
  }

  if (!skillCategoryInput) {
    const error = new Error("Skill Category is required");
    error.status = 400;
    throw error;
  }

  const skillCategoryCode = await validateSkillCategory(pool, skillCategoryInput);

  if (!(await validateUniqueCode(pool, code))) {
    const error = new Error(`Duplicate code '${code}' for skills`);
    error.status = 409;
    throw error;
  }

  if (!(await validateUniqueName(pool, name))) {
    const error = new Error(`Duplicate name '${name}' for skills`);
    error.status = 409;
    throw error;
  }

  if (!validateEffectiveDates(body.effectiveFrom, body.effectiveTo)) {
    const error = new Error("effective_from must be before effective_to");
    error.status = 400;
    throw error;
  }

  const id = body.id || buildRecordId(code);
  const version = 0.1;
  const versionStatus = body.versionStatus || "Draft";
  const usedBy = body.usedBy?.length ? body.usedBy : DEFAULT_USED_BY.skills || [];
  const reason = body.reason || "Record created";

  await pool.query(
    `INSERT INTO md_records (
      id, entity_type, code, name, description, skill_category_code,
      status, version, version_status, used_by, effective_from, effective_to,
      created_by, modified_by
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)`,
    [
      id,
      SKILLS_ENTITY,
      code,
      name,
      body.description || "",
      skillCategoryCode,
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
    version,
    status: versionStatus,
    changedBy: user.name,
    reason
  });

  await writeAudit(pool, {
    eventType: "MasterDataCreated",
    module: "Enterprise Master Data",
    entity: SKILLS_ENTITY,
    entityId: id,
    action: `${name} created`,
    newValue: name,
    userName: user.name,
    userRole: user.role,
    metadata: { reason, code, skillCategoryCode }
  });

  return getSkillById(pool, id);
}

async function updateSkill(pool, id, body, req) {
  const user = userContext(req);
  const existing = await pool.query(
    `SELECT * FROM md_records
     WHERE entity_type = $1 AND id = $2 AND is_deleted = FALSE`,
    [SKILLS_ENTITY, id]
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
  const skillCategoryInput = body.skillCategoryCode
    ?? body.skillCategory
    ?? body.skill_category
    ?? current.skill_category_code;

  if (!skillCategoryInput) {
    const error = new Error("Skill Category is required");
    error.status = 400;
    throw error;
  }

  const skillCategoryCode = await validateSkillCategory(pool, skillCategoryInput);

  if (!(await validateUniqueCode(pool, code, id))) {
    const error = new Error(`Duplicate code '${code}' for skills`);
    error.status = 409;
    throw error;
  }

  if (!(await validateUniqueName(pool, name, id))) {
    const error = new Error(`Duplicate name '${name}' for skills`);
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
      skill_category_code = $4,
      status = $5,
      version = $6,
      version_status = $7,
      used_by = $8,
      effective_from = $9,
      effective_to = $10,
      modified_by = $11,
      modified_on = NOW()
     WHERE id = $12`,
    [
      code,
      name,
      body.description ?? current.description ?? "",
      skillCategoryCode,
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
    version,
    status: versionStatus,
    changedBy: user.name,
    reason
  });

  await writeAudit(pool, {
    eventType: "MasterDataUpdated",
    module: "Enterprise Master Data",
    entity: SKILLS_ENTITY,
    entityId: id,
    action: `${name} updated`,
    previousValue: current.name,
    newValue: name,
    userName: user.name,
    userRole: user.role,
    metadata: { reason, code, skillCategoryCode }
  });

  return getSkillById(pool, id);
}

async function previewSkillsImport(pool, rows) {
  const existing = await pool.query(
    `SELECT LOWER(code) AS code, LOWER(name) AS name
     FROM md_records
     WHERE entity_type = $1 AND is_deleted = FALSE`,
    [SKILLS_ENTITY]
  );

  const existingCodes = new Set(existing.rows.map((row) => row.code));
  const existingNames = new Set(existing.rows.map((row) => row.name));
  const batchCodes = new Set();
  const batchNames = new Set();

  const preview = [];

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const code = String(row.code || "").trim();
    const name = String(row.name || "").trim();
    const skillCategory = String(
      row.skillCategoryCode || row.skillCategory || row.skill_category || ""
    ).trim();
    const normalizedCode = code.toLowerCase();
    const normalizedName = name.toLowerCase();
    const issues = [];

    if (!code) {
      issues.push("Code is required");
    }

    if (!skillCategory) {
      issues.push("Skill Category is required");
    } else {
      const categoryCode = await resolveSkillCategoryCode(pool, skillCategory);
      if (!categoryCode) {
        issues.push(`Skill Category "${skillCategory}" not found`);
      }
    }

    if (!name) {
      issues.push("Name is required");
    }

    if (code && existingCodes.has(normalizedCode)) {
      issues.push("Duplicate code in master data");
    }

    if (name && existingNames.has(normalizedName)) {
      issues.push("Duplicate name in master data");
    }

    if (code && batchCodes.has(normalizedCode)) {
      issues.push("Duplicate code in upload file");
    }

    if (name && batchNames.has(normalizedName)) {
      issues.push("Duplicate name in upload file");
    }

    if (code) {
      batchCodes.add(normalizedCode);
    }

    if (name) {
      batchNames.add(normalizedName);
    }

    preview.push({
      row: index + 1,
      code,
      skillCategory,
      name,
      description: row.description || "",
      status: issues.length ? issues.join("; ") : "Valid"
    });
  }

  return preview;
}

async function commitSkillsImport(pool, rows, req, reason = "") {
  const user = userContext(req);
  const preview = await previewSkillsImport(pool, rows);
  const validRows = rows.filter((_, index) => preview[index]?.status === "Valid");
  const created = [];

  for (const row of validRows) {
    const record = await createSkill(pool, {
      code: row.code,
      name: row.name,
      description: row.description,
      skillCategoryCode: row.skillCategoryCode || row.skillCategory || row.skill_category,
      versionStatus: "Draft",
      reason: reason || "Imported from file"
    }, req);
    created.push(record);
  }

  if (created.length) {
    await writeAudit(pool, {
      eventType: "MasterDataImported",
      module: "Enterprise Master Data",
      entity: SKILLS_ENTITY,
      entityId: SKILLS_ENTITY,
      action: `${created.length} skills imported`,
      newValue: created.map((item) => item.code).join(", "),
      userName: user.name,
      userRole: user.role,
      metadata: { reason, count: created.length }
    });
  }

  return { imported: created.length, records: created, preview };
}

async function exportSkills(pool) {
  return listSkills(pool);
}

function enrichSkillRecord(record, categoryMap) {
  if (!record || record.entityType !== SKILLS_ENTITY) {
    return record;
  }

  const skillCategoryCode = record.skillCategoryCode || null;

  return {
    ...record,
    skillCategoryCode,
    skillCategory: record.skillCategory
      || categoryMap?.get(skillCategoryCode)
      || skillCategoryCode
      || ""
  };
}

module.exports = {
  SKILLS_ENTITY,
  getCategoryMap,
  mapSkillRow,
  enrichSkillRecord,
  listSkills,
  getSkillById,
  createSkill,
  updateSkill,
  previewSkillsImport,
  commitSkillsImport,
  exportSkills,
  resolveSkillCategoryCode,
  validateSkillCategory
};
