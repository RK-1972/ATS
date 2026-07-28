/**
 * Sprint 3 unit-level verification for Budget approval actions.
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
      email_id: `${employeeCode.toLowerCase()}@optalynx.local`,
      full_name: fullName || employeeCode
    }
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

async function main() {
  const client = await pool.connect();
  const failures = [];

  try {
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
    if (!route.rows[0]) throw new Error("No BUDGET route");

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
           route_id,
           step_no,
           approver_employee_code,
           approval_type,
           comments_required,
           allow_reject,
           allow_return,
           stop_if_rejected,
           sequence_no
         ) VALUES ($1, 2, $2, 'Approver', FALSE, TRUE, TRUE, TRUE, 2)`,
        [route.rows[0].route_id, secondApprover.rows[0].employee_code]
      );
      console.log(
        "Added temporary L2 step for verification:",
        secondApprover.rows[0].employee_code
      );
    }

    const refreshedSteps = await client.query(
      `SELECT sequence_no, approver_employee_code
       FROM approval_route_step WHERE route_id = $1 ORDER BY sequence_no`,
      [route.rows[0].route_id]
    );
    if (refreshedSteps.rows.length < 2) {
      throw new Error("Need L1 and L2 steps");
    }

    const l1 = String(refreshedSteps.rows[0].approver_employee_code).trim();
    const l2 = String(refreshedSteps.rows[1].approver_employee_code).trim();

    const policy = await client.query(
      `SELECT department, designation, grade, min_amount
       FROM approval_route_policy
       WHERE route_id = $1 AND is_active = TRUE
       ORDER BY policy_id LIMIT 1`,
      [route.rows[0].route_id]
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

    const admin = await client.query(
      `SELECT employee_code, role_name FROM user_mstr
       WHERE LOWER(TRIM(role_name))='admin' AND is_active=TRUE ORDER BY user_id LIMIT 1`
    );
    const requestorReq = mockReq(admin.rows[0].employee_code, admin.rows[0].role_name);

    const criteria = {
      department: policy.rows[0]?.department || dept.rows[0].name,
      position: policy.rows[0]?.designation || desig.rows[0].name,
      grade: policy.rows[0]?.grade || grade.rows[0].v,
      proposed_budget: policy.rows[0]?.min_amount != null ? Number(policy.rows[0].min_amount) : 500000,
      headcount: 1,
      justification: "Sprint 3 verification budget.",
      priority: "Medium"
    };

    const created = await workforcePlanningService.createBudgetRequest(
      pool,
      criteria,
      requestorReq
    );
    const requestId = created.request.id;
    const instanceId = `WF-BR-${requestId}`;

    await workforcePlanningService.submitBudgetRequest(pool, requestId, requestorReq);

    let snap = await getBudget(client, requestId);
    if (snap.request?.status !== "Pending Level-1 Approval") {
      failures.push(`Submit status expected Pending Level-1 Approval, got ${snap.request?.status}`);
    }

    const instanceBefore = instanceId;
    const routeSnapBefore = JSON.stringify(snap.queue?.approval_route_snapshot || null);
    const policySnapBefore = JSON.stringify(snap.queue?.approval_policy_snapshot || null);

    // Security: wrong approver cannot approve
    try {
      await workforcePlanningService.approveBudgetRequest(
        pool,
        requestId,
        "bad",
        mockReq("NOT-AN-APPROVER", "Recruiter")
      );
      failures.push("Security: non-assignee approve should fail");
    } catch (error) {
      if (error.status !== 403) {
        failures.push(`Security: expected 403, got ${error.status || error.message}`);
      }
    }

    const debugReq = await getBudget(client, requestId);
    const debugInstance =
      debugReq.queue?.workflow_instance_id
      || debugReq.request?.workflow_instance_id
      || instanceId;
    const debugTasks = await client.query(
      `SELECT t.task_id, t.status, t.task_type, a.active, a.assignee
       FROM wf_tasks t
       LEFT JOIN wf_assignments a ON a.task_id = t.task_id
       WHERE t.instance_id = $1`,
      [debugInstance]
    );
    console.log("DEBUG instance", debugInstance, "tasks", debugTasks.rows);

    // L1 approve → L2
    await workforcePlanningService.approveBudgetRequest(
      pool,
      requestId,
      "L1 ok",
      mockReq(l1, "Approver", "L1 Approver")
    );

    snap = await getBudget(client, requestId);
    let tasks = await countTasks(client, instanceId);
    const l2Task = tasks.find((t) => /Approval Step 2/.test(t.title));
    if (snap.request?.status !== "Pending Level-2 Approval") {
      failures.push(`L1 approve status expected Pending Level-2 Approval, got ${snap.request?.status}`);
    }
    if (!l2Task || String(l2Task.status).toLowerCase() !== "pending") {
      failures.push("L2 task not activated to Pending");
    }
    if (String(l2Task?.assignee) !== l2) {
      failures.push(`L2 assignee expected ${l2}, got ${l2Task?.assignee}`);
    }

    // Clarify from L2
    await workforcePlanningService.requestBudgetClarification(
      pool,
      requestId,
      "Need more justification",
      mockReq(l2, "Approver", "L2 Approver")
    );

    snap = await getBudget(client, requestId);
    const paused = await client.query(
      `SELECT status, execution_context FROM wf_instances WHERE instance_id = $1`,
      [instanceId]
    );
    tasks = await countTasks(client, instanceId);
    const clarifyTask = tasks.find((t) => String(t.task_type).toLowerCase() === "clarification");

    if (snap.request?.status !== "Clarification Requested") {
      failures.push(`Clarify status expected Clarification Requested, got ${snap.request?.status}`);
    }
    if (String(paused.rows[0]?.status) !== "Paused") {
      failures.push(`Workflow should be Paused, got ${paused.rows[0]?.status}`);
    }
    if (!clarifyTask || String(clarifyTask.status).toLowerCase() !== "pending") {
      failures.push("Requestor clarification task missing");
    }

    // Requestor edit + resubmit — same instance/route/policy
    await workforcePlanningService.createBudgetRequest(
      pool,
      {
        id: requestId,
        ...criteria,
        justification: "Sprint 3 verification budget — clarified."
      },
      requestorReq
    );

    await workforcePlanningService.submitBudgetClarification(
      pool,
      requestId,
      "Updated justification",
      requestorReq
    );

    snap = await getBudget(client, requestId);
    const afterResume = await client.query(
      `SELECT status, execution_context FROM wf_instances WHERE instance_id = $1`,
      [instanceId]
    );
    tasks = await countTasks(client, instanceId);
    const l2Again = tasks.find((t) => /Approval Step 2/.test(t.title));
    const approvalStepCount = tasks.filter((t) =>
      /Approval Step /.test(t.title || "")
    ).length;

    if (snap.request?.workflow_instance_id !== instanceBefore) {
      failures.push("Resubmit changed workflow instance id");
    }
    if (JSON.stringify(snap.queue?.approval_route_snapshot || null) !== routeSnapBefore) {
      failures.push("Resubmit changed approval_route_snapshot");
    }
    if (JSON.stringify(snap.queue?.approval_policy_snapshot || null) !== policySnapBefore) {
      failures.push("Resubmit changed approval_policy_snapshot");
    }
    if (snap.request?.status !== "Pending Level-2 Approval") {
      failures.push(`Resubmit status expected Pending Level-2 Approval, got ${snap.request?.status}`);
    }
    if (String(afterResume.rows[0]?.status) !== "Running") {
      failures.push("Workflow should be Running after resubmit");
    }
    if (!l2Again || String(l2Again.status).toLowerCase() !== "pending" || String(l2Again.assignee) !== l2) {
      failures.push("Same L2 approver task not restored");
    }
    if (approvalStepCount !== 2) {
      failures.push(`Duplicate approval tasks: ${approvalStepCount}`);
    }

    // Final approve → Approved Position
    const positionsBefore = snap.positions.length;
    await workforcePlanningService.approveBudgetRequest(
      pool,
      requestId,
      "L2 final",
      mockReq(l2, "Approver", "L2 Approver")
    );

    snap = await getBudget(client, requestId);
    const instanceFinal = await client.query(
      `SELECT status FROM wf_instances WHERE instance_id = $1`,
      [instanceId]
    );
    if (snap.request?.status !== "Approved") {
      failures.push(`Final approve status expected Approved, got ${snap.request?.status}`);
    }
    if (String(instanceFinal.rows[0]?.status) !== "Completed") {
      failures.push(`Workflow expected Completed, got ${instanceFinal.rows[0]?.status}`);
    }
    if (snap.positions.length <= positionsBefore) {
      failures.push("Approved Position not created on final approve");
    }
    if (!snap.positions.some((p) => p.source_request_id === requestId)) {
      failures.push("Approved Position missing source_request_id link");
    }

    // Reject path on a fresh budget
    const created2 = await workforcePlanningService.createBudgetRequest(
      pool,
      { ...criteria, justification: "Sprint 3 reject path." },
      requestorReq
    );
    const rejectId = created2.request.id;
    await workforcePlanningService.submitBudgetRequest(pool, rejectId, requestorReq);
    await workforcePlanningService.rejectBudgetRequest(
      pool,
      rejectId,
      "Not aligned",
      mockReq(l1, "Approver", "L1 Approver")
    );
    const rejectSnap = await getBudget(client, rejectId);
    const rejectInst = await client.query(
      `SELECT status FROM wf_instances WHERE instance_id = $1`,
      [`WF-BR-${rejectId}`]
    );
    if (rejectSnap.request?.status !== "Rejected") {
      failures.push(`Reject status expected Rejected, got ${rejectSnap.request?.status}`);
    }
    if (String(rejectInst.rows[0]?.status) !== "Rejected") {
      failures.push(`Reject workflow expected Rejected, got ${rejectInst.rows[0]?.status}`);
    }

    // Timeline presence
    const timeline = (snap.queue?.timeline || []).map((t) => t.step);
    for (const step of [
      "Submitted",
      "Clarification Requested",
      "Clarification Submitted",
      "Level-1 Approved"
    ]) {
      if (!timeline.includes(step)) {
        failures.push(`Timeline missing step: ${step}`);
      }
    }

    console.log("Failures:", failures.length ? failures : "none");
    if (failures.length) {
      process.exitCode = 1;
      console.log("\nNOT READY FOR USER REVIEW");
      failures.forEach((f) => console.log(" -", f));
    } else {
      console.log("\nAll Sprint 3 verification checks passed.");
      console.log("READY FOR USER REVIEW");
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
