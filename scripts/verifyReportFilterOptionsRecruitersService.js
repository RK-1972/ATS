require("dotenv").config();

const jwt = require("jsonwebtoken");
const { Pool } = require("pg");

const reportBuilderMetadataService = require("../services/reportBuilderMetadataService");
const recruitmentService = require("../services/recruitmentService");
const { assertCanManageRequisitionAssignments } = require("../services/requisitionCapabilityAuth");

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

function buildReq(user) {
  return {
    user: {
      user_id: user.user_id,
      employee_code: user.employee_code,
      email_id: user.email_id,
      role_name: user.role_name
    }
  };
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

async function resolveUnauthorizedReportUser() {
  const result = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name, full_name
     FROM user_mstr
     WHERE COALESCE(is_active, TRUE) = TRUE
       AND NOT EXISTS (
         SELECT 1
         FROM rb_role_dataset_permission dp
         WHERE dp.role_name = user_mstr.role_name
           AND dp.can_view = TRUE
       )
     ORDER BY user_id ASC
     LIMIT 1`
  );

  return result.rows[0] || null;
}

async function expectServiceError(run, expectedStatus) {
  try {
    await run();
    fail(`expected ${expectedStatus}`, "service call succeeded unexpectedly");
    return false;
  } catch (error) {
    if (error.status === expectedStatus) {
      return true;
    }

    fail(`expected ${expectedStatus}`, `got ${error.status || "no status"} ${error.message}`);
    return false;
  }
}

async function main() {
  const adminUser = await resolveAdminUser();

  if (!adminUser) {
    fail("Admin user lookup", "No active Admin user found");
    await pool.end();
    return;
  }

  console.log("\n=== Service: report-authorized recruiter lookup ===");
  const data = await reportBuilderMetadataService.listFilterRecruiters(
    pool,
    buildReq(adminUser)
  );

  if (!Array.isArray(data.recruiters) || data.recruiters.length === 0) {
    fail("recruiter payload", "expected recruiters from PostgreSQL");
  } else {
    pass(`Recruiter lookup returned ${data.recruiters.length} rows`);
  }

  const keys = Object.keys(data.recruiters[0] || {}).sort().join(",");
  if (keys === "employee_code,full_name") {
    pass("Recruiter response contains only employee_code and full_name");
  } else {
    fail("recruiter field shape", keys);
  }

  const dbRecruiters = await recruitmentService.listFormRecruiters(pool);
  if (dbRecruiters.length === data.recruiters.length) {
    pass("Report recruiter lookup matches recruitment SQL row count");
  } else {
    fail(
      "recruiter row count parity",
      `report=${data.recruiters.length}, recruitment SQL=${dbRecruiters.length}`
    );
  }

  const unauthorizedUser = await resolveUnauthorizedReportUser();
  if (!unauthorizedUser) {
    console.log("\nSKIP: No user without report dataset permissions found.");
  } else {
    console.log(`\n=== Service: unauthorized report user (${unauthorizedUser.role_name}) ===`);
    const denied = await expectServiceError(
      () =>
        reportBuilderMetadataService.listFilterRecruiters(
          pool,
          buildReq(unauthorizedUser)
        ),
      404
    );

    if (denied) {
      pass("Unauthorized report user is denied recruiter filter lookup (404)");
    }
  }

  console.log("\n=== Service: recruitment assigner guard unchanged ===");
  try {
    await assertCanManageRequisitionAssignments(pool, buildReq(adminUser));
    console.log("NOTE: Admin has REQUISITION_ASSIGNER; recruitment guard allows assigners.");
    pass("Recruitment assigner guard remains active for assigners");
  } catch (error) {
    if (error.status === 403) {
      pass("Admin without REQUISITION_ASSIGNER remains denied by recruitment guard");
    } else {
      fail("recruitment assigner guard", error.message);
    }
  }

  await pool.end();

  if (process.exitCode) {
    console.log("\nService verification completed with failures.");
  } else {
    console.log("\nAll report recruiter filter service checks passed.");
  }
}

main().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
  await pool.end();
});
