/**
 * Phase 7C — enterprise talent pool read verification.
 * Run: node scripts/verifyPhase7cTalentPoolRead.js
 *
 * Requires API server running at API_BASE_URL (default http://localhost:5000).
 */
require("dotenv").config();

const jwt = require("jsonwebtoken");
const { Pool } = require("pg");

const API_BASE_URL = process.env.API_BASE_URL || "http://localhost:5000";

const EXPECTED_FIELDS = [
  "candidate_type",
  "candidate_id",
  "candidate_code",
  "first_name",
  "middle_name",
  "last_name",
  "preferred_name",
  "email_id",
  "mobile_number",
  "primary_skill",
  "total_experience",
  "current_company",
  "current_location",
  "candidate_status",
  "created_on"
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

function signToken(user) {
  return jwt.sign(
    {
      user_id: user.user_id,
      employee_code: user.employee_code,
      email_id: user.email_id,
      role_name: user.role_name,
      secondary_role: user.secondary_role || null
    },
    process.env.JWT_SECRET,
    { expiresIn: "1h" }
  );
}

async function fetchJson(path, token, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers
  });

  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

async function resolveUserByRole(roleName) {
  const result = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name, secondary_role
     FROM user_mstr
     WHERE role_name = $1 AND COALESCE(is_active, TRUE) = TRUE
     ORDER BY user_id ASC
     LIMIT 1`,
    [roleName]
  );
  return result.rows[0] || null;
}

function sortByCandidateId(rows) {
  return [...rows].sort(
    (left, right) => Number(left.candidate_id) - Number(right.candidate_id)
  );
}

function assertShapeParity(sampleRow, label) {
  if (!sampleRow) {
    return true;
  }

  for (const field of EXPECTED_FIELDS) {
    if (!(field in sampleRow)) {
      fail(`${label} response shape`, `missing field ${field}`);
      return false;
    }
  }

  if (sampleRow.candidate_type !== "AVAILABLE") {
    fail(`${label} response shape`, `candidate_type=${sampleRow.candidate_type}`);
    return false;
  }

  return true;
}

function assertNewestFirst(rows, label) {
  for (let index = 1; index < rows.length; index += 1) {
    const previous = new Date(rows[index - 1].created_on).getTime();
    const current = new Date(rows[index].created_on).getTime();

    if (previous < current) {
      fail(`${label} ordering`, "rows are not newest-first by created_on");
      return false;
    }
  }

  return true;
}

async function main() {
  console.log("=== Phase 7C Enterprise Talent Pool Read ===\n");

  const admin = await resolveUserByRole("Admin");
  const recruiter = await resolveUserByRole("Recruiter");

  if (!admin || !recruiter) {
    fail("fixtures", "Admin and Recruiter users required");
    await pool.end();
    return;
  }

  const adminToken = signToken(admin);
  const recruiterToken = signToken(recruiter);

  const unauth = await fetchJson("/api/v1/recruitment/candidates?view=pool");
  if (unauth.status === 401) {
    pass("HTTP: unauthenticated request rejected (401)");
  } else {
    fail("HTTP: unauthenticated request", `expected 401, got ${unauth.status}`);
  }

  const missingView = await fetchJson(
    "/api/v1/recruitment/candidates",
    adminToken
  );
  if (missingView.status === 400) {
    pass("HTTP: missing view returns 400");
  } else {
    fail("HTTP: missing view", `expected 400, got ${missingView.status}`);
  }

  const invalidView = await fetchJson(
    "/api/v1/recruitment/candidates?view=invalid",
    adminToken
  );
  if (invalidView.status === 400) {
    pass("HTTP: unsupported view returns 400");
  } else {
    fail("HTTP: unsupported view", `expected 400, got ${invalidView.status}`);
  }

  const adminPool = await fetchJson(
    "/api/v1/recruitment/candidates?view=pool",
    adminToken
  );
  if (adminPool.status === 200 && adminPool.body?.success) {
    pass("HTTP: Admin talent pool GET (200)");
  } else {
    fail("HTTP: Admin talent pool GET", `status=${adminPool.status}`);
  }

  const recruiterPool = await fetchJson(
    "/api/v1/recruitment/candidates?view=pool",
    recruiterToken
  );
  if (recruiterPool.status === 200 && recruiterPool.body?.success) {
    pass("HTTP: Recruiter talent pool GET (200)");
  } else {
    fail("HTTP: Recruiter talent pool GET", `status=${recruiterPool.status}`);
  }

  const legacyPool = await fetchJson("/available-candidates", adminToken);
  if (legacyPool.status === 200 && legacyPool.body?.success) {
    pass("HTTP: legacy /available-candidates still available (200)");
  } else {
    fail("HTTP: legacy /available-candidates", `status=${legacyPool.status}`);
  }

  const v1Rows = adminPool.body?.data || [];
  const legacyRows = legacyPool.body?.data || [];

  if (v1Rows.length === legacyRows.length) {
    pass(`count parity with legacy endpoint (${v1Rows.length})`);
  } else {
    fail(
      "count parity with legacy endpoint",
      `v1=${v1Rows.length}, legacy=${legacyRows.length}`
    );
  }

  const v1Sorted = sortByCandidateId(v1Rows);
  const legacySorted = sortByCandidateId(legacyRows);
  const parityMismatch = v1Sorted.find((row, index) => {
    const legacyRow = legacySorted[index];
    return (
      !legacyRow
      || Number(row.candidate_id) !== Number(legacyRow.candidate_id)
      || String(row.candidate_code || "") !== String(legacyRow.candidate_code || "")
      || String(row.email_id || "") !== String(legacyRow.email_id || "")
    );
  });

  if (!parityMismatch) {
    pass("row parity with legacy endpoint");
  } else {
    fail(
      "row parity with legacy endpoint",
      `candidate_id=${parityMismatch.candidate_id}`
    );
  }

  if (assertShapeParity(v1Rows[0], "v1")) {
    pass("v1 response shape matches legacy talent pool fields");
  }

  if (assertShapeParity(legacyRows[0], "legacy")) {
    pass("legacy response shape baseline preserved");
  }

  if (v1Rows.length <= 1 || assertNewestFirst(v1Rows, "v1")) {
    if (v1Rows.length > 1) {
      pass("v1 rows ordered newest-first by created_on");
    } else {
      pass("v1 ordering check skipped (0-1 rows)");
    }
  }

  if (v1Rows.length > 0) {
    const containers = await pool.query(
      `SELECT candidate_id, candidate_container
       FROM cand_mstr
       WHERE candidate_id = ANY($1::int[])`,
      [v1Rows.map((row) => row.candidate_id)]
    );

    const nonPool = containers.rows.filter(
      (row) => String(row.candidate_container || "").toUpperCase() !== "TALENT_POOL"
    );

    if (nonPool.length === 0) {
      pass("v1 rows are TALENT_POOL only");
    } else {
      fail("v1 rows are TALENT_POOL only", `leaked candidate_id=${nonPool[0].candidate_id}`);
    }
  } else {
    pass("v1 rows are TALENT_POOL only (empty list)");
  }

  const pipelineFixture = (
    await pool.query(
      `SELECT candidate_id
       FROM cand_mstr
       WHERE UPPER(COALESCE(candidate_container, 'PIPELINE')) = 'PIPELINE'
       ORDER BY candidate_id DESC
       LIMIT 1`
    )
  ).rows[0];

  if (pipelineFixture) {
    const leaked = v1Rows.some(
      (row) => Number(row.candidate_id) === Number(pipelineFixture.candidate_id)
    );

    if (!leaked) {
      pass("no PIPELINE candidate leakage into talent pool list");
    } else {
      fail(
        "no PIPELINE candidate leakage",
        `candidate_id=${pipelineFixture.candidate_id}`
      );
    }
  } else {
    pass("no PIPELINE candidate leakage (no PIPELINE fixture)");
  }

  await pool.end();

  if (process.exitCode) {
    console.log("\nPhase 7C talent pool read verification completed with failures.");
  } else {
    console.log("\nAll Phase 7C talent pool read checks passed.");
  }
}

main().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
  await pool.end();
});
