/**
 * Dual-submit concurrency check for Budget Request workflow task creation.
 * Simulates Tab A + Tab B submitting the same Draft simultaneously.
 */
require("dotenv").config();

const { Pool } = require("pg");
const workforcePlanningService = require("../services/workforcePlanningService");

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

function mockReq(employeeCode, roleName = "Admin") {
  return {
    user: {
      employee_code: employeeCode,
      role_name: roleName,
      email_id: "concurrency-verify@optalynx.local"
    }
  };
}

async function pickCriteria(client) {
  const route = await client.query(
    `SELECT r.route_id, r.route_name, r.applies_to
     FROM approval_route_mstr r
     WHERE LOWER(TRIM(r.status)) = 'active'
       AND (
         LOWER(TRIM(r.applies_to)) LIKE '%budget%'
         OR UPPER(SPLIT_PART(REGEXP_REPLACE(TRIM(r.applies_to), '[^A-Za-z0-9]+', '_', 'g'), '_', 1)) = 'BUDGET'
       )
     ORDER BY r.route_id
     LIMIT 1`
  );

  if (!route.rows[0]) {
    throw new Error("No active BUDGET approval route found for verification.");
  }

  const steps = await client.query(
    `SELECT sequence_no, approver_employee_code
     FROM approval_route_step
     WHERE route_id = $1
     ORDER BY sequence_no`,
    [route.rows[0].route_id]
  );

  if (steps.rows.length < 2) {
    throw new Error(
      `Route ${route.rows[0].route_id} needs at least 2 steps for L1/L2 verification.`
    );
  }

  const policy = await client.query(
    `SELECT policy_id, department, designation, grade, min_amount, max_amount
     FROM approval_route_policy
     WHERE route_id = $1 AND is_active = TRUE
     ORDER BY policy_id
     LIMIT 1`,
    [route.rows[0].route_id]
  );

  const dept = await client.query(
    `SELECT name FROM md_records
     WHERE entity_type = 'departments' AND is_deleted = FALSE
     ORDER BY id LIMIT 1`
  );
  const desig = await client.query(
    `SELECT name FROM md_records
     WHERE entity_type = 'designations' AND is_deleted = FALSE
     ORDER BY id LIMIT 1`
  );
  const grade = await client.query(
    `SELECT COALESCE(code, name) AS grade_value FROM md_records
     WHERE entity_type = 'grades' AND is_deleted = FALSE
     ORDER BY id LIMIT 1`
  );

  const p = policy.rows[0] || {};
  return {
    route_id: route.rows[0].route_id,
    route_name: route.rows[0].route_name,
    policy_id: p.policy_id || null,
    department: p.department || dept.rows[0]?.name,
    position: p.designation || desig.rows[0]?.name,
    grade: p.grade || grade.rows[0]?.grade_value,
    proposed_budget:
      p.min_amount != null ? Number(p.min_amount) : 500000,
    step_count: steps.rows.length
  };
}

async function main() {
  const client = await pool.connect();
  try {
    const admin = await client.query(
      `SELECT employee_code, role_name
       FROM user_mstr
       WHERE LOWER(TRIM(role_name)) = 'admin'
         AND is_active = TRUE
       ORDER BY user_id
       LIMIT 1`
    );

    if (!admin.rows[0]) {
      throw new Error("No active Admin user found.");
    }

    const req = mockReq(admin.rows[0].employee_code, admin.rows[0].role_name);
    const criteria = await pickCriteria(client);

    console.log("Criteria:", criteria);

    const created = await workforcePlanningService.createBudgetRequest(
      pool,
      {
        department: criteria.department,
        position: criteria.position,
        grade: criteria.grade,
        headcount: 1,
        proposed_budget: criteria.proposed_budget,
        justification: "Concurrency verification draft — dual tab submit.",
        priority: "Medium"
      },
      req
    );

    const requestId = created.request.id;
    const instanceId = `WF-BR-${requestId}`;
    console.log(`Created Draft ${requestId}; expecting instance ${instanceId}`);

    const [a, b] = await Promise.allSettled([
      workforcePlanningService.submitBudgetRequest(pool, requestId, req),
      workforcePlanningService.submitBudgetRequest(pool, requestId, req)
    ]);

    const outcomes = { a, b };
    for (const [label, result] of Object.entries(outcomes)) {
      if (result.status === "fulfilled") {
        console.log(
          `Tab ${label.toUpperCase()}: SUCCESS — status=${result.value.request?.status}`
        );
      } else {
        console.log(
          `Tab ${label.toUpperCase()}: ${result.reason?.statusCode || "ERR"} — ${result.reason?.message}`
        );
      }
    }

    const instances = await client.query(
      `SELECT instance_id, status
       FROM wf_instances
       WHERE instance_id = $1`,
      [instanceId]
    );

    const routeTasks = await client.query(
      `SELECT task_id, title, status, assignee
       FROM wf_tasks
       WHERE instance_id = $1
         AND task_type = 'approval'
         AND title LIKE 'Approval Step %'
       ORDER BY task_id`,
      [instanceId]
    );

    const state = await client.query(
      `SELECT draft_payload FROM wp_config_state WHERE id = 1`
    );
    const draft = state.rows[0].draft_payload;
    const budget = (draft.budget_requests || []).find((x) => x.id === requestId);
    const queue = (draft.approval_queue || []).find((x) => x.id === requestId);

    const successCount = [a, b].filter((r) => r.status === "fulfilled").length;
    const conflictCount = [a, b].filter(
      (r) =>
        r.status === "rejected"
        && (r.reason?.statusCode === 409
          || /already been submitted|already has a workflow/i.test(
            r.reason?.message || ""
          ))
    ).length;

    const l1 = routeTasks.rows.filter((t) => /Approval Step 1/.test(t.title));
    const l2 = routeTasks.rows.filter((t) => /Approval Step 2/.test(t.title));

    const checks = {
      oneSuccessOneConflict: successCount === 1 && conflictCount === 1,
      oneInstance: instances.rows.length === 1,
      oneL1: l1.length === 1,
      oneL2: l2.length === 1,
      budgetSubmittedOnce:
        budget?.status === "Pending Level-1 Approval"
        && budget?.workflow_instance_id === instanceId,
      policyAuditCaptured: Boolean(
        budget?.approval_policy_id
          || budget?.approval_policy_snapshot
          || queue?.approval_policy_id
          || queue?.approval_policy_snapshot
      )
    };

    console.log("\n--- Counts ---");
    console.log("Instances:", instances.rows.length, instances.rows);
    console.log("Route tasks:", routeTasks.rows.length);
    routeTasks.rows.forEach((t) =>
      console.log(`  ${t.task_id} | ${t.title} | ${t.status} | ${t.assignee}`)
    );
    console.log("Budget status:", budget?.status);
    console.log("Budget workflow_instance_id:", budget?.workflow_instance_id);
    console.log("approval_policy_id:", budget?.approval_policy_id || queue?.approval_policy_id);
    console.log(
      "approval_policy_snapshot:",
      Boolean(budget?.approval_policy_snapshot || queue?.approval_policy_snapshot)
    );

    console.log("\n--- Checks ---");
    let allPass = true;
    for (const [name, ok] of Object.entries(checks)) {
      console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
      if (!ok) allPass = false;
    }

    if (!allPass) {
      process.exitCode = 1;
      console.log("\nRESULT: NOT READY — concurrency defect not fully resolved.");
    } else {
      console.log("\nRESULT: READY FOR USER REVIEW");
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Verification failed:", err);
  process.exit(1);
});
