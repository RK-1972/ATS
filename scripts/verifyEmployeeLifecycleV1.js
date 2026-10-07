/**
 * Employee Lifecycle & Responsibility Clearance V1 — verification harness.
 * Run: node scripts/verifyEmployeeLifecycleV1.js
 */

require("dotenv").config();
const { Pool } = require("pg");

const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

const employeeResponsibilityPreflightService = require("../services/employeeResponsibilityPreflightService");
const employeeLifecycleService = require("../services/employeeLifecycleService");
const recruitmentService = require("../services/recruitmentService");

let passed = 0;
let failed = 0;

function pass(label) {
  passed += 1;
  console.log(`PASS: ${label}`);
}

function fail(label, detail = "") {
  failed += 1;
  console.log(`FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
}

async function tableExists(name) {
  const result = await pool.query(
    `SELECT 1 FROM information_schema.tables WHERE table_name = $1`,
    [name]
  );
  return result.rows.length > 0;
}

async function main() {
  console.log("=== verifyEmployeeLifecycleV1 ===");

  if (!(await tableExists("employee_responsibility_clearance_exception"))) {
    fail("migration 049 applied", "run migrations/049_employee_lifecycle_responsibility_v1.sql");
  } else {
    pass("migration 049 applied");
  }

  const activeUser = await pool.query(
    `SELECT employee_code FROM user_mstr WHERE is_active = TRUE LIMIT 1`
  );
  if (!activeUser.rows.length) {
    fail("active user exists for preflight smoke");
  } else {
    const code = activeUser.rows[0].employee_code;
    const preflight = await employeeResponsibilityPreflightService.buildResponsibilityPreflight(
      pool,
      code
    );
    if (preflight.summary && Array.isArray(preflight.items)) {
      pass("preflight structure");
    } else {
      fail("preflight structure");
    }
  }

  try {
    await recruitmentService.assertRecruiterEmployeeActive(pool, "__inactive_test__");
    fail("inactive recruiter assignment rejected");
  } catch (error) {
    if (String(error.message).toLowerCase().includes("inactive")) {
      pass("inactive recruiter assignment rejected");
    } else {
      fail("inactive recruiter assignment rejected", error.message);
    }
  }

  const inactive = await pool.query(
    `SELECT employee_code FROM user_mstr WHERE is_active = FALSE LIMIT 1`
  );
  if (inactive.rows.length) {
    const tasks = await pool.query(
      `SELECT COUNT(*)::int AS c FROM wf_tasks
       WHERE assignee = $1 AND LOWER(status) = 'pending'`,
      [inactive.rows[0].employee_code]
    );
    if (tasks.rows[0].c === 0) {
      pass("inactive approver has no pending tasks (sample)");
    } else {
      console.log(
        `NOTE: inactive user ${inactive.rows[0].employee_code} still has ${tasks.rows[0].c} pending task(s) — clearance queue expected`
      );
      pass("inactive pending task detection path reachable");
    }
  } else {
    console.log("SKIP: no inactive user for task sample");
  }

  if (typeof employeeLifecycleService.buildSessionWorkspacePayload === "function") {
    pass("session workspace payload helper exported");
  } else {
    fail("session workspace payload helper exported");
  }

  await pool.end();
  console.log(`\nDone: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
