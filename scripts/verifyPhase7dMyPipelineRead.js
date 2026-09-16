/**
 * Phase 7D — enterprise my pipeline read verification.
 * Run: node scripts/verifyPhase7dMyPipelineRead.js
 *
 * Requires API server running at API_BASE_URL (default http://localhost:5000).
 */
require("dotenv").config();

const jwt = require("jsonwebtoken");
const { Pool } = require("pg");

const API_BASE_URL = process.env.API_BASE_URL || "http://localhost:5000";

const EXPECTED_FIELDS = [
  "candidate_id",
  "candidate_code",
  "first_name",
  "last_name",
  "email_id",
  "mobile_number",
  "primary_skill",
  "total_experience",
  "stage_name",
  "source_type",
  "applied_date",
  "req_code",
  "job_title"
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

function skip(label, reason) {
  console.log(`SKIP: ${label} — ${reason}`);
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

async function resolveOtherRecruiter(excludeCode) {
  const result = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name, secondary_role
     FROM user_mstr
     WHERE role_name = 'Recruiter'
       AND employee_code <> $1
       AND COALESCE(is_active, TRUE) = TRUE
     ORDER BY user_id ASC
     LIMIT 1`,
    [excludeCode]
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

  return true;
}

function assertAppliedDateDesc(rows, label) {
  for (let index = 1; index < rows.length; index += 1) {
    const previous = rows[index - 1].applied_date
      ? new Date(rows[index - 1].applied_date).getTime()
      : null;
    const current = rows[index].applied_date
      ? new Date(rows[index].applied_date).getTime()
      : null;

    if (previous !== null && current !== null && previous < current) {
      fail(`${label} ordering`, "rows are not applied_date DESC");
      return false;
    }
  }

  return true;
}

async function assertOwnerScope(rows, employeeCode, label) {
  if (!rows.length) {
    pass(`${label} owner scope (empty list)`);
    return;
  }

  const candidateIds = rows.map((row) => row.candidate_id);
  const ownerCheck = await pool.query(
    `SELECT COUNT(*)::int AS total
     FROM cand_mstr
     WHERE candidate_id = ANY($1::int[])
       AND candidate_container = 'PIPELINE'
       AND owner_employee_code = $2`,
    [candidateIds, employeeCode]
  );

  if (ownerCheck.rows[0].total === candidateIds.length) {
    pass(`${label} owner scope (${rows.length} row(s))`);
  } else {
    fail(
      `${label} owner scope`,
      `expected=${candidateIds.length}, scoped=${ownerCheck.rows[0].total}`
    );
  }
}

async function main() {
  console.log("=== Phase 7D Enterprise My Pipeline Read ===\n");

  const admin = await resolveUserByRole("Admin");
  const recruiter = await resolveUserByRole("Recruiter");
  const otherRecruiter = recruiter
    ? await resolveOtherRecruiter(recruiter.employee_code)
    : null;

  if (!admin || !recruiter) {
    fail("fixtures", "Admin and Recruiter users required");
    await pool.end();
    return;
  }

  const adminToken = signToken(admin);
  const recruiterToken = signToken(recruiter);
  const otherRecruiterToken = otherRecruiter ? signToken(otherRecruiter) : null;

  const unauth = await fetchJson(
    "/api/v1/recruitment/candidates?view=pipeline"
  );
  if (unauth.status === 401) {
    pass("HTTP: unauthenticated request rejected (401)");
  } else {
    fail("HTTP: unauthenticated request", `expected 401, got ${unauth.status}`);
  }

  const adminPipeline = await fetchJson(
    "/api/v1/recruitment/candidates?view=pipeline",
    adminToken
  );
  if (adminPipeline.status === 200 && adminPipeline.body?.success) {
    pass("HTTP: Admin pipeline GET (200)");
  } else {
    fail("HTTP: Admin pipeline GET", `status=${adminPipeline.status}`);
  }

  const recruiterPipeline = await fetchJson(
    "/api/v1/recruitment/candidates?view=pipeline",
    recruiterToken
  );
  if (recruiterPipeline.status === 200 && recruiterPipeline.body?.success) {
    pass("HTTP: Recruiter pipeline GET (200)");
  } else {
    fail("HTTP: Recruiter pipeline GET", `status=${recruiterPipeline.status}`);
  }

  const legacyPipeline = await fetchJson("/my-candidates-list", recruiterToken);
  if (legacyPipeline.status === 200 && legacyPipeline.body?.success) {
    pass("HTTP: legacy /my-candidates-list still available (200)");
  } else {
    fail("HTTP: legacy /my-candidates-list", `status=${legacyPipeline.status}`);
  }

  const v1Rows = recruiterPipeline.body?.data || [];
  const legacyRows = legacyPipeline.body?.data || [];

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
      || String(row.stage_name ?? "") !== String(legacyRow.stage_name ?? "")
      || String(row.req_code ?? "") !== String(legacyRow.req_code ?? "")
      || String(row.job_title ?? "") !== String(legacyRow.job_title ?? "")
    );
  });

  if (!parityMismatch) {
    pass("row parity with legacy /my-candidates-list");
  } else {
    fail(
      "row parity with legacy /my-candidates-list",
      `candidate_id=${parityMismatch.candidate_id}`
    );
  }

  if (assertShapeParity(v1Rows[0], "v1")) {
    pass("v1 response shape matches legacy pipeline fields");
  }

  if (v1Rows.length <= 1 || assertAppliedDateDesc(v1Rows, "v1")) {
    if (v1Rows.length > 1) {
      pass("v1 rows ordered by applied_date DESC");
    } else {
      pass("v1 ordering check skipped (0-1 rows)");
    }
  }

  await assertOwnerScope(v1Rows, recruiter.employee_code, "Recruiter v1");
  await assertOwnerScope(
    adminPipeline.body?.data || [],
    admin.employee_code,
    "Admin v1"
  );

  if (v1Rows.length > 0) {
    const containers = await pool.query(
      `SELECT candidate_id, candidate_container
       FROM cand_mstr
       WHERE candidate_id = ANY($1::int[])`,
      [v1Rows.map((row) => row.candidate_id)]
    );
    const leakedTalent = containers.rows.filter(
      (row) => String(row.candidate_container || "").toUpperCase() === "TALENT_POOL"
    );

    if (leakedTalent.length === 0) {
      pass("no TALENT_POOL leakage into pipeline list");
    } else {
      fail(
        "no TALENT_POOL leakage",
        `candidate_id=${leakedTalent[0].candidate_id}`
      );
    }
  } else {
    pass("no TALENT_POOL leakage (empty list)");
  }

  const foreignOwned = (
    await pool.query(
      `SELECT candidate_id, owner_employee_code
       FROM cand_mstr
       WHERE candidate_container = 'PIPELINE'
         AND owner_employee_code IS NOT NULL
         AND owner_employee_code <> $1
       ORDER BY candidate_id DESC
       LIMIT 1`,
      [recruiter.employee_code]
    )
  ).rows[0];

  if (foreignOwned && otherRecruiterToken) {
    const foreignList = await fetchJson(
      "/api/v1/recruitment/candidates?view=pipeline",
      recruiterToken
    );
    const leaked = (foreignList.body?.data || []).some(
      (row) => Number(row.candidate_id) === Number(foreignOwned.candidate_id)
    );

    if (!leaked) {
      pass("cross-recruiter owned PIPELINE candidate excluded");
    } else {
      fail(
        "cross-recruiter owned PIPELINE candidate excluded",
        `candidate_id=${foreignOwned.candidate_id}`
      );
    }
  } else {
    skip("cross-recruiter exclusion", "no foreign-owned PIPELINE fixture");
  }

  const enterpriseFixture = (
    await pool.query(
      `SELECT cm.candidate_id, em.stage_name, em.requisition_code
       FROM cand_mstr cm
       INNER JOIN rm_candidate_mappings em
         ON em.candidate_id = cm.candidate_id
        AND em.is_active = true
       WHERE cm.candidate_container = 'PIPELINE'
         AND cm.owner_employee_code = $1
       ORDER BY em.modified_on DESC NULLS LAST
       LIMIT 1`,
      [recruiter.employee_code]
    )
  ).rows[0];

  if (enterpriseFixture) {
    const v1Row = v1Rows.find(
      (row) => Number(row.candidate_id) === Number(enterpriseFixture.candidate_id)
    );

    if (v1Row && String(v1Row.stage_name ?? "") === String(enterpriseFixture.stage_name ?? "")) {
      pass("enterprise-backed mapping fields surface in v1 list");
    } else {
      fail(
        "enterprise-backed mapping fields surface in v1 list",
        `candidate_id=${enterpriseFixture.candidate_id}`
      );
    }
  } else {
    skip("enterprise mapping fixture", "no owned PIPELINE enterprise mapping");
  }

  const legacyOnlyFixture = (
    await pool.query(
      `SELECT cm.candidate_id, lcrm.stage_name, rm.req_code
       FROM cand_mstr cm
       LEFT JOIN rm_candidate_mappings em
         ON em.candidate_id = cm.candidate_id
        AND em.is_active = true
       INNER JOIN candidate_req_map lcrm
         ON lcrm.candidate_id = cm.candidate_id
        AND lcrm.is_active = true
       LEFT JOIN req_mstr rm ON rm.req_id = lcrm.req_id
       WHERE cm.candidate_container = 'PIPELINE'
         AND cm.owner_employee_code = $1
         AND em.mapping_id IS NULL
       ORDER BY cm.candidate_id DESC
       LIMIT 1`,
      [recruiter.employee_code]
    )
  ).rows[0];

  if (legacyOnlyFixture) {
    const v1Row = v1Rows.find(
      (row) => Number(row.candidate_id) === Number(legacyOnlyFixture.candidate_id)
    );

    if (
      v1Row
      && String(v1Row.stage_name ?? "") === String(legacyOnlyFixture.stage_name ?? "")
    ) {
      pass("legacy-only fallback fields surface in v1 list");
    } else {
      fail(
        "legacy-only fallback fields surface in v1 list",
        `candidate_id=${legacyOnlyFixture.candidate_id}`
      );
    }
  } else {
    skip("legacy-only fallback fixture", "no owned legacy-only PIPELINE row");
  }

  const enterpriseWinsFixture = (
    await pool.query(
      `SELECT cm.candidate_id, em.stage_name AS enterprise_stage, lcrm.stage_name AS legacy_stage
       FROM cand_mstr cm
       INNER JOIN rm_candidate_mappings em
         ON em.candidate_id = cm.candidate_id
        AND em.is_active = true
       INNER JOIN candidate_req_map lcrm
         ON lcrm.candidate_id = cm.candidate_id
        AND lcrm.is_active = true
       WHERE cm.candidate_container = 'PIPELINE'
         AND cm.owner_employee_code = $1
         AND em.stage_name IS NOT NULL
         AND lcrm.stage_name IS NOT NULL
         AND em.stage_name <> lcrm.stage_name
       ORDER BY cm.candidate_id DESC
       LIMIT 1`,
      [recruiter.employee_code]
    )
  ).rows[0];

  if (enterpriseWinsFixture) {
    const v1Row = v1Rows.find(
      (row) => Number(row.candidate_id) === Number(enterpriseWinsFixture.candidate_id)
    );

    if (
      v1Row
      && String(v1Row.stage_name ?? "") === String(enterpriseWinsFixture.enterprise_stage ?? "")
    ) {
      pass("enterprise mapping wins over legacy fallback for stage_name");
    } else {
      fail(
        "enterprise mapping wins over legacy fallback",
        `candidate_id=${enterpriseWinsFixture.candidate_id}`
      );
    }
  } else {
    skip(
      "enterprise wins over legacy",
      "no owned row with differing enterprise vs legacy stage_name"
    );
  }

  await pool.end();

  if (process.exitCode) {
    console.log("\nPhase 7D my pipeline read verification completed with failures.");
  } else {
    console.log("\nAll Phase 7D my pipeline read checks passed.");
  }
}

main().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
  await pool.end();
});
