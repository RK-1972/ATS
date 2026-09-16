/**
 * Phase 3B — interview schedules SoR consolidation verification.
 * Run: node scripts/verifyPhase3bInterviewSchedulesSorConsolidation.js
 */
require("dotenv").config();

const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const legacyOperationalAdapter = require("../services/legacyOperationalAdapter");
const { isEnterpriseOperationalSor } = require("../config/operationalCutover");

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

async function tableExists(tableName) {
  const result = await pool.query(
    `SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = $1
    ) AS exists`,
    [tableName]
  );

  return result.rows[0]?.exists === true;
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

  const response = await fetch(`http://localhost:5000${path}`, { headers });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

function assertNoDuplicateScheduleIds(rows, label) {
  const seen = new Set();

  for (const row of rows) {
    if (row.schedule_id == null) {
      continue;
    }

    const key = String(row.schedule_id);
    if (seen.has(key)) {
      fail(`${label} duplicate schedule_id`, key);
      return false;
    }

    seen.add(key);
  }

  pass(`${label} has no duplicate schedule_id values`);
  return true;
}

async function main() {
  console.log("=== Phase 3B Interview Schedules SoR Consolidation ===\n");

  if (!isEnterpriseOperationalSor()) {
    skip("enterprise-first consolidation", "OPERATIONAL_SOR is not enterprise");
    await pool.end();
    return;
  }

  pass("OPERATIONAL_SOR is enterprise");

  const hasLegacyMap = await tableExists("candidate_req_map");
  if (!hasLegacyMap) {
    skip("legacy fallback checks", "candidate_req_map missing");
  } else {
    pass("candidate_req_map available for legacy fallback");
  }

  const adminSchedules = await legacyOperationalAdapter.listInterviewSchedulesForLegacyApi(
    pool,
    { recruiterCode: null }
  );
  assertNoDuplicateScheduleIds(adminSchedules, "admin service list");

  const enterpriseBacked = await pool.query(
    `SELECT i.schedule_id
     FROM im_interviews i
     INNER JOIN rm_candidate_mappings crm ON crm.map_id = i.map_id
     WHERE i.schedule_id IS NOT NULL`
  );

  const scheduleIds = new Set(
    adminSchedules.map((row) => String(row.schedule_id))
  );

  let missingEnterprise = 0;
  for (const row of enterpriseBacked.rows) {
    if (!scheduleIds.has(String(row.schedule_id))) {
      missingEnterprise += 1;
    }
  }

  if (missingEnterprise > 0) {
    fail(
      "enterprise-backed schedules visible",
      `missing=${missingEnterprise}`
    );
  } else if (enterpriseBacked.rows.length > 0) {
    pass("enterprise-backed schedules visible");
  } else {
    skip("enterprise-backed schedules visible", "no enterprise-backed fixtures");
  }

  if (hasLegacyMap) {
    const legacyOnly = await pool.query(
      `SELECT ist.schedule_id
       FROM interview_schedule_trn ist
       INNER JOIN candidate_req_map crm ON crm.map_id = ist.map_id
       WHERE NOT EXISTS (
         SELECT 1
         FROM im_interviews e
         WHERE e.schedule_id = ist.schedule_id
       )`
    );

    let missingLegacyOnly = 0;
    for (const row of legacyOnly.rows) {
      if (!scheduleIds.has(String(row.schedule_id))) {
        missingLegacyOnly += 1;
      }
    }

    if (missingLegacyOnly > 0) {
      fail(
        "legacy-only schedules visible through fallback",
        `missing=${missingLegacyOnly}`
      );
    } else if (legacyOnly.rows.length > 0) {
      pass("legacy-only schedules visible through fallback");
    } else {
      skip(
        "legacy-only schedules visible through fallback",
        "no legacy-only schedule fixtures"
      );
    }

    const dualBacked = await pool.query(
      `SELECT
         i.schedule_id,
         COALESCE(r.requisition_code, r2.requisition_code) AS enterprise_req_code,
         rm.req_code AS legacy_req_code
       FROM im_interviews i
       INNER JOIN rm_candidate_mappings crm ON crm.map_id = i.map_id
       LEFT JOIN rm_requisitions r ON r.req_id = i.req_id
       LEFT JOIN rm_requisitions r2 ON r2.requisition_code = i.requisition_code
       INNER JOIN interview_schedule_trn ist ON ist.schedule_id = i.schedule_id
       LEFT JOIN req_mstr rm ON rm.req_id = ist.req_id
       WHERE i.schedule_id IS NOT NULL
       LIMIT 1`
    );

    if (dualBacked.rows[0]) {
      const sample = dualBacked.rows[0];
      const mergedRow = adminSchedules.find(
        (row) => String(row.schedule_id) === String(sample.schedule_id)
      );

      if (!mergedRow) {
        fail(
          "enterprise wins on duplicate schedule_id",
          `schedule_id=${sample.schedule_id} missing from merged list`
        );
      } else if (
        sample.enterprise_req_code &&
        mergedRow.req_code !== sample.enterprise_req_code
      ) {
        fail(
          "enterprise wins on duplicate schedule_id",
          `expected req_code=${sample.enterprise_req_code}, got ${mergedRow.req_code}`
        );
      } else {
        pass("enterprise wins on duplicate schedule_id");
      }
    } else {
      skip(
        "enterprise wins on duplicate schedule_id",
        "no dual-backed schedule fixtures"
      );
    }
  }

  const recruiter = await resolveUserByRole("Recruiter");
  const admin = await resolveUserByRole("Admin");

  if (!recruiter || !admin) {
    skip("recruiter scope checks", "Recruiter and Admin users required");
  } else {
    const scoped = await legacyOperationalAdapter.listInterviewSchedulesForLegacyApi(
      pool,
      { recruiterCode: recruiter.employee_code }
    );
    const all = await legacyOperationalAdapter.listInterviewSchedulesForLegacyApi(
      pool,
      { recruiterCode: null }
    );

    assertNoDuplicateScheduleIds(scoped, "recruiter service list");

    if (scoped.length <= all.length) {
      pass(
        `recruiter-scoped schedules (${scoped.length}) <= unscoped (${all.length})`
      );
    } else {
      fail(
        "recruiter scope",
        `scoped=${scoped.length}, all=${all.length}`
      );
    }

    const recruiterToken = signToken(recruiter);
    const adminToken = signToken(admin);
    const recruiterHttp = await fetchJson("/interview-schedules", recruiterToken);
    const adminHttp = await fetchJson("/interview-schedules", adminToken);

    if (recruiterHttp.status === 200 && Array.isArray(recruiterHttp.body?.data)) {
      pass(
        `HTTP recruiter interview-schedules (200, count=${recruiterHttp.body.data.length})`
      );
    } else {
      fail("HTTP recruiter interview-schedules", `status=${recruiterHttp.status}`);
    }

    if (adminHttp.status === 200 && Array.isArray(adminHttp.body?.data)) {
      pass(`HTTP admin interview-schedules (200, count=${adminHttp.body.data.length})`);
    } else {
      fail("HTTP admin interview-schedules", `status=${adminHttp.status}`);
    }

    if (recruiterHttp.body.data.length <= adminHttp.body.data.length) {
      pass("HTTP recruiter schedule count does not exceed admin-visible pool");
    } else {
      fail(
        "HTTP recruiter vs admin schedule counts",
        "recruiter > admin"
      );
    }
  }

  if (process.exitCode) {
    console.log("\nPhase 3B interview schedules verification completed with failures.");
  } else {
    console.log("\nAll Phase 3B interview schedules checks passed.");
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
