/**
 * Budget Approval clarification loop verification.
 * Validates approver ↔ initiator loop without restarting the approval chain.
 */
require("dotenv").config();
const { Pool } = require("pg");
const workforcePlanningService = require("../services/workforcePlanningService");
const workflowService = require("../services/workflowService");

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

function mockReq(employeeCode, roleName = "Admin", fullName = null) {
  return {
    user: {
      employee_code: employeeCode,
      role_name: roleName,
      email_id: `${String(employeeCode).toLowerCase()}@optalynx.local`,
      full_name: fullName || employeeCode
    }
  };
}

async function getBudget(client, requestId) {
  const state = await client.query(
    `SELECT draft_payload FROM wp_config_state WHERE id = 1`
  );
  const draft = state.rows[0].draft_payload;
  return {
    request: (draft.budget_requests || []).find((item) => item.id === requestId),
    queue: (draft.approval_queue || []).find((item) => item.id === requestId),
    positions: draft.approved_positions || []
  };
}

async function countTasks(client, instanceId) {
  const result = await client.query(
    `SELECT task_id, title, status, task_type, assignee
     FROM wf_tasks WHERE instance_id = $1 ORDER BY task_id`,
    [instanceId]
  );
  return result.rows;
}

async function countActivePendingApprovers(client, instanceId) {
  const result = await client.query(
    `SELECT COUNT(*)::int AS count
     FROM wf_assignments a
     INNER JOIN wf_tasks t ON t.task_id = a.task_id
     WHERE t.instance_id = $1
       AND a.active = TRUE
       AND LOWER(t.status) = 'pending'
       AND LOWER(COALESCE(t.task_type, 'approval')) IN ('approval', 'approve')`,
    [instanceId]
  );
  return result.rows[0]?.count || 0;
}

async function historyEvents(client, instanceId) {
  const result = await client.query(
    `SELECT event_type, action, comments, recorded_on
     FROM wf_history
     WHERE instance_id = $1
     ORDER BY recorded_on ASC, history_id ASC`,
    [instanceId]
  );
  return result.rows;
}

async function myActiveApprovalTaskIds(pool, employeeCode) {
  const rows = await workflowService.getMyActiveApprovals(
    pool,
    mockReq(employeeCode, "Approver")
  );
  return rows.map((row) => String(row.task_id));
}

async function ensureTwoStepRoute(client) {
  const route = await client.query(
    `SELECT r.route_id
     FROM approval_route_mstr r
     WHERE LOWER(TRIM(r.status)) = 'active'
       AND (
         LOWER(TRIM(r.applies_to)) LIKE '%budget%'
         OR UPPER(SPLIT_PART(REGEXP_REPLACE(TRIM(r.applies_to), '[^A-Za-z0-9]+', '_', 'g'), '_', 1)) = 'BUDGET'
       )
     ORDER BY r.route_id LIMIT 1`
  );
  if (!route.rows[0]) {
    throw new Error("No active BUDGET approval route found.");
  }

  const steps = await client.query(
    `SELECT sequence_no, approver_employee_code
     FROM approval_route_step WHERE route_id = $1 ORDER BY sequence_no`,
    [route.rows[0].route_id]
  );

  if (steps.rows.length < 2) {
    const secondApprover = await client.query(
      `SELECT employee_code FROM user_mstr
       WHERE is_active = TRUE
         AND employee_code IS NOT NULL
         AND employee_code <> $1
       ORDER BY user_id
       LIMIT 1`,
      [steps.rows[0]?.approver_employee_code || ""]
    );
    if (!secondApprover.rows[0]) {
      throw new Error("Need a second employee for L2 step verification.");
    }
    await client.query(
      `INSERT INTO approval_route_step (
         route_id, step_no, approver_employee_code, approval_type,
         comments_required, allow_reject, allow_return, stop_if_rejected, sequence_no
       ) VALUES ($1, 2, $2, 'Approver', FALSE, TRUE, TRUE, TRUE, 2)`,
      [route.rows[0].route_id, secondApprover.rows[0].employee_code]
    );
  }

  const refreshed = await client.query(
    `SELECT sequence_no, approver_employee_code
     FROM approval_route_step WHERE route_id = $1 ORDER BY sequence_no`,
    [route.rows[0].route_id]
  );

  return {
    l1: String(refreshed.rows[0].approver_employee_code).trim(),
    l2: String(refreshed.rows[1].approver_employee_code).trim()
  };
}

async function buildCriteria(client, routeId) {
  const policy = await client.query(
    `SELECT department, designation, grade, min_amount
     FROM approval_route_policy
     WHERE route_id = $1 AND is_active = TRUE
     ORDER BY policy_id LIMIT 1`,
    [routeId]
  );
  const dept = await client.query(
    `SELECT name FROM md_records WHERE entity_type='departments' AND is_deleted=FALSE ORDER BY id LIMIT 1`
  );
  const desig = await client.query(
    `SELECT name FROM md_records WHERE entity_type='designations' AND is_deleted=FALSE ORDER BY id LIMIT 1`
  );
  const grade = await client.query(
    `SELECT COALESCE(code,name) AS v FROM md_records WHERE entity_type='grades' AND is_deleted=FALSE ORDER BY id LIMIT 1`
  );

  return {
    department: policy.rows[0]?.department || dept.rows[0].name,
    position: policy.rows[0]?.designation || desig.rows[0].name,
    grade: policy.rows[0]?.grade || grade.rows[0].v,
    proposed_budget:
      policy.rows[0]?.min_amount != null ? Number(policy.rows[0].min_amount) : 500000,
    headcount: 1,
    justification: "Budget clarification verification.",
    priority: "Medium"
  };
}

async function createSubmittedBudget(pool, client, criteria, requestorReq) {
  const created = await workforcePlanningService.createBudgetRequest(
    pool,
    criteria,
    requestorReq
  );
  const requestId = created.request.id;
  const instanceId = `WF-BR-${requestId}`;
  await workforcePlanningService.submitBudgetRequest(pool, requestId, requestorReq);
  const snap = await getBudget(client, requestId);
  return {
    requestId,
    instanceId,
    routeSnap: JSON.stringify(snap.queue?.approval_route_snapshot || null),
    policySnap: JSON.stringify(snap.queue?.approval_policy_snapshot || null)
  };
}

async function main() {
  const client = await pool.connect();
  const checks = [];
  const failures = [];

  const pass = (label, ok) => {
    checks.push({ label, ok });
    if (!ok) failures.push(label);
  };

  try {
    const route = await client.query(
      `SELECT route_id FROM approval_route_mstr
       WHERE LOWER(TRIM(status)) = 'active'
         AND LOWER(TRIM(applies_to)) LIKE '%budget%'
       ORDER BY route_id LIMIT 1`
    );
    const { l1, l2 } = await ensureTwoStepRoute(client);

    const admin = await client.query(
      `SELECT employee_code, role_name FROM user_mstr
       WHERE LOWER(TRIM(role_name))='admin' AND is_active=TRUE ORDER BY user_id LIMIT 1`
    );
    const requestorReq = mockReq(admin.rows[0].employee_code, admin.rows[0].role_name);
    const criteria = await buildCriteria(client, route.rows[0].route_id);

    // --- Scenario A: L1 clarify → initiator → L1 again ---
    const budgetA = await createSubmittedBudget(pool, client, {
      ...criteria,
      justification: "Scenario A — L1 clarify loop."
    }, requestorReq);

    try {
      await workforcePlanningService.requestBudgetClarification(
        pool,
        budgetA.requestId,
        "",
        mockReq(l1, "Approver", "L1 Approver")
      );
      pass("Clarify requires a comment", false);
    } catch (error) {
      pass("Clarify requires a comment", error.status === 400);
    }

    await workforcePlanningService.requestBudgetClarification(
      pool,
      budgetA.requestId,
      "Please revise headcount justification.",
      mockReq(l1, "Approver", "L1 Approver")
    );

    let snap = await getBudget(client, budgetA.requestId);
    let tasks = await countTasks(client, budgetA.instanceId);
    const l1Task = tasks.find((t) => /Approval Step 1/.test(t.title || ""));
    const l2TaskWaiting = tasks.find((t) => /Approval Step 2/.test(t.title || ""));

    pass("L1 clarify sets Clarification Requested", snap.request?.status === "Clarification Requested");
    pass("L1 clarify pauses workflow", (await client.query(
      `SELECT status FROM wf_instances WHERE instance_id = $1`,
      [budgetA.instanceId]
    )).rows[0]?.status === "Paused");
    pass("L1 clarify does not activate L2", String(l2TaskWaiting?.status).toLowerCase() !== "pending");
    pass("L1 approver task held for clarification", String(l1Task?.status).toLowerCase() === "waiting for clarification");
    pass("No active pending approver during clarify", (await countActivePendingApprovers(client, budgetA.instanceId)) === 0);

    const l1MyApprovalsDuringClarify = await myActiveApprovalTaskIds(pool, l1);
    pass("L1 absent from My Approvals during clarify", !l1MyApprovalsDuringClarify.includes(String(l1Task?.task_id)));

    await workforcePlanningService.createBudgetRequest(
      pool,
      { id: budgetA.requestId, ...criteria, justification: "Scenario A — clarified." },
      requestorReq
    );
    await workforcePlanningService.submitBudgetClarification(
      pool,
      budgetA.requestId,
      "Updated justification provided.",
      requestorReq
    );

    snap = await getBudget(client, budgetA.requestId);
    tasks = await countTasks(client, budgetA.instanceId);
    const l1Restored = tasks.find((t) => /Approval Step 1/.test(t.title || ""));

    pass("Same workflow instance after L1 clarify response", snap.request?.workflow_instance_id === budgetA.instanceId);
    pass("Same approval route after L1 clarify response", JSON.stringify(snap.queue?.approval_route_snapshot || null) === budgetA.routeSnap);
    pass("L1 clarify returns to L1", snap.request?.status === "Pending Level-1 Approval");
    pass("L1 task restored to Pending", String(l1Restored?.status).toLowerCase() === "pending" && String(l1Restored?.assignee) === l1);
    pass("Only one active pending approver after resume", (await countActivePendingApprovers(client, budgetA.instanceId)) === 1);

    const l1MyApprovalsAfterResume = await myActiveApprovalTaskIds(pool, l1);
    pass("L1 reappears in My Approvals after response", l1MyApprovalsAfterResume.includes(String(l1Restored?.task_id)));

    const historyA = await historyEvents(client, budgetA.instanceId);
    pass("wf_history contains ClarificationRequested", historyA.some((e) => e.event_type === "ClarificationRequested"));
    pass("wf_history contains ClarificationSubmitted", historyA.some((e) => e.event_type === "ClarificationSubmitted"));
    pass("wf_history contains ClarificationResumed", historyA.some((e) => e.event_type === "ClarificationResumed"));
    pass("Clarification timestamps present", historyA.some((e) => e.event_type === "ClarificationRequested" && e.recorded_on));

    const contextA = await workforcePlanningService.getBudgetApprovalActionContext(
      pool,
      budgetA.requestId,
      requestorReq
    );
    pass("Inspector exposes clarification rounds", Array.isArray(contextA.clarification_rounds) && contextA.clarification_rounds.length >= 1);
    pass("Inspector turnaround calculable", Boolean(contextA.clarification_rounds?.[0]?.turnaround));

    await workforcePlanningService.approveBudgetRequest(
      pool,
      budgetA.requestId,
      "L1 approved after clarify",
      mockReq(l1, "Approver", "L1 Approver")
    );
    await workforcePlanningService.approveBudgetRequest(
      pool,
      budgetA.requestId,
      "L2 approved after L1 clarify path",
      mockReq(l2, "Approver", "L2 Approver")
    );
    snap = await getBudget(client, budgetA.requestId);
    pass("Approve after L1 clarification completes normally", snap.request?.status === "Approved");

    // --- Scenario B: L1 approve → L2 clarify → L2 again ---
    const budgetB = await createSubmittedBudget(pool, client, {
      ...criteria,
      justification: "Scenario B — L2 clarify loop."
    }, requestorReq);

    await workforcePlanningService.approveBudgetRequest(
      pool,
      budgetB.requestId,
      "L1 ok",
      mockReq(l1, "Approver", "L1 Approver")
    );

    await workforcePlanningService.requestBudgetClarification(
      pool,
      budgetB.requestId,
      "Need revised budget split.",
      mockReq(l2, "Approver", "L2 Approver")
    );

    snap = await getBudget(client, budgetB.requestId);
    tasks = await countTasks(client, budgetB.instanceId);
    const l1Completed = tasks.find((t) => /Approval Step 1/.test(t.title || ""));

    pass("L2 clarify keeps L1 completed", String(l1Completed?.status).toLowerCase() === "completed");
    pass("L2 clarify returns resume status L2", snap.request?.clarification_resume_status === "Pending Level-2 Approval");

    await workforcePlanningService.submitBudgetClarification(
      pool,
      budgetB.requestId,
      "Revised budget split attached.",
      requestorReq
    );

    snap = await getBudget(client, budgetB.requestId);
    tasks = await countTasks(client, budgetB.instanceId);
    const l2Restored = tasks.find((t) => /Approval Step 2/.test(t.title || ""));

    pass("L2 clarify returns to L2 not L1", snap.request?.status === "Pending Level-2 Approval");
    pass("Same instance for L2 clarify", snap.request?.workflow_instance_id === budgetB.instanceId);
    pass("L2 task restored after clarify", String(l2Restored?.status).toLowerCase() === "pending" && String(l2Restored?.assignee) === l2);

    // --- Scenario C: multiple L1 clarification rounds ---
    const budgetC = await createSubmittedBudget(pool, client, {
      ...criteria,
      justification: "Scenario C — multiple clarify rounds."
    }, requestorReq);

    await workforcePlanningService.requestBudgetClarification(
      pool,
      budgetC.requestId,
      "Round 1 — need more detail.",
      mockReq(l1, "Approver", "L1 Approver")
    );
    await workforcePlanningService.submitBudgetClarification(
      pool,
      budgetC.requestId,
      "Round 1 response.",
      requestorReq
    );
    await workforcePlanningService.requestBudgetClarification(
      pool,
      budgetC.requestId,
      "Round 2 — still unclear.",
      mockReq(l1, "Approver", "L1 Approver")
    );
    await workforcePlanningService.submitBudgetClarification(
      pool,
      budgetC.requestId,
      "Round 2 response.",
      requestorReq
    );

    const contextC = await workforcePlanningService.getBudgetApprovalActionContext(
      pool,
      budgetC.requestId,
      requestorReq
    );
    const historyC = await historyEvents(client, budgetC.instanceId);

    pass("Multiple clarification rounds stored", (contextC.clarification_rounds || []).length >= 2);
    pass("Multiple ClarificationRequested history events", historyC.filter((e) => e.event_type === "ClarificationRequested").length >= 2);

    tasks = await countTasks(client, budgetC.instanceId);
    const approvalTaskCount = tasks.filter((t) => /Approval Step /.test(t.title || "")).length;
    pass("No duplicate approval step tasks", approvalTaskCount === 2);

    await workforcePlanningService.approveBudgetRequest(
      pool,
      budgetC.requestId,
      "Approved after 2 clarify rounds",
      mockReq(l1, "Approver", "L1 Approver")
    );
    await workforcePlanningService.approveBudgetRequest(
      pool,
      budgetC.requestId,
      "L2 final",
      mockReq(l2, "Approver", "L2 Approver")
    );

    // --- Scenario D: reject after clarification ---
    const budgetD = await createSubmittedBudget(pool, client, {
      ...criteria,
      justification: "Scenario D — reject after clarify."
    }, requestorReq);

    await workforcePlanningService.requestBudgetClarification(
      pool,
      budgetD.requestId,
      "Please confirm grade mapping.",
      mockReq(l1, "Approver", "L1 Approver")
    );
    await workforcePlanningService.submitBudgetClarification(
      pool,
      budgetD.requestId,
      "Grade confirmed.",
      requestorReq
    );
    await workforcePlanningService.rejectBudgetRequest(
      pool,
      budgetD.requestId,
      "Not approved after clarification",
      mockReq(l1, "Approver", "L1 Approver")
    );
    snap = await getBudget(client, budgetD.requestId);
    pass("Reject after clarification terminates normally", snap.request?.status === "Rejected");

    const orphanTasks = await client.query(
      `SELECT COUNT(*)::int AS count
       FROM wf_tasks t
       LEFT JOIN wf_instances i ON i.instance_id = t.instance_id
       WHERE t.instance_id = $1
         AND i.instance_id IS NULL`,
      [budgetD.instanceId]
    );
    pass("No orphan wf_tasks", orphanTasks.rows[0]?.count === 0);

    console.log("\nBudget Clarification Verification");
    console.log("================================");
    checks.forEach(({ label, ok }) => {
      console.log(`${ok ? "PASS" : "FAIL"} — ${label}`);
    });

    const passed = checks.filter((item) => item.ok).length;
    console.log(`\nResult: ${passed}/${checks.length} passed`);

    if (failures.length) {
      process.exitCode = 1;
      throw new Error(failures.join("\n"));
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error("\nVerification failed:", error.message);
  process.exit(1);
});
