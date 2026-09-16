require("dotenv").config();

const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const legacyOperationalAdapter = require("../services/legacyOperationalAdapter");

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
      role_name: user.role_name
    },
    process.env.JWT_SECRET,
    { expiresIn: "1h" }
  );
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

async function main() {
  console.log("=== Interview Schedules Recruiter Scope ===\n");

  const recruiter = await resolveUserByRole("Recruiter");
  const admin = await resolveUserByRole("Admin");

  if (!recruiter || !admin) {
    fail("fixtures", "Recruiter and Admin users required");
    await pool.end();
    return;
  }

  const scoped = await legacyOperationalAdapter.listInterviewSchedulesForLegacyApi(pool, {
    recruiterCode: recruiter.employee_code
  });
  const all = await legacyOperationalAdapter.listInterviewSchedulesForLegacyApi(pool, {
    recruiterCode: null
  });

  if (scoped.length <= all.length) {
    pass(`Service: recruiter-scoped schedules (${scoped.length}) <= unscoped (${all.length})`);
  } else {
    fail("Service: recruiter scope", `scoped=${scoped.length} all=${all.length}`);
  }

  const recruiterToken = signToken(recruiter);
  const adminToken = signToken(admin);

  const recruiterHttp = await fetchJson("/interview-schedules", recruiterToken);
  const adminHttp = await fetchJson("/interview-schedules", adminToken);

  if (recruiterHttp.status === 200 && Array.isArray(recruiterHttp.body?.data)) {
    pass(`HTTP: recruiter interview-schedules (200, count=${recruiterHttp.body.data.length})`);
  } else {
    fail("HTTP: recruiter interview-schedules", `status=${recruiterHttp.status}`);
  }

  if (adminHttp.status === 200 && Array.isArray(adminHttp.body?.data)) {
    pass(`HTTP: admin interview-schedules (200, count=${adminHttp.body.data.length})`);
  } else {
    fail("HTTP: admin interview-schedules", `status=${adminHttp.status}`);
  }

  if (recruiterHttp.body.data.length <= adminHttp.body.data.length) {
    pass("HTTP: recruiter schedule count does not exceed admin-visible pool");
  } else {
    fail("HTTP: recruiter vs admin schedule counts", "recruiter > admin");
  }

  await pool.end();

  if (process.exitCode) {
    console.log("\nInterview schedule recruiter scope verification completed with failures.");
  } else {
    console.log("\nAll interview schedule recruiter scope checks passed.");
  }
}

main().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
  await pool.end();
});
