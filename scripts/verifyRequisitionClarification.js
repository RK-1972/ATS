/**
 * Resource Requisition clarification loop verification.
 * Mirrors verifyBudgetClarification.js using the generic workflow engine.
 */
require("dotenv").config();
const { Pool } = require("pg");
const { REQUISITION_STATUS } = require("../constants/requisitionStatus");
const workforcePlanningService = require("../services/workforcePlanningService");
const workflowService = require("../services/workflowService");
const recruitmentService = require("../services/recruitmentService");

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

async function getRequisition(client, code) {
  const result = await client.query(
    `SELECT * FROM rm_requisitions WHERE requisition_code = $1 LIMIT 1`,
    [code]
  );
  return result.rows[0] || null;
}

async function findAvailableApprovedPosition(client) {
  const state = await client.query(
    `SELECT draft_payload FROM wp_config_state WHERE id = 1`
  );
  const positions = state.rows[0]?.draft_payload?.approved_positions || [];

  for (const position of positions) {
    const consumed = await client.query(
      `SELECT 1 FROM rm_requisitions WHERE approved_position_id = $1 LIMIT 1`,
      [position.id]
    );
    if (!consumed.rows.length) {
      return position.id;
    }
  }

  return null;
}

async function findPendingRequisitionWithActiveTask(client) {
  const result = await client.query(
    `SELECT r.requisition_code, r.workflow_instance_id, r.req_status, r.created_by
     FROM rm_requisitions r
     INNER JOIN wf_instances i ON i.instance_id = r.workflow_instance_id
     INNER JOIN wf_tasks t ON t.instance_id = r.workflow_instance_id
     INNER JOIN wf_assignments a ON a.task_id = t.task_id AND a.active = TRUE
     WHERE r.req_status IN ($1, $2)
       AND LOWER(i.status) = 'running'
       AND LOWER(TRIM(t.status)) = 'pending'
       AND LOWER(TRIM(COALESCE(t.task_type, 'approval'))) IN ('approval', 'approve')
     ORDER BY r.created_on DESC
     LIMIT 1`,
    [
      REQUISITION_STATUS.PENDING_LEVEL_1,
      REQUISITION_STATUS.PENDING_LEVEL_2
    ]
  );
  return result.rows[0] || null;
}

async function resolveSubmitDefaults(client) {
  const city = await client.query(
    `SELECT name FROM md_records
     WHERE entity_type IN ('cities', 'work_locations')
       AND is_deleted = FALSE
     ORDER BY id LIMIT 1`
  );
  const employment = await client.query(
    `SELECT name FROM md_records
     WHERE entity_type = 'employment_types'
       AND is_deleted = FALSE
     ORDER BY id LIMIT 1`
  );
  const priority = await client.query(
    `SELECT name FROM md_records
     WHERE entity_type = 'priorities'
       AND is_deleted = FALSE
     ORDER BY id LIMIT 1`
  );

  return {
    primary_skill: "Verification Skill",
    location: city.rows[0]?.name || null,
    employment_type: employment.rows[0]?.name || "Full Time",
    priority_level: priority.rows[0]?.name || "High",
    target_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  };
}

async function resolveRequisitionApprovalRoute(client) {
  const route = await client.query(
    `SELECT route_id
     FROM approval_route_mstr
     WHERE LOWER(TRIM(status)) = 'active'
       AND (
         LOWER(TRIM(applies_to)) LIKE '%requisition%'
         OR LOWER(TRIM(applies_to)) LIKE '%talent%'
         OR LOWER(TRIM(applies_to)) LIKE '%demand%'
       )
     ORDER BY route_id
     LIMIT 1`
  );

  if (route.rows[0]?.route_id) {
    return route.rows[0].route_id;
  }

  const fallback = await client.query(
    `SELECT route_id
     FROM approval_route_mstr
     WHERE LOWER(TRIM(status)) = 'active'
     ORDER BY route_id
     LIMIT 1`
  );

  return fallback.rows[0]?.route_id || null;
}

async function getActiveApprovalTask(client, instanceId) {
  const result = await client.query(
    `SELECT t.task_id, t.title, t.status, t.assignee, a.assignment_id
     FROM wf_tasks t
     INNER JOIN wf_assignments a ON a.task_id = t.task_id AND a.active = TRUE
     WHERE t.instance_id = $1
       AND LOWER(TRIM(t.status)) = 'pending'
       AND LOWER(TRIM(COALESCE(t.task_type, 'approval'))) IN ('approval', 'approve')
     ORDER BY t.task_id ASC
     LIMIT 1`,
    [instanceId]
  );
  return result.rows[0] || null;
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
    let requisition = null;

    const positionId = await findAvailableApprovedPosition(client);
    if (!positionId) {
      requisition = await findPendingRequisitionWithActiveTask(client);
      if (!requisition) {
        console.log("No available approved position or pending requisition — skipping.");
        process.exitCode = 0;
        return;
      }
    } else {

      const admin = await client.query(
        `SELECT employee_code, role_name, full_name
         FROM user_mstr
         WHERE LOWER(TRIM(role_name)) = 'admin' AND is_active = TRUE
         ORDER BY user_id LIMIT 1`
      );

      if (!admin.rows[0]) {
        throw new Error("No active admin user found for requisition creation.");
      }

      const requestorReq = mockReq(
        admin.rows[0].employee_code,
        admin.rows[0].role_name,
        admin.rows[0].full_name
      );

      const approvalRouteId = await resolveRequisitionApprovalRoute(client);
      const submitDefaults = await resolveSubmitDefaults(client);

      const created = await recruitmentService.createFromApprovedPosition(
        pool,
        positionId,
        {
          approval_route_id: approvalRouteId,
          ...submitDefaults
        },
        requestorReq
      );

      requisition = await getRequisition(client, created.requisitionId);

      if (
        requisition
        && requisition.req_status === REQUISITION_STATUS.OPEN
        && !requisition.requestor_submitted_on
        && !(await getActiveApprovalTask(client, requisition.workflow_instance_id))
      ) {
        await recruitmentService.submitRequisition(
          pool,
          requisition.requisition_code,
          submitDefaults,
          requestorReq
        );
        requisition = await getRequisition(client, requisition.requisition_code);
      }
    }

    if (!requisition?.workflow_instance_id) {
      throw new Error("No requisition with workflow instance available for verification.");
    }

    const requestorProfile = await client.query(
      `SELECT employee_code, full_name, email_id
       FROM user_mstr
       WHERE employee_code = $1 OR email_id = $1 OR full_name = $1
       LIMIT 1`,
      [requisition.created_by]
    );
    const requestorCode =
      requestorProfile.rows[0]?.employee_code
      || (String(requisition.created_by || "").includes("@")
        ? null
        : requisition.created_by);

    if (!requestorCode) {
      throw new Error(`Could not resolve requestor employee code for ${requisition.requisition_code}.`);
    }

    const requestorReq = mockReq(
      requestorCode,
      "Recruiter",
      requestorProfile.rows[0]?.full_name || requisition.created_by
    );

    const instanceId = requisition.workflow_instance_id;
    const requisitionCode = requisition.requisition_code;
    let activeTask = await getActiveApprovalTask(client, instanceId);

    if (!activeTask) {
      throw new Error(`No active approval task for ${requisitionCode}.`);
    }

    const l1 = String(activeTask.assignee).trim();

    try {
      await workflowService.requestClarificationMyActiveApproval(
        pool,
        activeTask.task_id,
        "",
        mockReq(l1, "Approver", "L1 Approver")
      );
      pass("Clarify requires a comment", false);
    } catch (error) {
      pass("Clarify requires a comment", error.status === 400);
    }

    await workflowService.requestClarificationMyActiveApproval(
      pool,
      activeTask.task_id,
      "Please clarify headcount and grade mapping.",
      mockReq(l1, "Approver", "L1 Approver")
    );

    let row = await getRequisition(client, requisitionCode);
    let tasks = await countTasks(client, instanceId);
    const l1Task = tasks.find((task) => String(task.task_id) === String(activeTask.task_id));
    const l2TaskWaiting = tasks.find((task) => /Approval Step 2/.test(task.title || ""));

    pass(
      "Clarify sets Clarification Requested",
      row.req_status === REQUISITION_STATUS.CLARIFICATION_REQUESTED
    );
    pass(
      "Clarify pauses workflow",
      (await client.query(
        `SELECT status FROM wf_instances WHERE instance_id = $1`,
        [instanceId]
      )).rows[0]?.status === "Paused"
    );
    pass(
      "Clarify does not activate L2",
      String(l2TaskWaiting?.status || "").toLowerCase() !== "pending"
    );
    pass(
      "Approver task held for clarification",
      String(l1Task?.status || "").toLowerCase() === "waiting for clarification"
    );
    pass(
      "No active pending approver during clarify",
      (await countActivePendingApprovers(client, instanceId)) === 0
    );

    const clarifyTask = tasks.find(
      (task) => String(task.task_type || "").toLowerCase() === "clarification"
    );
    pass(
      "Requestor clarification task created",
      Boolean(clarifyTask)
      && String(clarifyTask.title || "").includes("Clarify Requisition")
      && String(clarifyTask.assignee) === String(requestorCode)
    );

    const l1MyApprovalsDuringClarify = await myActiveApprovalTaskIds(pool, l1);
    pass(
      "Approver absent from My Approvals during clarify",
      !l1MyApprovalsDuringClarify.includes(String(activeTask.task_id))
    );

    await workforcePlanningService.submitRequisitionClarification(
      pool,
      requisitionCode,
      "Updated headcount and grade details provided.",
      requestorReq
    );

    row = await getRequisition(client, requisitionCode);
    tasks = await countTasks(client, instanceId);
    const l1Restored = tasks.find((task) => String(task.task_id) === String(activeTask.task_id));

    pass(
      "Same workflow instance after clarify response",
      row.workflow_instance_id === instanceId
    );
    pass(
      "Clarify returns to pending approval level",
      [
        REQUISITION_STATUS.PENDING_LEVEL_1,
        REQUISITION_STATUS.PENDING_LEVEL_2
      ].includes(row.req_status)
    );
    pass(
      "Same approval task restored to Pending",
      String(l1Restored?.status || "").toLowerCase() === "pending"
      && String(l1Restored?.assignee) === l1
    );
    pass(
      "Only one active pending approver after resume",
      (await countActivePendingApprovers(client, instanceId)) === 1
    );

    const l1MyApprovalsAfterResume = await myActiveApprovalTaskIds(pool, l1);
    pass(
      "Approver reappears in My Approvals after response",
      l1MyApprovalsAfterResume.includes(String(l1Restored?.task_id))
    );

    const history = await historyEvents(client, instanceId);
    pass(
      "wf_history contains ClarificationRequested",
      history.some((event) => event.event_type === "ClarificationRequested")
    );
    pass(
      "wf_history contains ClarificationSubmitted",
      history.some((event) => event.event_type === "ClarificationSubmitted")
    );
    pass(
      "wf_history contains ClarificationResumed",
      history.some((event) => event.event_type === "ClarificationResumed")
    );

    const context = await workforcePlanningService.getRequisitionApprovalActionContext(
      pool,
      requisitionCode,
      requestorReq
    );
    pass(
      "Inspector exposes clarification rounds",
      Array.isArray(context.clarification_rounds)
      && context.clarification_rounds.length >= 1
    );
    pass(
      "Inspector turnaround calculable",
      Boolean(context.clarification_rounds?.[0]?.turnaround)
    );

    activeTask = await getActiveApprovalTask(client, instanceId);

    if (!activeTask) {
      pass("Reject requires active pending task", false);
    } else {
      const rejectApprover = String(activeTask.assignee).trim();

      await workflowService.rejectMyActiveApproval(
        pool,
        activeTask.task_id,
        "Rejected after clarification verification.",
        mockReq(rejectApprover, "Approver", "Approver")
      );

      row = await getRequisition(client, requisitionCode);
      pass(
        "Reject sets terminal Rejected status",
        row.req_status === REQUISITION_STATUS.REJECTED
      );
      pass(
        "No active pending approver after reject",
        (await countActivePendingApprovers(client, instanceId)) === 0
      );
      pass(
        "wf_history contains rejection",
        (await historyEvents(client, instanceId)).some(
          (event) => event.event_type === "TaskRejected" || event.event_type === "WorkflowRejected"
        )
      );
    }

    console.log("\n--- Requisition Clarification Verification ---");
    checks.forEach(({ label, ok }) => {
      console.log(`${ok ? "✓" : "✗"} ${label}`);
    });

    console.log(`\nPassed: ${checks.filter((item) => item.ok).length}/${checks.length}`);

    if (failures.length) {
      failures.forEach((label) => console.error(`FAILED: ${label}`));
      process.exitCode = 1;
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
