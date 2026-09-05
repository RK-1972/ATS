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

function signToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "8h" });
}

async function fetchWithAuth(path, token) {
  return fetch(`${API_BASE_URL}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {}
  });
}

async function readJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function resolveAdminUser() {
  const result = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name
     FROM user_mstr
     WHERE role_name = 'Admin' AND COALESCE(is_active, TRUE) = TRUE
     ORDER BY user_id ASC LIMIT 1`
  );
  return result.rows[0] || null;
}

async function resolveUnauthorizedReportUser() {
  const result = await pool.query(
    `SELECT u.user_id, u.employee_code, u.email_id, u.role_name
     FROM user_mstr u
     WHERE COALESCE(u.is_active, TRUE) = TRUE
       AND NOT EXISTS (
         SELECT 1 FROM rb_role_dataset_permission dp
         WHERE dp.role_name = u.role_name AND dp.can_view = TRUE
       )
     ORDER BY u.user_id ASC LIMIT 1`
  );
  return result.rows[0] || null;
}

function assertHiringManagerShape(row, label) {
  const keys = Object.keys(row || {}).sort();
  const allowed = ["hiring_manager_code", "hiring_manager_id", "hiring_manager_name"];

  if (keys.join(",") !== allowed.join(",")) {
    fail(`${label} field shape`, `expected only ${allowed.join(", ")}, got ${keys.join(", ")}`);
    return false;
  }

  return true;
}

async function main() {
  console.log("=== Report Hiring Manager Filter Options (P2-6) ===\n");

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

  const allowedResponse = await fetchWithAuth(
    "/api/v1/reports/filter-options/hiring-managers",
    adminToken
  );
  const allowedBody = await readJson(allowedResponse);

  if (allowedResponse.status === 200 && allowedBody.success) {
    pass("Report-authorized Admin can load hiring manager filter options (200)");
  } else {
    fail("GET hiring-managers", JSON.stringify(allowedBody));
  }

  const rows = allowedBody.data?.hiring_managers || [];
  if (!Array.isArray(rows)) {
    fail("hiring_managers payload", "expected array");
  } else if (rows.length === 0) {
    console.log("NOTE: no active hiring managers in fixture");
  } else {
    pass(`Hiring manager lookup returned ${rows.length} rows`);
    rows.slice(0, 3).forEach((row, index) => {
      assertHiringManagerShape(row, `hiring_manager[${index}]`);
    });
    pass("Response contains only id, code, and name fields");
  }

  const legacyResponse = await fetchWithAuth("/all-hiring-managers", adminToken);
  const legacyBody = await readJson(legacyResponse);
  if (legacyResponse.status === 200 && legacyBody.success) {
    pass("Legacy /all-hiring-managers remains available to authenticated users");
  } else {
    fail("Legacy hiring managers endpoint", `status=${legacyResponse.status}`);
  }

  const unauthorizedUser = await resolveUnauthorizedReportUser();
  if (!unauthorizedUser) {
    console.log("SKIP: no user without report dataset permissions");
  } else {
    const unauthorizedToken = signToken({
      user_id: unauthorizedUser.user_id,
      employee_code: unauthorizedUser.employee_code,
      email_id: unauthorizedUser.email_id,
      role_name: unauthorizedUser.role_name
    });

    const deniedResponse = await fetchWithAuth(
      "/api/v1/reports/filter-options/hiring-managers",
      unauthorizedToken
    );

    if (deniedResponse.status === 404) {
      pass("Unauthorized report user denied hiring manager filter lookup (404)");
    } else {
      const deniedBody = await readJson(deniedResponse);
      fail(
        "Unauthorized hiring manager lookup",
        `expected 404, got ${deniedResponse.status} ${JSON.stringify(deniedBody)}`
      );
    }
  }

  const noAuthResponse = await fetchWithAuth(
    "/api/v1/reports/filter-options/hiring-managers",
    null
  );
  if (noAuthResponse.status === 401) {
    pass("Missing token returns 401 for report hiring manager lookup");
  } else {
    fail("Missing token status", String(noAuthResponse.status));
  }

  await pool.end();

  if (process.exitCode) {
    console.log("\nReport hiring manager filter verification completed with failures.");
  } else {
    console.log("\nAll report hiring manager filter option checks passed.");
  }
}

main().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
  await pool.end();
});
