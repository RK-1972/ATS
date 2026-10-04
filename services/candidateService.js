/**
 * Enterprise Candidate Domain service.
 * Extends legacy cand_mstr without replacing existing CRUD in index.js.
 */

const MASTER_TABLE = "cand_mstr";

const LEGACY_MASTER_COLUMNS = [
  "candidate_id",
  "candidate_code",
  "first_name",
  "last_name",
  "email_id",
  "pan_number",
  "mobile_number",
  "total_experience",
  "relevant_experience",
  "current_company",
  "current_ctc",
  "expected_ctc",
  "notice_period",
  "current_location",
  "preferred_location",
  "primary_skill",
  "secondary_skill",
  "linkedin_url",
  "resume_path",
  "source_channel",
  "candidate_status",
  "recruiter_id",
  "remarks",
  "created_by",
  "created_on",
  "updated_on"
];

const ENTERPRISE_MASTER_COLUMNS = [
  "salutation",
  "middle_name",
  "preferred_name",
  "gender",
  "date_of_birth",
  "nationality",
  "marital_status",
  "alternate_email",
  "alternate_mobile",
  "current_designation",
  "current_department",
  "current_country",
  "current_state",
  "current_city",
  "total_experience_years",
  "total_experience_months",
  "relevant_experience_years",
  "relevant_experience_months",
  "currency_code",
  "willing_to_relocate",
  "preferred_work_mode",
  "candidate_source_code",
  "vendor_partner_code",
  "referral_program_code",
  "resume_document_id",
  "resume_uploaded_on",
  "profile_completion",
  "modified_by",
  "active_flag"
];

const EMD_LOOKUP_FIELDS = {
  country_code: "countries",
  state_code: "states",
  city_code: "cities",
  current_country: "countries",
  current_state: "states",
  current_city: "cities",
  current_department: "departments",
  current_designation: "designations",
  currency_code: "currencies",
  preferred_employment_type: "employment_types",
  candidate_source_code: "candidate_sources",
  vendor_partner_code: "vendor_partners",
  referral_program_code: "referral_programs",
  skill_code: "skills",
  document_type: "document_types",
  interview_stage_code: "interview_stages"
};

const CHILD_TABLES = {
  address: {
    table: "can_address",
    idColumn: "address_id",
    candidateColumn: "candidate_id"
  },
  education: {
    table: "can_education",
    idColumn: "education_id",
    candidateColumn: "candidate_id"
  },
  experience: {
    table: "can_experience",
    idColumn: "experience_id",
    candidateColumn: "candidate_id"
  },
  skill_map: {
    table: "can_skill_map",
    idColumn: "skill_map_id",
    candidateColumn: "candidate_id"
  },
  certification: {
    table: "can_certification",
    idColumn: "certification_id",
    candidateColumn: "candidate_id"
  },
  language: {
    table: "can_language",
    idColumn: "language_id",
    candidateColumn: "candidate_id"
  },
  document: {
    table: "can_document",
    idColumn: "document_id",
    candidateColumn: "candidate_id"
  },
  social_profile: {
    table: "can_social_profile",
    idColumn: "social_profile_id",
    candidateColumn: "candidate_id"
  },
  preference: {
    table: "can_preference",
    idColumn: "preference_id",
    candidateColumn: "candidate_id"
  },
  notes: {
    table: "can_notes",
    idColumn: "note_id",
    candidateColumn: "candidate_id"
  },
  activity: {
    table: "can_activity",
    idColumn: "activity_id",
    candidateColumn: "candidate_id"
  }
};

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function masterDataCodeExists(pool, entityType, code) {
  if (!code) {
    return true;
  }

  const result = await pool.query(
    `SELECT 1
     FROM md_records
     WHERE entity_type = $1
       AND LOWER(code) = LOWER($2)
       AND is_deleted = FALSE
       AND status = 'Active'
     LIMIT 1`,
    [entityType, String(code).trim()]
  );

  return result.rowCount > 0;
}

async function validateMasterDataCode(pool, entityType, code, fieldLabel = entityType) {
  if (!code) {
    return true;
  }

  const exists = await masterDataCodeExists(pool, entityType, code);

  if (!exists) {
    throw httpError(`Invalid ${fieldLabel}: '${code}' not found in Enterprise Master Data (${entityType})`);
  }

  return true;
}

async function validateCandidateMasterLookups(pool, payload = {}) {
  const checks = [];

  for (const [field, entityType] of Object.entries(EMD_LOOKUP_FIELDS)) {
    if (payload[field]) {
      checks.push(validateMasterDataCode(pool, entityType, payload[field], field));
    }
  }

  await Promise.all(checks);
  return true;
}

async function validateSkillCode(pool, skillCode) {
  return validateMasterDataCode(pool, "skills", skillCode, "skill_code");
}

async function validateDocumentType(pool, documentType) {
  return validateMasterDataCode(pool, "document_types", documentType, "document_type");
}

async function getCandidateMaster(pool, candidateId) {
  const result = await pool.query(
    `SELECT * FROM ${MASTER_TABLE} WHERE candidate_id = $1`,
    [candidateId]
  );

  return result.rows[0] || null;
}

async function listCandidateMasters(pool, { activeOnly = false } = {}) {
  const sql = activeOnly
    ? `SELECT * FROM ${MASTER_TABLE} WHERE active_flag IS DISTINCT FROM FALSE ORDER BY candidate_id DESC`
    : `SELECT * FROM ${MASTER_TABLE} ORDER BY candidate_id DESC`;

  const result = await pool.query(sql);
  return result.rows;
}

async function listChildRecords(pool, childKey, candidateId) {
  const config = CHILD_TABLES[childKey];

  if (!config) {
    throw httpError(`Unknown candidate child table key: ${childKey}`);
  }

  const result = await pool.query(
    `SELECT *
     FROM ${config.table}
     WHERE ${config.candidateColumn} = $1
     ORDER BY 1 DESC`,
    [candidateId]
  );

  return result.rows;
}

async function getCandidateProfile(pool, candidateId) {
  const master = await getCandidateMaster(pool, candidateId);

  if (!master) {
    return null;
  }

  const children = {};

  for (const key of Object.keys(CHILD_TABLES)) {
    children[key] = await listChildRecords(pool, key, candidateId);
  }

  return { master, children };
}

async function insertChildRecord(pool, childKey, candidateId, payload) {
  const config = CHILD_TABLES[childKey];

  if (!config) {
    throw httpError(`Unknown candidate child table key: ${childKey}`);
  }

  const master = await getCandidateMaster(pool, candidateId);

  if (!master) {
    throw httpError("Candidate not found", 404);
  }

  if (childKey === "skill_map" && payload.skill_code) {
    await validateSkillCode(pool, payload.skill_code);
  }

  if (childKey === "document" && payload.document_type) {
    await validateDocumentType(pool, payload.document_type);
  }

  if (childKey === "address") {
    await Promise.all([
      payload.country_code
        ? validateMasterDataCode(pool, "countries", payload.country_code, "country_code")
        : Promise.resolve(),
      payload.state_code
        ? validateMasterDataCode(pool, "states", payload.state_code, "state_code")
        : Promise.resolve(),
      payload.city_code
        ? validateMasterDataCode(pool, "cities", payload.city_code, "city_code")
        : Promise.resolve()
    ]);
  }

  const columns = Object.keys(payload).filter((key) => payload[key] !== undefined);

  if (!columns.length) {
    throw httpError("No child record fields supplied");
  }

  const values = [candidateId, ...columns.map((column) => payload[column])];
  const placeholders = values.map((_, index) => `$${index + 1}`).join(", ");

  const result = await pool.query(
    `INSERT INTO ${config.table} (${config.candidateColumn}, ${columns.join(", ")})
     VALUES (${placeholders})
     RETURNING *`,
    values
  );

  return result.rows[0];
}

const SKILL_MAP_COLUMNS = [
  "skill_code",
  "experience_years",
  "experience_months",
  "proficiency",
  "last_used"
];

function parseSkillMapExperienceYears(value) {
  if (value === "" || value === null || value === undefined) {
    return 0;
  }

  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0) {
      throw httpError(
        "experience_years must be a whole number greater than or equal to 0.",
        400
      );
    }

    return value;
  }

  const trimmed = String(value).trim();

  if (!/^\d+$/.test(trimmed)) {
    throw httpError(
      "experience_years must be a whole number greater than or equal to 0.",
      400
    );
  }

  return Number.parseInt(trimmed, 10);
}

function parseSkillMapExperienceMonths(value) {
  if (value === "" || value === null || value === undefined) {
    return 0;
  }

  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0 || value > 11) {
      throw httpError(
        "experience_months must be a whole number between 0 and 11.",
        400
      );
    }

    return value;
  }

  const trimmed = String(value).trim();

  if (!/^\d+$/.test(trimmed)) {
    throw httpError(
      "experience_months must be a whole number between 0 and 11.",
      400
    );
  }

  const parsed = Number.parseInt(trimmed, 10);

  if (parsed > 11) {
    throw httpError(
      "experience_months must be a whole number between 0 and 11.",
      400
    );
  }

  return parsed;
}

function pickSkillMapPayload(body = {}) {
  const source = { ...body };
  const payload = {};

  SKILL_MAP_COLUMNS.forEach((field) => {
    if (!Object.prototype.hasOwnProperty.call(source, field)) {
      return;
    }

    let value = source[field];

    if (field === "skill_code") {
      value = String(value || "").trim();
      if (value) {
        payload.skill_code = value;
      }
      return;
    }

    if (field === "experience_years") {
      payload.experience_years = parseSkillMapExperienceYears(value);
      return;
    }

    if (field === "experience_months") {
      payload.experience_months = parseSkillMapExperienceMonths(value);
      return;
    }

    if (field === "proficiency") {
      payload.proficiency = value ? String(value).trim() : null;
      return;
    }

    if (field === "last_used") {
      payload.last_used = value ? String(value).trim() : null;
    }
  });

  return payload;
}

function normalizeSkillTokenKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function splitSkillFieldTokens(...fields) {
  const tokens = [];
  const seen = new Set();

  fields.forEach((field) => {
    if (!field) {
      return;
    }

    String(field)
      .split(/[,;/|]+/)
      .map((token) => token.trim())
      .filter(Boolean)
      .forEach((token) => {
        const key = normalizeSkillTokenKey(token);

        if (seen.has(key)) {
          return;
        }

        seen.add(key);
        tokens.push(token);
      });
  });

  return tokens;
}

function tokenMatchesSkillLabels(token, labels = []) {
  const key = normalizeSkillTokenKey(token);

  return labels.some((label) => normalizeSkillTokenKey(label) === key);
}

function mergeSkillTokensWithMapLabels(tokens = [], activeMapDisplayNames = []) {
  const activeLabels = activeMapDisplayNames
    .map((name) => String(name || "").trim())
    .filter(Boolean);

  const final = [];
  const finalSeen = new Set();

  tokens.forEach((token) => {
    const key = normalizeSkillTokenKey(token);

    if (!key || finalSeen.has(key)) {
      return;
    }

    finalSeen.add(key);
    final.push(token);
  });

  activeLabels.forEach((label) => {
    const key = normalizeSkillTokenKey(label);

    if (!key || finalSeen.has(key)) {
      return;
    }

    finalSeen.add(key);
    final.push(label);
  });

  return final.join(", ");
}

function buildAdditivePrimarySkillString(
  primarySkill,
  secondarySkill,
  activeMapDisplayNames = [],
  options = {}
) {
  let tokens = splitSkillFieldTokens(primarySkill, secondarySkill);

  const {
    deletedSkillLabels = [],
    priorMapDisplayNames = []
  } = options;

  if (deletedSkillLabels.length > 0 && priorMapDisplayNames.length > 0) {
    const protectedKeys = new Set(
      tokens
        .filter((token) => !tokenMatchesSkillLabels(token, priorMapDisplayNames))
        .map((token) => normalizeSkillTokenKey(token))
    );

    tokens = tokens.filter((token) => {
      if (!tokenMatchesSkillLabels(token, deletedSkillLabels)) {
        return true;
      }

      return protectedKeys.has(normalizeSkillTokenKey(token));
    });
  }

  return mergeSkillTokensWithMapLabels(tokens, activeMapDisplayNames);
}

async function resolveSkillDisplayName(queryable, skillCode) {
  const result = await queryable.query(
    `SELECT name
     FROM md_records
     WHERE entity_type = 'skills'
       AND LOWER(code) = LOWER($1)
       AND is_deleted = FALSE
     LIMIT 1`,
    [skillCode]
  );

  return String(result.rows[0]?.name || skillCode || "").trim();
}

function collectCandidateSkillTokenKeys(primarySkill, secondarySkill) {
  return new Set(
    splitSkillFieldTokens(primarySkill, secondarySkill).map((token) =>
      normalizeSkillTokenKey(token)
    )
  );
}

async function assertSkillsNotAlreadyOnCandidate(queryable, master, skillCodes = []) {
  const existingKeys = collectCandidateSkillTokenKeys(
    master.primary_skill,
    master.secondary_skill
  );

  for (const skillCode of skillCodes) {
    const normalizedCode = normalizeSkillTokenKey(skillCode);

    if (existingKeys.has(normalizedCode)) {
      throw httpError(
        `Skill '${skillCode}' is already present on this candidate.`,
        409
      );
    }

    const displayName = await resolveSkillDisplayName(queryable, skillCode);

    if (displayName && existingKeys.has(normalizeSkillTokenKey(displayName))) {
      throw httpError(
        `Skill '${displayName}' is already present on this candidate.`,
        409
      );
    }
  }
}

async function resolveSkillMapDisplayNames(queryable, candidateId) {
  const result = await queryable.query(
    `SELECT sm.skill_code,
            COALESCE(mr.name, sm.skill_code) AS display_name
     FROM can_skill_map sm
     LEFT JOIN md_records mr
       ON mr.entity_type = 'skills'
      AND LOWER(mr.code) = LOWER(sm.skill_code)
      AND mr.is_deleted = FALSE
     WHERE sm.candidate_id = $1
       AND sm.active_flag IS NOT FALSE
     ORDER BY sm.skill_map_id ASC`,
    [candidateId]
  );

  return result.rows.map((row) => ({
    skill_code: row.skill_code,
    display_name: String(row.display_name || row.skill_code || "").trim()
  }));
}

async function syncPrimarySkillFromSkillMap(queryable, candidateId, options = {}) {
  const masterResult = await queryable.query(
    `SELECT primary_skill, secondary_skill
     FROM cand_mstr
     WHERE candidate_id = $1`,
    [candidateId]
  );

  const master = masterResult.rows[0];

  if (!master) {
    throw httpError("Candidate not found", 404);
  }

  const mapRows = await resolveSkillMapDisplayNames(queryable, candidateId);
  const activeMapDisplayNames = mapRows
    .map((row) => row.display_name)
    .filter(Boolean);

  const primarySkill = buildAdditivePrimarySkillString(
    master.primary_skill,
    master.secondary_skill,
    activeMapDisplayNames,
    options
  );

  await queryable.query(
    `UPDATE cand_mstr
     SET primary_skill = $1, updated_on = NOW()
     WHERE candidate_id = $2`,
    [primarySkill, candidateId]
  );

  return primarySkill;
}

async function insertSkillMapBatch(pool, candidateId, rawSkillRows = []) {
  if (!Array.isArray(rawSkillRows) || rawSkillRows.length === 0) {
    throw httpError("At least one skill is required.", 400);
  }

  const skillPayloads = rawSkillRows.map((row) => pickSkillMapPayload(row));

  for (const payload of skillPayloads) {
    if (!payload.skill_code) {
      throw httpError("skill_code is required for each skill.", 400);
    }
  }

  const normalizedCodes = skillPayloads.map((row) =>
    String(row.skill_code).toLowerCase()
  );

  if (new Set(normalizedCodes).size !== normalizedCodes.length) {
    throw httpError("Duplicate skill codes in request.", 400);
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const master = await getCandidateMaster(client, candidateId);

    if (!master) {
      throw httpError("Candidate not found", 404);
    }

    const existing = await client.query(
      `SELECT skill_code
       FROM can_skill_map
       WHERE candidate_id = $1
         AND active_flag IS NOT FALSE`,
      [candidateId]
    );

    const existingCodes = new Set(
      existing.rows.map((row) => String(row.skill_code).toLowerCase())
    );

    for (const payload of skillPayloads) {
      if (existingCodes.has(String(payload.skill_code).toLowerCase())) {
        throw httpError(
          `Skill '${payload.skill_code}' is already assigned to this candidate.`,
          409
        );
      }
    }

    await assertSkillsNotAlreadyOnCandidate(
      client,
      master,
      skillPayloads.map((row) => row.skill_code)
    );

    const inserted = [];

    for (const payload of skillPayloads) {
      const row = await insertChildRecord(client, "skill_map", candidateId, payload);
      inserted.push(row);
    }

    const primarySkill = await syncPrimarySkillFromSkillMap(client, candidateId);

    await client.query("COMMIT");

    return {
      skills: inserted,
      primary_skill: primarySkill
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (_rollbackError) {
      // ignore rollback failures
    }

    if (error.code === "23505") {
      throw httpError("Skill already assigned to this candidate.", 409);
    }

    throw error;
  } finally {
    client.release();
  }
}

async function updateSkillMapRecord(pool, candidateId, skillMapId, body = {}) {
  const payload = pickSkillMapPayload(body);

  if (!Object.keys(payload).length) {
    throw httpError("No skill fields supplied.", 400);
  }

  const client = await pool.connect();
  const config = CHILD_TABLES.skill_map;

  try {
    await client.query("BEGIN");

    const master = await getCandidateMaster(client, candidateId);

    if (!master) {
      throw httpError("Candidate not found", 404);
    }

    const records = await listChildRecords(client, "skill_map", candidateId);
    const existing = records.find(
      (row) => String(row.skill_map_id) === String(skillMapId)
    );

    if (!existing) {
      throw httpError("Skill record not found.", 404);
    }

    if (payload.skill_code) {
      await validateSkillCode(client, payload.skill_code);

      const duplicate = records.find(
        (row) =>
          String(row.skill_map_id) !== String(skillMapId) &&
          String(row.skill_code).toLowerCase() ===
            String(payload.skill_code).toLowerCase()
      );

      if (duplicate) {
        throw httpError(
          `Skill '${payload.skill_code}' is already assigned to this candidate.`,
          409
        );
      }
    }

    const columns = Object.keys(payload);
    const setClauses = columns.map((column, index) => `${column} = $${index + 1}`);
    setClauses.push("modified_on = CURRENT_TIMESTAMP");

    const values = [
      ...columns.map((column) => payload[column]),
      skillMapId,
      candidateId
    ];

    const result = await client.query(
      `UPDATE ${config.table}
       SET ${setClauses.join(", ")}
       WHERE ${config.idColumn} = $${columns.length + 1}
         AND ${config.candidateColumn} = $${columns.length + 2}
       RETURNING *`,
      values
    );

    const primarySkill = await syncPrimarySkillFromSkillMap(client, candidateId);

    await client.query("COMMIT");

    return {
      skill: result.rows[0],
      primary_skill: primarySkill
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (_rollbackError) {
      // ignore rollback failures
    }

    if (error.code === "23505") {
      throw httpError("Skill already assigned to this candidate.", 409);
    }

    throw error;
  } finally {
    client.release();
  }
}

async function deleteSkillMapRecord(pool, candidateId, skillMapId) {
  const client = await pool.connect();
  const config = CHILD_TABLES.skill_map;

  try {
    await client.query("BEGIN");

    const master = await getCandidateMaster(client, candidateId);

    if (!master) {
      throw httpError("Candidate not found", 404);
    }

    const records = await listChildRecords(client, "skill_map", candidateId);
    const existing = records.find(
      (row) => String(row.skill_map_id) === String(skillMapId)
    );

    if (!existing) {
      throw httpError("Skill record not found.", 404);
    }

    const priorMapRows = await resolveSkillMapDisplayNames(client, candidateId);
    const priorMapDisplayNames = priorMapRows
      .map((row) => row.display_name)
      .filter(Boolean);

    const deletedSkillLabels = [
      existing.skill_code,
      priorMapRows.find(
        (row) =>
          String(row.skill_code).toLowerCase() ===
          String(existing.skill_code).toLowerCase()
      )?.display_name
    ].filter(Boolean);

    const result = await client.query(
      `DELETE FROM ${config.table}
       WHERE ${config.idColumn} = $1
         AND ${config.candidateColumn} = $2
       RETURNING *`,
      [skillMapId, candidateId]
    );

    const primarySkill = await syncPrimarySkillFromSkillMap(client, candidateId, {
      deletedSkillLabels,
      priorMapDisplayNames
    });

    await client.query("COMMIT");

    return {
      skill: result.rows[0],
      primary_skill: primarySkill
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (_rollbackError) {
      // ignore rollback failures
    }

    throw error;
  } finally {
    client.release();
  }
}

async function countCandidateMasters(pool) {
  const result = await pool.query(`SELECT COUNT(*)::int AS count FROM ${MASTER_TABLE}`);
  return result.rows[0].count;
}

module.exports = {
  MASTER_TABLE,
  LEGACY_MASTER_COLUMNS,
  ENTERPRISE_MASTER_COLUMNS,
  EMD_LOOKUP_FIELDS,
  CHILD_TABLES,
  masterDataCodeExists,
  validateMasterDataCode,
  validateCandidateMasterLookups,
  validateSkillCode,
  validateDocumentType,
  getCandidateMaster,
  listCandidateMasters,
  listChildRecords,
  getCandidateProfile,
  insertChildRecord,
  SKILL_MAP_COLUMNS,
  pickSkillMapPayload,
  buildAdditivePrimarySkillString,
  mergeSkillTokensWithMapLabels,
  splitSkillFieldTokens,
  collectCandidateSkillTokenKeys,
  syncPrimarySkillFromSkillMap,
  insertSkillMapBatch,
  updateSkillMapRecord,
  deleteSkillMapRecord,
  countCandidateMasters
};
