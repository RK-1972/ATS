/**
 * Phase 4B — HM identity binding + my-hm-requisitions verification.
 * Run: node scripts/verifyPhase4bHmIdentityRequisitions.js
 */
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const hiringManagerIdentityService = require("../services/hiringManagerIdentityService");
const recruitmentService = require("../services/recruitmentService");

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

async function ensureMigrationApplied() {
  const columnCheck = await pool.query(
    `SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'hiring_manager_mstr'
        AND column_name = 'employee_code'
    ) AS exists`
  );

  if (columnCheck.rows[0]?.exists) {
    pass("hiring_manager_mstr.employee_code column exists");
    return;
  }

  const migrationPath = path.join(
    __dirname,
    "..",
    "migrations",
    "049_hiring_manager_employee_code_binding.sql"
  );
  const sql = fs.readFileSync(migrationPath, "utf8");
  await pool.query(sql);
  pass("applied migration 049_hiring_manager_employee_code_binding.sql");
}

async function resolveUserByRole(roleName) {
  const result = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name
     FROM user_mstr
     WHERE role_name = $1 AND COALESCE(is_active, TRUE) = TRUE
     ORDER BY user_id ASC`,
    [roleName]
  );

  return result.rows;
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
  console.log("=== Phase 4B HM Identity + Requisitions ===\n");

  await ensureMigrationApplied();

  const hmUsers = await resolveUserByRole("Hiring Manager");
  const recruiters = await resolveUserByRole("Recruiter");
  const admins = await resolveUserByRole("Admin");

  if (hmUsers.length < 2) {
    fail("fixtures", "at least two Hiring Manager users required");
    await pool.end();
    return;
  }

  const recruiter = recruiters[0];
  const admin = admins[0];

  const boundHmRows = await pool.query(
    `SELECT hm.hiring_manager_id, hm.employee_code, hm.hiring_manager_name, hm.email_id
     FROM hiring_manager_mstr hm
     WHERE hm.is_active = TRUE
       AND hm.employee_code IS NOT NULL`
  );

  if (boundHmRows.rows.length === 0) {
    fail("HM employee_code backfill", "no active hiring_manager_mstr rows with employee_code");
  } else {
    pass(`HM employee_code backfill (${boundHmRows.rows.length} bound master row(s))`);
  }

  const primaryHmUser =
    hmUsers.find((user) =>
      boundHmRows.rows.some((row) => row.employee_code === user.employee_code)
    ) || hmUsers[0];
  const otherHmUser =
    hmUsers.find((user) => user.employee_code !== primaryHmUser.employee_code) ||
    hmUsers[1];
  const otherBoundHmUser = hmUsers.find(
    (user) =>
      user.employee_code !== primaryHmUser.employee_code &&
      boundHmRows.rows.some((row) => row.employee_code === user.employee_code)
  );

  const primaryBinding = await hiringManagerIdentityService.resolveBoundHiringManager(
    pool,
    { user: primaryHmUser }
  );
  pass(
    `service resolves HM binding for ${primaryHmUser.employee_code} -> ${primaryBinding.hiring_manager_code}`
  );

  const primaryRows = await hiringManagerIdentityService.listMyHmRequisitions(
    pool,
    { user: primaryHmUser }
  );

  if (primaryRows.length > 0) {
    pass(`primary HM sees ${primaryRows.length} requisition(s)`);
  } else {
    skip("primary HM requisition visibility", "no rm_requisitions matched bound HM");
  }

  const primaryCodes = new Set(primaryRows.map((row) => row.requisition_code));

  if (otherBoundHmUser) {
    const otherRows = await hiringManagerIdentityService.listMyHmRequisitions(
      pool,
      { user: otherBoundHmUser }
    );
    const leaked = otherRows.filter((row) => primaryCodes.has(row.requisition_code));

    if (leaked.length > 0) {
      fail(
        "other bound HM cannot see primary HM requisitions",
        `overlap=${leaked.map((row) => row.requisition_code).join(", ")}`
      );
    } else {
      pass("other bound HM cannot see primary HM requisitions");
    }
  } else {
    try {
      await hiringManagerIdentityService.listMyHmRequisitions(pool, {
        user: otherHmUser
      });
      fail("unbound HM user rejected", "expected throw");
    } catch (error) {
      if (error.status === 403) {
        pass(`unbound HM user rejected without master binding (403, ${otherHmUser.employee_code})`);
      } else {
        fail("unbound HM user rejected", `status=${error.status}`);
      }
    }
  }

  const dbForeign = await pool.query(
    `SELECT requisition_code
     FROM rm_requisitions
     WHERE hiring_manager_id IS NOT NULL
       AND hiring_manager_id <> $1
     LIMIT 1`,
    [primaryBinding.hiring_manager_id]
  );

  if (otherBoundHmUser && dbForeign.rows[0]) {
    const otherRows = await hiringManagerIdentityService.listMyHmRequisitions(
      pool,
      { user: otherBoundHmUser }
    );

    if (otherRows.some(
      (row) => row.requisition_code === dbForeign.rows[0].requisition_code
    )) {
      fail("other HM scoped to own requisitions only");
    } else {
      pass("other HM scoped to own requisitions only");
    }
  } else {
    skip("other HM scoped to own requisitions only", "no second bound HM fixture");
  }

  if (recruiter) {
    try {
      await hiringManagerIdentityService.listMyHmRequisitions(pool, {
        user: recruiter
      });
      fail("recruiter rejected without HM binding", "expected throw");
    } catch (error) {
      if (error.status === 403) {
        pass("recruiter rejected without HM binding (403)");
      } else {
        fail("recruiter rejected without HM binding", `status=${error.status}`);
      }
    }
  } else {
    skip("recruiter rejection", "no recruiter user");
  }

  if (admin) {
    try {
      await hiringManagerIdentityService.listMyHmRequisitions(pool, {
        user: admin
      });
      fail("unbound admin rejected", "expected throw");
    } catch (error) {
      if (error.status === 403) {
        pass("unbound admin rejected from HM requisition list (403)");
      } else {
        fail("unbound admin rejected", `status=${error.status}`);
      }
    }

    const adminDashboard = await recruitmentService.getMyRecruiterDashboard(pool, {
      user: admin
    });
    if (adminDashboard && typeof adminDashboard === "object") {
      pass("admin recruiter dashboard path still callable");
    } else {
      fail("admin recruiter dashboard path still callable");
    }
  } else {
    skip("admin unaffected checks", "no admin user");
  }

  const primaryToken = signToken(primaryHmUser);
  const otherHttpUser = otherBoundHmUser || otherHmUser;
  const otherToken = signToken(otherHttpUser);
  const recruiterToken = recruiter ? signToken(recruiter) : null;

  const primaryHttp = await fetchJson(
    "/api/v1/recruitment/my-hm-requisitions",
    primaryToken
  );

  if (primaryHttp.status === 200 && Array.isArray(primaryHttp.body?.data)) {
    pass(`HTTP primary HM my-hm-requisitions (200, count=${primaryHttp.body.data.length})`);
  } else {
    fail("HTTP primary HM my-hm-requisitions", `status=${primaryHttp.status}`);
  }

  if (recruiterToken) {
    const recruiterHttp = await fetchJson(
      "/api/v1/recruitment/my-hm-requisitions",
      recruiterToken
    );
    if (recruiterHttp.status === 403) {
      pass("HTTP recruiter denied (403)");
    } else {
      fail("HTTP recruiter denied", `status=${recruiterHttp.status}`);
    }
  }

  const otherHttp = await fetchJson(
    "/api/v1/recruitment/my-hm-requisitions",
    otherToken
  );

  if (otherBoundHmUser) {
    if (otherHttp.status === 200 && Array.isArray(otherHttp.body?.data)) {
      const overlap = otherHttp.body.data.filter((row) =>
        primaryCodes.has(row.requisition_code)
      );
      if (overlap.length > 0) {
        fail("HTTP other HM overlap with primary HM", overlap[0].requisition_code);
      } else {
        pass("HTTP other bound HM list does not overlap primary HM requisitions");
      }
    } else {
      fail("HTTP other bound HM my-hm-requisitions", `status=${otherHttp.status}`);
    }
  } else if (otherHttp.status === 403) {
    pass(`HTTP unbound HM denied (403, ${otherHttpUser.employee_code})`);
  } else {
    fail("HTTP unbound HM denied", `status=${otherHttp.status}`);
  }

  if (process.exitCode) {
    console.log("\nPhase 4B HM verification completed with failures.");
  } else {
    console.log("\nAll Phase 4B HM checks passed.");
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
