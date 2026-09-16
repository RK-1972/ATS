/**
 * Phase 5B — ATS pipeline stage catalog verification.
 * Run: node scripts/verifyPhase5bAtsStageCatalog.js
 */
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const atsStageCatalogService = require("../services/atsStageCatalogService");

const API_BASE_URL = process.env.API_BASE_URL || "http://localhost:5000";

const CANONICAL_STAGES = [
  { stage_code: "APPLIED", display_name: "Applied", sort_order: 10, is_terminal: false },
  { stage_code: "SCREENING", display_name: "Screening", sort_order: 20, is_terminal: false },
  { stage_code: "L1_INTERVIEW", display_name: "L1 Interview", sort_order: 30, is_terminal: false },
  { stage_code: "L2_INTERVIEW", display_name: "L2 Interview", sort_order: 40, is_terminal: false },
  {
    stage_code: "CLIENT_INTERVIEW",
    display_name: "Client Interview",
    sort_order: 50,
    is_terminal: false
  },
  { stage_code: "OFFER", display_name: "Offer", sort_order: 60, is_terminal: false },
  { stage_code: "JOINED", display_name: "Joined", sort_order: 70, is_terminal: true }
];

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

function pass(label) {
  console.log(`PASS: ${label}`);
}

function fail(label, detail) {
  console.error(`FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
  process.exitCode = 1;
}

function skip(label, detail) {
  console.log(`SKIP: ${label}${detail ? ` — ${detail}` : ""}`);
}

function signToken(user) {
  return jwt.sign(
    {
      user_id: user.user_id,
      employee_code: user.employee_code,
      email_id: user.email_id,
      role_name: user.role_name
    },
    process.env.JWT_SECRET,
    { expiresIn: "1h" }
  );
}

async function ensureMigrationApplied() {
  const tableCheck = await pool.query(
    `SELECT EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = 'rm_ats_stage_catalog'
    ) AS exists`
  );

  if (tableCheck.rows[0]?.exists) {
    pass("rm_ats_stage_catalog table exists");
    return;
  }

  const migrationPath = path.join(
    __dirname,
    "..",
    "migrations",
    "050_rm_ats_stage_catalog.sql"
  );
  const sql = fs.readFileSync(migrationPath, "utf8");
  await pool.query(sql);
  pass("applied migration 050_rm_ats_stage_catalog.sql");
}

async function resolveUserByRole(roleName) {
  const result = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name
     FROM user_mstr
     WHERE role_name = $1 AND COALESCE(is_active, TRUE) = TRUE
     ORDER BY user_id ASC
     LIMIT 1`,
    [roleName]
  );

  return result.rows[0] || null;
}

async function fetchJson(path, token) {
  const headers = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE_URL}${path}`, { headers });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

async function main() {
  console.log("=== Phase 5B ATS Stage Catalog ===\n");

  const mappingCountBefore = await pool.query(
    `SELECT COUNT(*)::int AS total FROM rm_candidate_mappings`
  );
  const historyCountBefore = await pool.query(
    `SELECT COUNT(*)::int AS total FROM rm_pipeline_history`
  );

  await ensureMigrationApplied();

  const uniqueCodes = await pool.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(DISTINCT stage_code)::int AS distinct_codes
     FROM rm_ats_stage_catalog`
  );

  if (
    uniqueCodes.rows[0]?.total === uniqueCodes.rows[0]?.distinct_codes &&
    uniqueCodes.rows[0]?.total >= CANONICAL_STAGES.length
  ) {
    pass(`stage_code uniqueness (${uniqueCodes.rows[0].distinct_codes} rows)`);
  } else {
    fail("stage_code uniqueness");
  }

  const activeStages = await atsStageCatalogService.listActiveAtsStageCatalog(pool);

  if (activeStages.length === CANONICAL_STAGES.length) {
    pass(`active catalog contains ${activeStages.length} canonical stages`);
  } else {
    fail(
      "active catalog contains canonical stages",
      `expected=${CANONICAL_STAGES.length}, actual=${activeStages.length}`
    );
  }

  for (const expected of CANONICAL_STAGES) {
    const row = activeStages.find((item) => item.stage_code === expected.stage_code);

    if (!row) {
      fail(`seeded stage present (${expected.stage_code})`);
      continue;
    }

    if (
      row.display_name !== expected.display_name ||
      row.sort_order !== expected.sort_order ||
      row.is_terminal !== expected.is_terminal
    ) {
      fail(`seeded stage metadata (${expected.stage_code})`);
    }
  }

  if (!process.exitCode) {
    pass("seeded stage metadata matches Enterprise PIPELINE_STAGES vocabulary");
  }

  const sortOrders = activeStages.map((row) => row.sort_order);
  const sortedOrders = [...sortOrders].sort((a, b) => a - b);

  if (
    JSON.stringify(sortOrders) === JSON.stringify(sortedOrders) &&
    new Set(sortOrders).size === sortOrders.length
  ) {
    pass("catalog ordering is deterministic by sort_order");
  } else {
    fail("catalog ordering is deterministic by sort_order");
  }

  const inactiveFixtureCode = "INACTIVE_FIXTURE";
  await pool.query(
    `INSERT INTO rm_ats_stage_catalog (
      stage_code, display_name, sort_order, is_terminal, is_active
    ) VALUES ($1, $2, 999, FALSE, FALSE)
    ON CONFLICT (stage_code) DO UPDATE
    SET display_name = EXCLUDED.display_name,
        sort_order = EXCLUDED.sort_order,
        is_terminal = EXCLUDED.is_terminal,
        is_active = EXCLUDED.is_active,
        updated_at = NOW()`,
    [inactiveFixtureCode, "Inactive Fixture"]
  );

  const activeAfterInactive = await atsStageCatalogService.listActiveAtsStageCatalog(
    pool
  );

  if (!activeAfterInactive.some((row) => row.stage_code === inactiveFixtureCode)) {
    pass("inactive stages are excluded from active catalog read");
  } else {
    fail("inactive stages are excluded from active catalog read");
  }

  const mappingCountAfter = await pool.query(
    `SELECT COUNT(*)::int AS total FROM rm_candidate_mappings`
  );
  const historyCountAfter = await pool.query(
    `SELECT COUNT(*)::int AS total FROM rm_pipeline_history`
  );

  if (mappingCountBefore.rows[0].total === mappingCountAfter.rows[0].total) {
    pass("rm_candidate_mappings row count unchanged");
  } else {
    fail("rm_candidate_mappings row count unchanged");
  }

  if (historyCountBefore.rows[0].total === historyCountAfter.rows[0].total) {
    pass("rm_pipeline_history row count unchanged");
  } else {
    fail("rm_pipeline_history row count unchanged");
  }

  const recruiter = await resolveUserByRole("Recruiter");
  if (recruiter) {
    const token = signToken(recruiter);
    const http = await fetchJson("/api/v1/recruitment/ats-stage-catalog", token);

    if (http.status === 200 && Array.isArray(http.body?.data)) {
      pass(`HTTP ats-stage-catalog (200, count=${http.body.data.length})`);
    } else {
      fail("HTTP ats-stage-catalog", `status=${http.status}`);
    }

    const unauth = await fetchJson("/api/v1/recruitment/ats-stage-catalog");
    if (unauth.status === 401) {
      pass("HTTP ats-stage-catalog requires auth (401)");
    } else {
      fail("HTTP ats-stage-catalog requires auth", `status=${unauth.status}`);
    }
  } else {
    skip("HTTP ats-stage-catalog checks", "no recruiter user");
  }

  await pool.query(
    `DELETE FROM rm_ats_stage_catalog WHERE stage_code = $1`,
    [inactiveFixtureCode]
  );

  if (process.exitCode) {
    console.log("\nPhase 5B ATS stage catalog verification completed with failures.");
  } else {
    console.log("\nAll Phase 5B ATS stage catalog checks passed.");
  }
}

main()
  .catch((error) => {
    fail("verification script", error.message);
    console.error(error);
  })
  .finally(async () => {
    await pool.end();
  });
