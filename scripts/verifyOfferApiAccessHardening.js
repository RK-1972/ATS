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
      role_name: user.role_name,
      secondary_role: user.secondary_role || null
    },
    process.env.JWT_SECRET,
    { expiresIn: "1h" }
  );
}

async function fetchJson(path, token, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
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

async function resolveOfferWorkspaceUser() {
  const result = await pool.query(
    `SELECT u.user_id, u.employee_code, u.email_id, u.role_name, u.secondary_role
     FROM user_mstr u
     INNER JOIN employee_work_assignment ewa
       ON ewa.employee_code = u.employee_code
      AND ewa.is_active = TRUE
     INNER JOIN work_assignment_mstr wam
       ON wam.work_assignment_id = ewa.work_assignment_id
      AND wam.is_active = TRUE
     WHERE TRIM(COALESCE(wam.workspace_flag, '')) = 'showOfferWorkspace'
       AND COALESCE(u.is_active, TRUE) = TRUE
     ORDER BY u.user_id ASC
     LIMIT 1`
  );
  return result.rows[0] || null;
}

async function resolveRecruiterWithoutOfferWorkspace() {
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
          AND wam.is_active = TRUE
         WHERE ewa.employee_code = u.employee_code
           AND ewa.is_active = TRUE
           AND TRIM(COALESCE(wam.workspace_flag, '')) = 'showOfferWorkspace'
       )
     ORDER BY u.user_id ASC
     LIMIT 1`
  );
  return result.rows[0] || null;
}

async function employeeHasOfferWorkspace(employeeCode) {
  const result = await pool.query(
    `SELECT 1
     FROM employee_work_assignment ewa
     INNER JOIN work_assignment_mstr wam
       ON wam.work_assignment_id = ewa.work_assignment_id
      AND wam.is_active = TRUE
     WHERE ewa.employee_code = $1
       AND ewa.is_active = TRUE
       AND TRIM(COALESCE(wam.workspace_flag, '')) = 'showOfferWorkspace'
     LIMIT 1`,
    [employeeCode]
  );
  return result.rows.length > 0;
}

async function main() {
  console.log("=== Offer API Access Hardening (P2-4) ===\n");

  const authorizedUser = await resolveOfferWorkspaceUser();
  const unauthorizedRecruiter = await resolveRecruiterWithoutOfferWorkspace();
  const admin = await resolveUserByRole("Admin");

  if (!authorizedUser) {
    fail("fixtures", "user with showOfferWorkspace assignment required");
    await pool.end();
    return;
  }

  if (!unauthorizedRecruiter) {
    fail("fixtures", "Recruiter without showOfferWorkspace required");
    await pool.end();
    return;
  }

  const authorizedToken = signToken(authorizedUser);
  const unauthorizedToken = signToken(unauthorizedRecruiter);
  const adminToken = admin ? signToken(admin) : null;

  const authorizedList = await fetchJson("/api/v1/offers", authorizedToken);
  if (authorizedList.status === 200) {
    pass(
      `HTTP: authorized Offer user can list offers (200) — ${authorizedUser.employee_code}`
    );
  } else {
    fail(
      "HTTP: authorized Offer user list offers",
      `status=${authorizedList.status} body=${JSON.stringify(authorizedList.body)}`
    );
  }

  const unauthorizedList = await fetchJson("/api/v1/offers", unauthorizedToken);
  if (unauthorizedList.status === 403) {
    pass(
      `HTTP: recruiter without Offer capability denied (403) — ${unauthorizedRecruiter.employee_code}`
    );
  } else {
    fail(
      "HTTP: unauthorized recruiter list offers",
      `expected 403, got ${unauthorizedList.status}`
    );
  }

  if (admin && adminToken) {
    const adminHasOffer = await employeeHasOfferWorkspace(admin.employee_code);
    const adminList = await fetchJson("/api/v1/offers", adminToken);

    if (adminHasOffer) {
      if (adminList.status === 200) {
        pass(`HTTP: Admin with showOfferWorkspace can list offers (200) — ${admin.employee_code}`);
      } else {
        fail("HTTP: Admin with showOfferWorkspace", `status=${adminList.status}`);
      }
    } else if (adminList.status === 403) {
      pass(
        `HTTP: Admin without showOfferWorkspace denied like other users (403) — ${admin.employee_code}`
      );
    } else {
      fail(
        "HTTP: Admin without showOfferWorkspace",
        `expected 403, got ${adminList.status}`
      );
    }
  } else {
    console.log("SKIP: no Admin fixture for Admin behavior check");
  }

  const offerId =
    authorizedList.body?.offers?.[0]?.offer_id
    || authorizedList.body?.data?.offers?.[0]?.offer_id
    || null;

  if (offerId) {
    const unauthorizedDetail = await fetchJson(
      `/api/v1/offers/${offerId}`,
      unauthorizedToken
    );
    if (unauthorizedDetail.status === 403) {
      pass("HTTP: unauthorized user denied offer detail (403)");
    } else {
      fail(
        "HTTP: unauthorized offer detail",
        `expected 403, got ${unauthorizedDetail.status}`
      );
    }
  } else {
    console.log("SKIP: no offer fixture for detail denial test");
  }

  await pool.end();

  if (process.exitCode) {
    console.log("\nOffer API access hardening verification completed with failures.");
  } else {
    console.log("\nAll offer API access hardening checks passed.");
  }
}

main().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
  await pool.end();
});
