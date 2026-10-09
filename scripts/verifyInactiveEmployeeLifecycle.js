/**
 * Verification for inactive employee read-only lifecycle guards.
 * Run: node scripts/verifyInactiveEmployeeLifecycle.js
 * Requires: DB env, API_BASE_URL (optional), JWT_SECRET, backend running for HTTP tests.
 */
require("dotenv").config();

const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const userProvisioningService = require("../services/userProvisioningService");
const workAssignmentService = require("../services/workAssignmentService");
const { assertEmployeeAccountActive } = require("../middleware/activeEmployeeAuth");

const API_BASE_URL = process.env.API_BASE_URL || "http://localhost:5000";

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

const FIXTURE_CODE = "INACTIVE_LC_VERIFY";
const FIXTURE_EMAIL = "inactive_lc_verify@optalynx.local";

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

async function fetchJson(path, token, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {})
  };
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

async function resolveAdmin() {
  const result = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name, secondary_role, full_name
     FROM user_mstr
     WHERE role_name = 'Admin' AND COALESCE(is_active, TRUE) = TRUE
     ORDER BY user_id
     LIMIT 1`
  );
  return result.rows[0] || null;
}

async function cleanupFixture() {
  await pool.query(`DELETE FROM user_status_history WHERE employee_code = $1`, [
    FIXTURE_CODE
  ]);
  await pool.query(`DELETE FROM user_role_history WHERE employee_code = $1`, [
    FIXTURE_CODE
  ]);
  await pool.query(
    `DELETE FROM employee_work_assignment WHERE employee_code = $1`,
    [FIXTURE_CODE]
  );
  await pool.query(`DELETE FROM user_mstr WHERE employee_code = $1`, [
    FIXTURE_CODE
  ]);
}

async function ensureInactiveFixture(adminReq) {
  await cleanupFixture();
  const bcrypt = require("bcryptjs");
  const hash = await bcrypt.hash("VerifyPass1!", 10);
  const insert = await pool.query(
    `INSERT INTO user_mstr (
       employee_code, full_name, email_id, password_hash, role_name, is_active
     ) VALUES ($1, $2, $3, $4, 'Recruiter', FALSE)
     RETURNING user_id, employee_code, email_id, role_name, is_active`,
    [FIXTURE_CODE, "Inactive LC Verify", FIXTURE_EMAIL, hash]
  );
  const user = insert.rows[0];

  const wa = await pool.query(
    `SELECT work_assignment_id FROM work_assignment_mstr
     WHERE is_active = TRUE ORDER BY work_assignment_id LIMIT 1`
  );
  if (wa.rows[0]) {
    await pool.query(
      `INSERT INTO employee_work_assignment (
         employee_code, work_assignment_id, effective_from, is_active
       ) VALUES ($1, $2, CURRENT_DATE, FALSE)`,
      [FIXTURE_CODE, wa.rows[0].work_assignment_id]
    );
  }

  return user;
}

async function runServiceTests(admin) {
  const adminReq = { user: admin };
  const user = await ensureInactiveFixture(adminReq);

  try {
    await userProvisioningService.updateUserProfile(pool, adminReq, FIXTURE_CODE, {
      full_name: "Hacked Name"
    });
    fail("inactive profile update rejected (service)");
  } catch (error) {
    if (error.status === 403) {
      pass("inactive profile update rejected (service)");
    } else {
      fail("inactive profile update rejected (service)", error.message);
    }
  }

  try {
    await userProvisioningService.changePrimaryRole(pool, adminReq, FIXTURE_CODE, {
      role_name: "Interviewer",
      reason: "test"
    });
    fail("inactive role change rejected (service)");
  } catch (error) {
    if (error.status === 403) {
      pass("inactive role change rejected (service)");
    } else {
      fail("inactive role change rejected (service)", error.message);
    }
  }

  const ewa = await pool.query(
    `SELECT employee_work_assignment_id FROM employee_work_assignment
     WHERE employee_code = $1 LIMIT 1`,
    [FIXTURE_CODE]
  );
  if (ewa.rows[0]) {
    try {
      await workAssignmentService.removeEmployeeWorkAssignment(
        pool,
        ewa.rows[0].employee_work_assignment_id
      );
      fail("inactive work assignment remove rejected (service)");
    } catch (error) {
      if (error.status === 403) {
        pass("inactive work assignment remove rejected (service)");
      } else {
        fail("inactive work assignment remove rejected (service)", error.message);
      }
    }
  } else {
    pass("inactive work assignment remove rejected (service) — skip no row");
  }

  const wa = await pool.query(
    `SELECT work_assignment_id FROM work_assignment_mstr
     WHERE is_active = TRUE ORDER BY work_assignment_id LIMIT 1`
  );
  if (wa.rows[0]) {
    try {
      await workAssignmentService.assignWorkAssignment(
        pool,
        FIXTURE_CODE,
        wa.rows[0].work_assignment_id,
        null,
        null
      );
      fail("assign-to-inactive still rejected (service)");
    } catch (error) {
      if (error.status === 400) {
        pass("assign-to-inactive still rejected (service)");
      } else {
        fail("assign-to-inactive still rejected (service)", error.message);
      }
    }
  }

  try {
    await userProvisioningService.changeUserStatus(pool, adminReq, FIXTURE_CODE, {
      is_active: true
    });
    fail("reactivation without reason rejected (service)");
  } catch (error) {
    if (error.status === 400) {
      pass("reactivation without reason rejected (service)");
    } else {
      fail("reactivation without reason rejected (service)", error.message);
    }
  }

  const reactivated = await userProvisioningService.changeUserStatus(
    pool,
    adminReq,
    FIXTURE_CODE,
    { is_active: true, reason: "Lifecycle verification reactivation" }
  );
  if (reactivated.user?.is_active === true) {
    pass("reactivation with reason succeeds (service)");
  } else {
    fail("reactivation with reason succeeds (service)");
  }

  const suspended = await pool.query(
    `SELECT COUNT(*)::int AS n FROM employee_work_assignment
     WHERE employee_code = $1 AND is_active = FALSE`,
    [FIXTURE_CODE]
  );
  if (suspended.rows[0].n > 0) {
    pass("work assignments remain suspended after reactivation");
  } else {
    fail("work assignments remain suspended after reactivation");
  }

  await pool.query(
    `UPDATE user_mstr SET is_active = FALSE WHERE employee_code = $1`,
    [FIXTURE_CODE]
  );

  const activeUser = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name, is_active
     FROM user_mstr WHERE employee_code = $1`,
    [FIXTURE_CODE]
  );
  await pool.query(
    `UPDATE user_mstr SET is_active = TRUE, full_name = $2 WHERE employee_code = $1`,
    [FIXTURE_CODE, "Inactive LC Verify Active"]
  );

  try {
    await userProvisioningService.updateUserProfile(pool, adminReq, FIXTURE_CODE, {
      full_name: "Inactive LC Verify Active Edited"
    });
    pass("active profile edit works (service)");
  } catch (error) {
    fail("active profile edit works (service)", error.message);
  }

  await pool.query(
    `UPDATE user_mstr SET is_active = FALSE WHERE employee_code = $1`,
    [FIXTURE_CODE]
  );

  return { user: activeUser.rows[0] };
}

async function runHttpTests(admin, inactiveUser) {
  const adminToken = signToken(admin);

  const profilePut = await fetchJson(
    `/users/${encodeURIComponent(FIXTURE_CODE)}`,
    adminToken,
    {
      method: "PUT",
      body: { full_name: "HTTP Hack" }
    }
  );
  if (profilePut.status === 403) {
    pass("inactive profile update rejected (HTTP)");
  } else {
    fail("inactive profile update rejected (HTTP)", String(profilePut.status));
  }

  const rolePost = await fetchJson(
    `/users/${encodeURIComponent(FIXTURE_CODE)}/primary-role`,
    adminToken,
    {
      method: "POST",
      body: { role_name: "Interviewer", reason: "x" }
    }
  );
  if (rolePost.status === 403) {
    pass("inactive role change rejected (HTTP)");
  } else {
    fail("inactive role change rejected (HTTP)", String(rolePost.status));
  }

  const activateNoReason = await fetchJson(
    `/users/${encodeURIComponent(FIXTURE_CODE)}/activate`,
    adminToken,
    { method: "POST", body: {} }
  );
  if (activateNoReason.status === 400) {
    pass("reactivation without reason rejected (HTTP)");
  } else {
    fail("reactivation without reason rejected (HTTP)", String(activateNoReason.status));
  }

  const activateOk = await fetchJson(
    `/users/${encodeURIComponent(FIXTURE_CODE)}/activate`,
    adminToken,
    {
      method: "POST",
      body: { reason: "HTTP verification reactivation" }
    }
  );
  if (activateOk.status === 200 && activateOk.body?.data?.user?.is_active === true) {
    pass("reactivation with reason succeeds (HTTP)");
  } else {
    fail("reactivation with reason succeeds (HTTP)", String(activateOk.status));
  }

  const forgot = await fetchJson("/forgot-password", null, {
    method: "POST",
    body: { email_id: FIXTURE_EMAIL }
  });
  await pool.query(
    `UPDATE user_mstr SET is_active = FALSE WHERE employee_code = $1`,
    [FIXTURE_CODE]
  );
  const forgotInactive = await fetchJson("/forgot-password", null, {
    method: "POST",
    body: { email_id: FIXTURE_EMAIL }
  });
  if (forgotInactive.status === 403) {
    pass("inactive forgot password blocked (HTTP)");
  } else {
    fail("inactive forgot password blocked (HTTP)", String(forgotInactive.status));
  }

  if (inactiveUser?.user_id) {
    const inactiveToken = signToken({
      ...inactiveUser,
      is_active: false
    });
    const guard = await assertEmployeeAccountActive(pool, inactiveUser);
    if (guard === false) {
      pass("inactive account guard (service)");
    } else {
      fail("inactive account guard (service)");
    }
    const api = await fetchJson("/users", inactiveToken);
    if (api.status === 403) {
      pass("inactive token blocked from API (HTTP)");
    } else if (api.status === 200) {
      fail("inactive token blocked from API (HTTP) — restart backend?");
    } else {
      fail("inactive token blocked from API (HTTP)", String(api.status));
    }
  }

  const loginInactive = await fetchJson("/login", null, {
    method: "POST",
    body: { email_id: FIXTURE_EMAIL, password: "VerifyPass1!" }
  });
  if (loginInactive.status === 403) {
    pass("inactive login rejected (HTTP)");
  } else {
    fail("inactive login rejected (HTTP)", String(loginInactive.status));
  }
}

async function main() {
  if (!process.env.JWT_SECRET) {
    fail("JWT_SECRET configured");
    process.exit(1);
  }

  const admin = await resolveAdmin();
  if (!admin) {
    fail("resolve admin user");
    process.exit(1);
  }

  try {
    const { user } = await runServiceTests(admin);
    try {
      await runHttpTests(admin, user);
    } catch (httpError) {
      console.log(
        "SKIP: HTTP tests — ensure backend is running at",
        API_BASE_URL,
        httpError.message
      );
    }
  } finally {
    await cleanupFixture();
    await pool.end();
  }

  console.log(`\nDone: ${passCount} passed, ${failCount} failed`);
  if (failCount > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
