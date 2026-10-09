/**
 * Verifies inactive employees are excluded from operational dropdown APIs.
 * Run: node scripts/verifyInactiveEmployeeUiExclusion.js
 */
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

let passCount = 0;
let failCount = 0;

function pass(label) {
  passCount += 1;
  console.log(`PASS: ${label}`);
}

function fail(label, detail) {
  failCount += 1;
  console.error(`FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
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

async function fetchJson(path, token) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {}
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

async function main() {
  const admin = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name, secondary_role
     FROM user_mstr
     WHERE role_name = 'Admin' AND is_active = TRUE
     LIMIT 1`
  );
  const inactive = await pool.query(
    `SELECT employee_code, full_name, user_id
     FROM user_mstr
     WHERE is_active = FALSE
     ORDER BY updated_on DESC NULLS LAST
     LIMIT 1`
  );

  if (!admin.rows[0]) {
    fail("admin fixture");
    process.exit(1);
  }

  const token = signToken(admin.rows[0]);
  const inactiveCode = inactive.rows[0]?.employee_code;
  const inactiveUserId = inactive.rows[0]?.user_id;

  if (!inactiveCode) {
    console.log("SKIP: no inactive employee in database for exclusion checks");
  } else {
    const usersRes = await fetchJson("/users", token);
    const allUsers = usersRes.body?.data || [];
    const inactiveInDirectory = allUsers.some(
      (row) => row.employee_code === inactiveCode
    );
    if (inactiveInDirectory) {
      pass("inactive employee still listed on GET /users (User Management)");
    } else {
      fail("inactive employee still listed on GET /users (User Management)");
    }

    const dropdown = await fetchJson("/interviewer-dropdown", token);
    const inDropdown = (dropdown.body?.data || []).some(
      (row) =>
        row.employee_code === inactiveCode || row.user_id === inactiveUserId
    );
    if (!inDropdown) {
      pass("inactive excluded from /interviewer-dropdown");
    } else {
      fail("inactive excluded from /interviewer-dropdown", inactiveCode);
    }

    const activeInterviewers = await fetchJson("/active-interviewers", token);
    const inActiveInterviewers = (activeInterviewers.body?.data || []).some(
      (row) => row.employee_code === inactiveCode
    );
    if (!inActiveInterviewers) {
      pass("inactive excluded from /active-interviewers");
    } else {
      fail("inactive excluded from /active-interviewers", inactiveCode);
    }

    const formRecruiters = await fetchJson(
      "/api/v1/recruitment/form-options/recruiters",
      token
    );
    const inRecruiters = (formRecruiters.body?.data || []).some(
      (row) => row.employee_code === inactiveCode
    );
    if (!inRecruiters) {
      pass("inactive excluded from form-options/recruiters");
    } else {
      fail("inactive excluded from form-options/recruiters", inactiveCode);
    }
  }

  console.log(`\nDone: ${passCount} passed, ${failCount} failed`);
  await pool.end();
  if (failCount > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
