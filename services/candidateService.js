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
  countCandidateMasters
};
