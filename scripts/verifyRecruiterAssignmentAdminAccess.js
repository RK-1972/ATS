/**
 * Verifies Admin + REQUISITION_ASSIGNER access to Recruiter Assignment list APIs.
 * Run: node scripts/verifyRecruiterAssignmentAdminAccess.js
 */
require("dotenv").config();

const jwt = require("jsonwebtoken");
const { Pool } = require("pg");

const REQUISITION_ASSIGNER_CODE = "REQUISITION_ASSIGNER";

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

function resolveBackendApiBaseUrl() {
  if (process.env.BACKEND_API_URL) {
    return String(process.env.BACKEND_API_URL).replace(/\/$/, "");
  }

  const configured = String(process.env.API_BASE_URL || "").trim();
  if (configured.includes(":5000")) {
    return configured.replace(/\/$/, "");
  }

  return "http://localhost:5000";
}

const API_BASE_URL = resolveBackendApiBaseUrl();

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
  const rawText = await response.text();
  let body = {};

  try {
    body = JSON.parse(rawText);
  } catch (_error) {
    body = {};
  }

  return { response, body, rawText };
}

async function resolveAdminWithoutAssigner() {
  const result = await pool.query(
    `SELECT u.user_id, u.employee_code, u.email_id, u.role_name, u.secondary_role
     FROM user_mstr u
     WHERE u.role_name = 'Admin'
       AND COALESCE(u.is_active, TRUE) = TRUE
       AND NOT EXISTS (
         SELECT 1
         FROM employee_work_assignment ewa
         INNER JOIN work_assignment_mstr wam
           ON wam.work_assignment_id = ewa.work_assignment_id
          AND wam.assignment_code = $1
          AND COALESCE(wam.is_active, TRUE) = TRUE
         WHERE ewa.employee_code = u.employee_code
           AND COALESCE(ewa.is_active, TRUE) = TRUE
       )
     ORDER BY u.user_id ASC
     LIMIT 1`,
    [REQUISITION_ASSIGNER_CODE]
  );

  return result.rows[0] || null;
}

async function resolveAssignerUser() {
  const result = await pool.query(
    `SELECT u.user_id, u.employee_code, u.email_id, u.role_name, u.secondary_role
     FROM user_mstr u
     INNER JOIN employee_work_assignment ewa
       ON ewa.employee_code = u.employee_code
      AND COALESCE(ewa.is_active, TRUE) = TRUE
     INNER JOIN work_assignment_mstr wam
       ON wam.work_assignment_id = ewa.work_assignment_id
      AND wam.assignment_code = $1
      AND COALESCE(wam.is_active, TRUE) = TRUE
     WHERE COALESCE(u.is_active, TRUE) = TRUE
     ORDER BY u.user_id ASC
     LIMIT 1`,
    [REQUISITION_ASSIGNER_CODE]
  );

  return result.rows[0] || null;
}

async function resolveUnauthorizedRecruiter() {
  const result = await pool.query(
    `SELECT u.user_id, u.employee_code, u.email_id, u.role_name, u.secondary_role
     FROM user_mstr u
     WHERE u.role_name = 'Recruiter'
       AND COALESCE(u.is_active, TRUE) = TRUE
       AND NOT EXISTS (
         SELECT 1
         FROM employee_work_assignment ewa
         INNER JOIN work_assignment_mstr wam
           ON wam.work_assignment_id = ewa.work_assignment_id
          AND wam.assignment_code = $1
          AND COALESCE(wam.is_active, TRUE) = TRUE
         WHERE ewa.employee_code = u.employee_code
           AND COALESCE(ewa.is_active, TRUE) = TRUE
       )
     ORDER BY u.user_id ASC
     LIMIT 1`,
    [REQUISITION_ASSIGNER_CODE]
  );

  return result.rows[0] || null;
}

async function main() {
  const admin = await resolveAdminWithoutAssigner();
  const assigner = await resolveAssignerUser();
  const recruiter = await resolveUnauthorizedRecruiter();

  if (!admin) {
    skip("admin without assigner scenarios", "no matching admin user");
  } else {
    const adminToken = signToken(admin);
    const list = await fetchJson("/api/v1/recruitment/requisitions", adminToken);
    const recruiters = await fetchJson(
      "/api/v1/recruitment/form-options/recruiters",
      adminToken
    );

    if (list.response.status !== 200) {
      fail("admin can list management requisitions", String(list.response.status));
    } else {
      pass("admin can list management requisitions");
    }

    if (!Array.isArray(list.body.data)) {
      fail("admin list response data is array");
    } else if (list.body.data.length === 0) {
      fail("admin list returns approved requisitions");
    } else {
      pass(`admin list returns approved requisitions (${list.body.data.length})`);
    }

    const req1210 = (list.body.data || []).find(
      (row) => row.requisition_code === "REQ-2026-1210"
    );

    if (!req1210) {
      fail("admin list includes REQ-2026-1210");
    } else {
      pass("admin list includes REQ-2026-1210");
    }

    if (req1210?.candidate_portal_published) {
      fail("REQ-2026-1210 candidate_portal_published is false");
    } else {
      pass("REQ-2026-1210 candidate portal status is not published");
    }

    if (recruiters.response.status !== 200) {
      fail("admin can load recruiter form options", String(recruiters.response.status));
    } else {
      pass("admin can load recruiter form options");
    }
  }

  if (!assigner) {
    skip("assigner scenarios", "no REQUISITION_ASSIGNER user");
  } else {
    const assignerToken = signToken(assigner);
    const list = await fetchJson("/api/v1/recruitment/requisitions", assignerToken);

    if (list.response.status !== 200) {
      fail("assigner can list management requisitions", String(list.response.status));
    } else {
      pass("assigner can list management requisitions");
    }
  }

  if (!recruiter) {
    skip("unauthorized recruiter scenarios", "no recruiter without assigner");
  } else {
    const recruiterToken = signToken(recruiter);
    const list = await fetchJson("/api/v1/recruitment/requisitions", recruiterToken);

    if (list.response.status !== 403) {
      fail("unauthorized recruiter blocked", String(list.response.status));
    } else {
      pass("unauthorized recruiter blocked");
    }
  }

  console.log("Recruiter Assignment Admin access verification finished.");
  await pool.end();
}

main().catch(async (error) => {
  fail("unexpected error", error.message);
  await pool.end();
});
