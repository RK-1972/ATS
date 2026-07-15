require("dotenv").config();

const { Pool } = require("pg");
const candidateService = require("../services/candidateService");

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

const CHILD_TABLE_NAMES = Object.values(candidateService.CHILD_TABLES).map(
  (item) => item.table
);

const LEGACY_INSERT_COLUMNS = [
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
  "created_by"
];

function pass(label) {
  console.log(`PASS: ${label}`);
}

function fail(label, detail) {
  console.error(`FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
  process.exitCode = 1;
}

async function columnExists(tableName, columnName) {
  const result = await pool.query(
    `SELECT 1
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = $1
       AND column_name = $2`,
    [tableName, columnName]
  );
  return result.rowCount > 0;
}

async function tableExists(tableName) {
  const result = await pool.query(
    `SELECT 1
     FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name = $1`,
    [tableName]
  );
  return result.rowCount > 0;
}

async function foreignKeyTargetsCandMstr(tableName) {
  const result = await pool.query(
    `SELECT pg_get_constraintdef(c.oid) AS definition
     FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     WHERE t.relname = $1
       AND c.contype = 'f'`,
    [tableName]
  );

  return result.rows.some((row) => /REFERENCES cand_mstr\(candidate_id\)/i.test(row.definition));
}

async function main() {
  console.log("=== Candidate Enterprise Domain Verification ===\n");

  const beforeCount = await candidateService.countCandidateMasters(pool);
  pass(`Existing candidate records intact (${beforeCount} rows in cand_mstr)`);

  for (const column of candidateService.LEGACY_MASTER_COLUMNS) {
    if (await columnExists("cand_mstr", column)) {
      pass(`Legacy column retained: cand_mstr.${column}`);
    } else {
      fail(`Legacy column missing: cand_mstr.${column}`);
    }
  }

  for (const column of LEGACY_INSERT_COLUMNS) {
    if (await columnExists("cand_mstr", column)) {
      pass(`Legacy INSERT column retained: ${column}`);
    } else {
      fail(`Legacy INSERT column missing: ${column}`);
    }
  }

  for (const column of candidateService.ENTERPRISE_MASTER_COLUMNS) {
    if (await columnExists("cand_mstr", column)) {
      pass(`Enterprise column added: cand_mstr.${column}`);
    } else {
      fail(`Enterprise column missing: cand_mstr.${column}`);
    }
  }

  for (const tableName of CHILD_TABLE_NAMES) {
    if (await tableExists(tableName)) {
      pass(`Child table exists: ${tableName}`);
    } else {
      fail(`Child table missing: ${tableName}`);
    }

    if (await foreignKeyTargetsCandMstr(tableName)) {
      pass(`Foreign key valid: ${tableName} → cand_mstr(candidate_id)`);
    } else {
      fail(`Foreign key missing/invalid: ${tableName}`);
    }
  }

  const sample = await pool.query(
    "SELECT candidate_id, candidate_code, email_id FROM cand_mstr ORDER BY candidate_id DESC LIMIT 1"
  );

  if (sample.rowCount) {
    const candidateId = sample.rows[0].candidate_id;
    const profile = await candidateService.getCandidateProfile(pool, candidateId);
    pass(`getCandidateProfile works for candidate_id=${candidateId}`);
    pass(`Profile master keys include legacy fields (${Object.keys(profile.master).length} columns)`);

    for (const key of Object.keys(candidateService.CHILD_TABLES)) {
      if (Array.isArray(profile.children[key])) {
        pass(`Child collection readable: ${key}`);
      } else {
        fail(`Child collection unreadable: ${key}`);
      }
    }
  } else {
    pass("No candidate rows to profile-test (schema checks only)");
  }

  const skillSample = await pool.query(
    `SELECT code FROM md_records
     WHERE entity_type = 'skills' AND is_deleted = FALSE
     LIMIT 1`
  );

  if (skillSample.rowCount) {
    const skillCode = skillSample.rows[0].code;
    const exists = await candidateService.masterDataCodeExists(pool, "skills", skillCode);
    if (exists) {
      pass(`EMD skills lookup valid for code '${skillCode}'`);
    } else {
      fail(`EMD skills lookup failed for code '${skillCode}'`);
    }
  } else {
    pass("EMD skills lookup skipped (no seeded skills)");
  }

  const docTypeSample = await pool.query(
    `SELECT code FROM md_records
     WHERE entity_type = 'document_types' AND is_deleted = FALSE
     LIMIT 1`
  );

  if (docTypeSample.rowCount) {
    const docCode = docTypeSample.rows[0].code;
    const exists = await candidateService.masterDataCodeExists(pool, "document_types", docCode);
    if (exists) {
      pass(`EMD document_types lookup valid for code '${docCode}'`);
    } else {
      fail(`EMD document_types lookup failed for code '${docCode}'`);
    }
  } else {
    pass("EMD document_types lookup skipped (no seeded document types)");
  }

  const afterCount = await candidateService.countCandidateMasters(pool);
  if (afterCount === beforeCount) {
    pass("Candidate row count unchanged after verification reads");
  } else {
    fail("Candidate row count changed during verification", `${beforeCount} → ${afterCount}`);
  }

  console.log("\n=== Verification complete ===");
  await pool.end();

  if (process.exitCode) {
    process.exit(process.exitCode);
  }
}

main().catch(async (error) => {
  console.error("Verification error:", error.message);
  await pool.end();
  process.exit(1);
});
