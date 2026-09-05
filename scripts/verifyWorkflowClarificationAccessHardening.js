require("dotenv").config();

const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const workflowService = require("../services/workflowService");

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
    headers
  });

  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

async function resolveUserByRole(roleName) {
  const result = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name, secondary_role, full_name
     FROM user_mstr
     WHERE role_name = $1 AND COALESCE(is_active, TRUE) = TRUE
     ORDER BY user_id ASC
     LIMIT 1`,
    [roleName]
  );
  return result.rows[0] || null;
}

async function resolveUserByEmployeeCode(employeeCode) {
  const result = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name, secondary_role, full_name
     FROM user_mstr
     WHERE employee_code = $1
     LIMIT 1`,
    [employeeCode]
  );
  return result.rows[0] || null;
}

async function findPausedClarificationFixture() {
  const result = await pool.query(
    `SELECT instance_id, status, started_by, execution_context, instance_payload
     FROM wf_instances
     WHERE status = 'Paused'
       AND execution_context->'clarification'->>'task_id' IS NOT NULL
     ORDER BY modified_on DESC
     LIMIT 1`
  );
  return result.rows[0] || null;
}

async function findLegacyRunningFixture() {
  const result = await pool.query(
    `SELECT instance_id, status, started_by, execution_context, instance_payload
     FROM wf_instances
     WHERE status = 'Running'
     ORDER BY modified_on DESC
     LIMIT 1`
  );
  return result.rows[0] || null;
}

function parseContext(raw) {
  if (raw && typeof raw === "object") {
    return raw;
  }
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return {};
}

async function snapshotInstanceState(instanceId) {
  const instance = await pool.query(
    `SELECT status, execution_context, instance_payload, modified_on
     FROM wf_instances WHERE instance_id = $1`,
    [instanceId]
  );
  const history = await pool.query(
    `SELECT COUNT(*)::int AS c FROM wf_history WHERE instance_id = $1`,
    [instanceId]
  );
  const tasks = await pool.query(
    `SELECT task_id, status FROM wf_tasks WHERE instance_id = $1 ORDER BY task_id`,
    [instanceId]
  );

  const row = instance.rows[0] || {};
  const payload = parseContext(row.instance_payload);
  const timelineLen = Array.isArray(payload.timeline) ? payload.timeline.length : 0;

  return {
    status: row.status,
    timelineLen,
    historyCount: history.rows[0]?.c || 0,
    tasks: tasks.rows,
    modifiedOn: row.modified_on
  };
}

async function main() {
  console.log("=== Workflow Clarification Access Hardening (P1-6) ===\n");

  const admin = await resolveUserByRole("Admin");
  const recruiter = await resolveUserByRole("Recruiter");

  if (!admin || !recruiter) {
    fail("fixtures", "Admin and Recruiter users required");
    await pool.end();
    return;
  }

  const pausedFixture = await findPausedClarificationFixture();
  const legacyFixture = await findLegacyRunningFixture();

  if (pausedFixture) {
    const hold = parseContext(pausedFixture.execution_context).clarification || {};
    console.log(
      `Paused fixture: ${pausedFixture.instance_id} requestor=${hold.requestor_employee_code || "n/a"}`
    );
  } else {
    console.log("SKIP: no paused clarification workflow fixture");
  }

  if (legacyFixture) {
    console.log(`Legacy fixture: ${legacyFixture.instance_id} started_by=${legacyFixture.started_by}`);
  }

  const tokens = {
    admin: signToken(admin),
    recruiter: signToken(recruiter)
  };

  console.log("\n--- Service layer ---");

  try {
    await workflowService.submitClarification(
      pool,
      "WF-NONEXISTENT-INSTANCE",
      "probe",
      { user: recruiter }
    );
    fail("Service: fake instance", "expected throw");
  } catch (error) {
    if (error.status === 404) {
      pass("Service: nonexistent instance returns 404");
    } else {
      fail("Service: fake instance", `expected 404, got ${error.status}`);
    }
  }

  if (pausedFixture) {
    const hold = parseContext(pausedFixture.execution_context).clarification || {};
    const requestor = hold.requestor_employee_code
      ? await resolveUserByEmployeeCode(hold.requestor_employee_code)
      : null;

    if (requestor) {
      try {
        await workflowService.assertClarificationSubmitAuthorized(
          pool,
          { user: requestor },
          pausedFixture,
          { clarificationHold: hold }
        );
        pass("Service: authorized requestor passes clarification auth");
      } catch (error) {
        fail("Service: requestor auth", `${error.status} ${error.message}`);
      }
    } else {
      console.log("SKIP: paused fixture missing requestor_employee_code");
    }

    try {
      await workflowService.assertClarificationSubmitAuthorized(
        pool,
        { user: recruiter },
        pausedFixture,
        { clarificationHold: hold }
      );
      fail("Service: recruiter paused assert", "expected throw");
    } catch (error) {
      if (error.status === 403) {
        pass("Service: unauthorized user denied on paused instance");
      } else {
        fail("Service: recruiter paused assert", `expected 403, got ${error.status}`);
      }
    }

    try {
      await workflowService.assertClarificationSubmitAuthorized(
        pool,
        { user: admin },
        pausedFixture,
        { clarificationHold: hold }
      );
      pass("Service: Admin allowed per existing workflow clarification rule");
    } catch (error) {
      fail("Service: admin paused auth", `${error.status} ${error.message}`);
    }

    const before = await snapshotInstanceState(pausedFixture.instance_id);

    try {
      await workflowService.submitClarification(
        pool,
        pausedFixture.instance_id,
        "unauthorized probe — should not persist",
        { user: recruiter }
      );
      fail("Service: unauthorized paused submit", "expected throw before mutation");
    } catch (error) {
      if (error.status === 403) {
        pass("Service: unauthorized paused submit blocked (403)");
      } else {
        fail("Service: unauthorized paused submit", `expected 403, got ${error.status}`);
      }
    }

    const after = await snapshotInstanceState(pausedFixture.instance_id);
    if (
      before.status === after.status
      && before.timelineLen === after.timelineLen
      && before.historyCount === after.historyCount
      && JSON.stringify(before.tasks) === JSON.stringify(after.tasks)
    ) {
      pass("Service: unauthorized paused submit did not mutate workflow state");
    } else {
      fail(
        "Service: paused workflow mutated",
        `status ${before.status}->${after.status} timeline ${before.timelineLen}->${after.timelineLen}`
      );
    }
  }

  if (legacyFixture) {
    try {
      await workflowService.assertClarificationSubmitAuthorized(
        pool,
        { user: recruiter },
        legacyFixture
      );
      fail("Service: recruiter legacy assert", "expected throw");
    } catch (error) {
      if (error.status === 403) {
        pass("Service: unauthorized user denied on legacy running instance");
      } else {
        fail("Service: recruiter legacy assert", `expected 403, got ${error.status}`);
      }
    }

    const before = await snapshotInstanceState(legacyFixture.instance_id);

    try {
      await workflowService.submitClarification(
        pool,
        legacyFixture.instance_id,
        "legacy unauthorized probe",
        { user: recruiter }
      );
      fail("Service: unauthorized legacy submit", "expected throw");
    } catch (error) {
      if (error.status === 403) {
        pass("Service: unauthorized legacy submit blocked (403)");
      } else {
        fail("Service: unauthorized legacy submit", `expected 403, got ${error.status}`);
      }
    }

    const after = await snapshotInstanceState(legacyFixture.instance_id);
    if (
      before.status === after.status
      && before.timelineLen === after.timelineLen
      && before.historyCount === after.historyCount
    ) {
      pass("Service: unauthorized legacy submit did not mutate workflow state");
    } else {
      fail("Service: legacy workflow mutated after blocked submit");
    }
  }

  console.log("\n--- HTTP layer (requires restarted backend) ---");

  if (pausedFixture) {
    const blocked = await fetchJson(
      `/api/v1/workflows/instances/${pausedFixture.instance_id}/submit-clarification`,
      tokens.recruiter,
      {
        method: "POST",
        body: JSON.stringify({ comments: "http unauthorized probe" })
      }
    );

    if (blocked.status === 403) {
      pass("HTTP: unauthorized submit-clarification blocked on paused instance");
    } else {
      fail("HTTP: unauthorized paused submit", `expected 403, got ${blocked.status}`);
    }
  }

  const fakeHttp = await fetchJson(
    "/api/v1/workflows/instances/WF-NONEXISTENT-INSTANCE/submit-clarification",
    tokens.admin,
    {
      method: "POST",
      body: JSON.stringify({ comments: "probe" })
    }
  );

  if (fakeHttp.status === 404) {
    pass("HTTP: nonexistent instance returns 404");
  } else {
    fail("HTTP: fake instance", `expected 404, got ${fakeHttp.status}`);
  }

  await pool.end();

  if (process.exitCode) {
    console.log("\nWorkflow clarification access hardening verification completed with failures.");
  } else {
    console.log("\nAll workflow clarification access hardening checks passed.");
  }
}

main().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
  await pool.end();
});
