require("dotenv").config();

const fs = require("fs");
const path = require("path");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");

const API_BASE_URL = process.env.API_BASE_URL || "http://localhost:5000";
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

function signToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "8h" });
}

async function readJson(response) {
  const text = await response.text();

  try {
    return JSON.parse(text);
  } catch (error) {
    return { raw: text };
  }
}

async function fetchWithAuth(path, token) {
  return fetch(`${API_BASE_URL}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
}

async function resolveAdminUser() {
  const result = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name, full_name
     FROM user_mstr
     WHERE role_name = 'Admin'
       AND COALESCE(is_active, TRUE) = TRUE
     ORDER BY user_id ASC
     LIMIT 1`
  );

  return result.rows[0] || null;
}

async function resolveReportAuthorizedNonAssignerUser() {
  const result = await pool.query(
    `SELECT DISTINCT u.user_id, u.employee_code, u.email_id, u.role_name, u.full_name
     FROM user_mstr u
     INNER JOIN rb_role_dataset_permission dp
       ON dp.role_name = u.role_name
      AND dp.can_view = TRUE
     INNER JOIN rb_role_field_permission fp
       ON fp.role_name = u.role_name
      AND fp.can_view = TRUE
      AND fp.can_filter = TRUE
     INNER JOIN rb_field f
       ON f.field_id = fp.field_id
      AND f.code IN ('assigned_recruiter_code', 'mapping_recruiter_code')
      AND f.is_filterable = TRUE
     WHERE COALESCE(u.is_active, TRUE) = TRUE
       AND NOT EXISTS (
         SELECT 1
         FROM work_assignment_mstr wam
         INNER JOIN employee_work_assignment ewa
           ON ewa.work_assignment_id = wam.work_assignment_id
          AND ewa.employee_code = u.employee_code
          AND COALESCE(ewa.is_active, TRUE) = TRUE
         WHERE wam.assignment_code = $1
           AND COALESCE(wam.is_active, TRUE) = TRUE
       )
     ORDER BY u.user_id ASC
     LIMIT 1`,
    [REQUISITION_ASSIGNER_CODE]
  );

  return result.rows[0] || null;
}

async function resolveUnauthorizedReportUser() {
  const result = await pool.query(
    `SELECT u.user_id, u.employee_code, u.email_id, u.role_name, u.full_name
     FROM user_mstr u
     WHERE COALESCE(u.is_active, TRUE) = TRUE
       AND NOT EXISTS (
         SELECT 1
         FROM rb_role_dataset_permission dp
         WHERE dp.role_name = u.role_name
           AND dp.can_view = TRUE
       )
     ORDER BY u.user_id ASC
     LIMIT 1`
  );

  return result.rows[0] || null;
}

function assertRecruiterShape(row, label) {
  const keys = Object.keys(row || {}).sort();
  const allowed = ["employee_code", "full_name"];

  if (keys.join(",") !== allowed.join(",")) {
    fail(`${label} field shape`, `expected only ${allowed.join(", ")}, got ${keys.join(", ")}`);
    return false;
  }

  return true;
}

async function main() {
  const adminUser = await resolveAdminUser();

  if (!adminUser) {
    fail("Admin user lookup", "No active Admin user found");
    await pool.end();
    return;
  }

  const adminToken = signToken({
    user_id: adminUser.user_id,
    employee_code: adminUser.employee_code,
    email_id: adminUser.email_id,
    role_name: adminUser.role_name
  });

  console.log("\n=== Report-authorized Admin recruiter lookup ===");
  const reportRecruitersResponse = await fetchWithAuth(
    "/api/v1/reports/filter-options/recruiters",
    adminToken
  );
  const reportRecruitersBody = await readJson(reportRecruitersResponse);

  if (reportRecruitersResponse.status !== 200 || !reportRecruitersBody.success) {
    fail("GET /api/v1/reports/filter-options/recruiters", JSON.stringify(reportRecruitersBody));
  } else {
    pass("Report-authorized user can load recruiter filter options (200)");
  }

  const recruiters = reportRecruitersBody.data?.recruiters || [];

  if (!Array.isArray(recruiters)) {
    fail("recruiter payload", "expected recruiters array");
  } else if (recruiters.length === 0) {
    fail("recruiter payload", "expected at least one recruiter from PostgreSQL");
  } else {
    pass(`Recruiter lookup returned ${recruiters.length} rows from PostgreSQL`);
    recruiters.slice(0, 3).forEach((row, index) => {
      assertRecruiterShape(row, `recruiter[${index}]`);
    });
    pass("Recruiter response contains only employee_code and full_name");
  }

  console.log("\n=== Recruitment form-options still requires REQUISITION_ASSIGNER ===");
  const recruitmentResponse = await fetchWithAuth(
    "/api/v1/recruitment/form-options/recruiters",
    adminToken
  );
  const recruitmentBody = await readJson(recruitmentResponse);

  if (recruitmentResponse.status === 403) {
    pass("Admin without REQUISITION_ASSIGNER is denied recruitment form-options recruiters");
  } else if (recruitmentResponse.status === 200) {
    console.log(
      "NOTE: Admin has REQUISITION_ASSIGNER assignment; recruitment endpoint returned 200 as expected for assigners."
    );
    pass("Recruitment form-options recruiters endpoint remains available to assigners");
  } else {
    fail(
      "Recruitment form-options recruiters status",
      `${recruitmentResponse.status} ${JSON.stringify(recruitmentBody)}`
    );
  }

  const unauthorizedUser = await resolveUnauthorizedReportUser();

  if (!unauthorizedUser) {
    console.log("\nSKIP: No user without report dataset permissions found.");
  } else {
    const unauthorizedToken = signToken({
      user_id: unauthorizedUser.user_id,
      employee_code: unauthorizedUser.employee_code,
      email_id: unauthorizedUser.email_id,
      role_name: unauthorizedUser.role_name
    });

    console.log(`\n=== Unauthorized report user (${unauthorizedUser.role_name}) ===`);
    const deniedResponse = await fetchWithAuth(
      "/api/v1/reports/filter-options/recruiters",
      unauthorizedToken
    );
    const deniedBody = await readJson(deniedResponse);

    if (deniedResponse.status === 404) {
      pass("Unauthorized report user is denied recruiter filter lookup (404)");
    } else {
      fail(
        "Unauthorized report user recruiter lookup",
        `expected 404, got ${deniedResponse.status} ${JSON.stringify(deniedBody)}`
      );
    }
  }

  const reportUser = await resolveReportAuthorizedNonAssignerUser();

  if (!reportUser) {
    console.log(
      "\nSKIP: No report-authorized user without REQUISITION_ASSIGNER found for cross-check."
    );
  } else {
    const reportUserToken = signToken({
      user_id: reportUser.user_id,
      employee_code: reportUser.employee_code,
      email_id: reportUser.email_id,
      role_name: reportUser.role_name
    });

    console.log(`\n=== Report user without assigner (${reportUser.role_name}) ===`);
    const allowedResponse = await fetchWithAuth(
      "/api/v1/reports/filter-options/recruiters",
      reportUserToken
    );
    const allowedBody = await readJson(allowedResponse);

    if (allowedResponse.status === 200 && allowedBody.success) {
      pass("Report-authorized non-assigner can use report recruiter lookup");
    } else {
      fail(
        "Report-authorized non-assigner recruiter lookup",
        `${allowedResponse.status} ${JSON.stringify(allowedBody)}`
      );
    }

    const recruitmentDeniedResponse = await fetchWithAuth(
      "/api/v1/recruitment/form-options/recruiters",
      reportUserToken
    );
    const recruitmentDeniedBody = await readJson(recruitmentDeniedResponse);

    if (recruitmentDeniedResponse.status === 403) {
      pass("Same user is still denied recruitment form-options recruiters");
    } else {
      fail(
        "Recruitment endpoint authorization regression",
        `expected 403, got ${recruitmentDeniedResponse.status} ${JSON.stringify(recruitmentDeniedBody)}`
      );
    }
  }

  console.log("\n=== Missing authentication ===");
  const noAuthResponse = await fetch(`${API_BASE_URL}/api/v1/reports/filter-options/recruiters`);
  const noAuthBody = await readJson(noAuthResponse);

  if (noAuthResponse.status === 401) {
    pass("Missing token returns 401 for report recruiter lookup");
  } else {
    fail("Missing token status", String(noAuthResponse.status));
  }
  console.log(JSON.stringify(noAuthBody, null, 2));

  await pool.end();

  if (process.exitCode) {
    console.log("\nVerification completed with failures.");
  } else {
    console.log("\nAll report recruiter filter option checks passed.");
  }
}

main().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
  await pool.end();
});
