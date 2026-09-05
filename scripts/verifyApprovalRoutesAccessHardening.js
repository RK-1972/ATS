require("dotenv").config();

const jwt = require("jsonwebtoken");
const { Pool } = require("pg");

const API_BASE_URL = process.env.API_BASE_URL || "http://localhost:5000";

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

async function fetchJson(path, token) {
  const headers = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE_URL}${path}`, { headers });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
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

async function main() {
  console.log("=== Approval Routes Access Hardening (P2-3) ===\n");

  const admin = await resolveUserByRole("Admin");
  const recruiter = await resolveUserByRole("Recruiter");

  if (!admin || !recruiter) {
    fail("fixtures", "Admin and Recruiter users required");
    await pool.end();
    return;
  }

  const adminToken = signToken(admin);
  const recruiterToken = signToken(recruiter);

  const adminList = await fetchJson("/approval-routes", adminToken);
  if (adminList.status === 200 && adminList.body?.success) {
    pass("HTTP: Admin can list approval routes (200)");
  } else {
    fail("HTTP: Admin list approval routes", `status=${adminList.status}`);
  }

  const recruiterList = await fetchJson("/approval-routes", recruiterToken);
  if (recruiterList.status === 403) {
    pass("HTTP: non-Admin denied approval routes list (403)");
  } else {
    fail("HTTP: non-Admin approval routes list", `expected 403, got ${recruiterList.status}`);
  }

  const routeId = Array.isArray(adminList.body?.data) && adminList.body.data[0]?.route_id
    ? adminList.body.data[0].route_id
    : null;

  if (routeId) {
    const adminDetail = await fetchJson(`/approval-routes/${routeId}`, adminToken);
    if (adminDetail.status === 200 && adminDetail.body?.success) {
      pass("HTTP: Admin can read approval route detail (200)");
    } else {
      fail("HTTP: Admin approval route detail", `status=${adminDetail.status}`);
    }

    const recruiterDetail = await fetchJson(`/approval-routes/${routeId}`, recruiterToken);
    if (recruiterDetail.status === 403) {
      pass("HTTP: non-Admin denied approval route detail (403)");
    } else {
      fail("HTTP: non-Admin approval route detail", `expected 403, got ${recruiterDetail.status}`);
    }
  } else {
    console.log("SKIP: no approval route fixture for detail test");
  }

  await pool.end();

  if (process.exitCode) {
    console.log("\nApproval routes access hardening verification completed with failures.");
  } else {
    console.log("\nAll approval routes access hardening checks passed.");
  }
}

main().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
  await pool.end();
});
