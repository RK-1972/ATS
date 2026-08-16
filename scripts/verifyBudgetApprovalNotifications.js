/**
 * Verifies sequential budget approval bell notifications:
 * - At most one active wf_assignment per running budget workflow instance
 * - Only the current assignee receives a BUDGET row from getMyActiveApprovals
 * - Approving advances the notification to the next approver (optional chain simulation)
 */
require("dotenv").config();
const { Pool } = require("pg");
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

function countBudgetNotifications(rows) {
  return rows.filter(
    (row) => String(row.document_type || "").trim().toUpperCase() === "BUDGET"
  ).length;
}

async function getRunningBudgetInstances(client) {
  const result = await client.query(
    `SELECT DISTINCT
       i.instance_id,
       COALESCE(
         i.execution_context #>> '{meta,budget_request_id}',
         REPLACE(i.instance_id, 'WF-BR-', '')
       ) AS budget_request_id,
       i.status AS instance_status
     FROM wf_instances i
     WHERE LOWER(i.status) IN ('running', 'paused')
       AND (
         UPPER(COALESCE(i.execution_context #>> '{meta,document_type}', '')) = 'BUDGET'
         OR i.instance_id LIKE 'WF-BR-%'
       )
     ORDER BY i.instance_id`
  );
  return result.rows;
}

async function getActiveAssignment(client, instanceId) {
  const result = await client.query(
    `SELECT a.assignment_id, a.assignee, a.active, t.task_id, t.status AS task_status
     FROM wf_assignments a
     INNER JOIN wf_tasks t ON t.task_id = a.task_id
     WHERE t.instance_id = $1
       AND a.active = TRUE
     ORDER BY a.assignment_id`,
    [instanceId]
  );
  return result.rows;
}

async function getApprovalChainAssignees(client, instanceId) {
  const result = await client.query(
    `SELECT t.task_id, t.status, a.assignee, a.active
     FROM wf_tasks t
     LEFT JOIN wf_assignments a ON a.task_id = t.task_id
     WHERE t.instance_id = $1
       AND t.task_type = 'approval'
       AND t.title LIKE 'Approval Step %'
     ORDER BY t.task_id ASC`,
    [instanceId]
  );
  return result.rows;
}

async function verifyInstanceSequentialNotifications(client, instanceId, budgetRequestId) {
  const failures = [];
  const activeRows = await getActiveAssignment(client, instanceId);
  const chain = await getApprovalChainAssignees(client, instanceId);

  if (chain.length === 0) {
    return {
      failures: [],
      skipped: true,
      activeAssignee: activeRows[0]?.assignee || null,
      notificationHolder: null,
      chainLength: 0
    };
  }

  if (activeRows.length > 1) {
    failures.push(
      `${instanceId}: expected at most 1 active assignment, found ${activeRows.length}`
    );
  }

  const assignees = [...new Set(chain.map((row) => row.assignee).filter(Boolean))];

  let totalBudgetNotifications = 0;
  let currentAssigneeWithNotification = null;

  for (const assignee of assignees) {
    const approvals = await workflowService.getMyActiveApprovals(pool, mockReq(assignee));
    const budgetRows = approvals.filter(
      (row) =>
        String(row.document_type || "").trim().toUpperCase() === "BUDGET"
        && String(row.instance_id) === String(instanceId)
    );

    totalBudgetNotifications += budgetRows.length;

    if (budgetRows.length > 0) {
      if (currentAssigneeWithNotification) {
        failures.push(
          `${instanceId}: multiple approvers have pending budget notifications (${currentAssigneeWithNotification}, ${assignee})`
        );
      }
      currentAssigneeWithNotification = assignee;
    }

    if (budgetRows.length > 1) {
      failures.push(
        `${instanceId}: assignee ${assignee} has ${budgetRows.length} duplicate budget notifications`
      );
    }
  }

  if (activeRows.length === 1 && totalBudgetNotifications !== 1) {
    failures.push(
      `${instanceId} (${budgetRequestId}): active assignment exists but ${totalBudgetNotifications} approver(s) see budget notification`
    );
  }

  if (activeRows.length === 1 && currentAssigneeWithNotification) {
    const activeAssignee = activeRows[0].assignee;
    if (String(activeAssignee) !== String(currentAssigneeWithNotification)) {
      failures.push(
        `${instanceId}: active assignee ${activeAssignee} does not match notification holder ${currentAssigneeWithNotification}`
      );
    }
  }

  if (activeRows.length === 0 && totalBudgetNotifications > 0) {
    failures.push(
      `${instanceId}: no active assignment but ${totalBudgetNotifications} approver(s) still see budget notification`
    );
  }

  return {
    failures,
    activeAssignee: activeRows[0]?.assignee || null,
    notificationHolder: currentAssigneeWithNotification,
    chainLength: chain.length
  };
}

async function simulateApprovalChain(client, instanceId) {
  const failures = [];
  const chain = await getApprovalChainAssignees(client, instanceId);

  if (chain.length < 2) {
    return { skipped: true, reason: "chain shorter than 2 steps", failures };
  }

  const pendingTask = chain.find(
    (row) => String(row.status || "").toLowerCase() === "pending" && row.active
  );

  if (!pendingTask) {
    return { skipped: true, reason: "no pending active step to simulate", failures };
  }

  const beforeAssignee = pendingTask.assignee;

  await workflowService.approveMyActiveApproval(
    pool,
    mockReq(beforeAssignee),
    pendingTask.task_id
  );

  const afterBeforeApprovals = await workflowService.getMyActiveApprovals(
    pool,
    mockReq(beforeAssignee)
  );
  const afterBeforeCount = countBudgetNotifications(
    afterBeforeApprovals.filter((row) => String(row.instance_id) === String(instanceId))
  );

  if (afterBeforeCount > 0) {
    failures.push(
      `${instanceId}: approver ${beforeAssignee} still has budget notification after approve`
    );
  }

  const nextActive = await getActiveAssignment(client, instanceId);
  if (nextActive.length === 1) {
    const nextAssignee = nextActive[0].assignee;
    const nextApprovals = await workflowService.getMyActiveApprovals(
      pool,
      mockReq(nextAssignee)
    );
    const nextCount = countBudgetNotifications(
      nextApprovals.filter((row) => String(row.instance_id) === String(instanceId))
    );

    if (nextCount !== 1) {
      failures.push(
        `${instanceId}: expected next approver ${nextAssignee} to have exactly 1 notification, found ${nextCount}`
      );
    }
  }

  return {
    skipped: false,
    simulatedFrom: beforeAssignee,
    failures
  };
}

async function main() {
  const client = await pool.connect();
  const failures = [];
  let instancesChecked = 0;
  let chainSimulation = null;

  try {
    const instances = await getRunningBudgetInstances(client);

    if (!instances.length) {
      console.log("No running budget workflow instances found — checking invariants only.");
    }

    for (const instance of instances) {
      instancesChecked += 1;
      const result = await verifyInstanceSequentialNotifications(
        client,
        instance.instance_id,
        instance.budget_request_id
      );
      failures.push(...result.failures);

      console.log(
        `${result.skipped ? "○" : "✓"} Checked budget ${instance.budget_request_id} (${instance.instance_id}): chain=${result.chainLength}, active=${result.activeAssignee || "none"}, notified=${result.notificationHolder || "none"}${result.skipped ? " [legacy/no approval chain]" : ""}`
      );
    }

    const simulationCandidate =
      instances.find(
        (row) =>
          row.instance_status === "Running" && row.instance_id.startsWith("WF-BR-")
      ) || instances.find((row) => row.instance_id.startsWith("WF-BR-"));

    if (simulationCandidate) {
      chainSimulation = await simulateApprovalChain(
        client,
        simulationCandidate.instance_id
      );

      if (chainSimulation.skipped) {
        console.log(
          `\nChain simulation skipped for ${simulationCandidate.instance_id}: ${chainSimulation.reason}`
        );
      } else {
        console.log(
          `\nChain simulation: approver ${chainSimulation.simulatedFrom} approved; budget notification handoff verified`
        );
      }

      failures.push(...(chainSimulation.failures || []));
    }

    console.log("\n--- Summary ---");
    console.log(`Instances checked: ${instancesChecked}`);
    console.log(`Failures: ${failures.length}`);

    if (failures.length) {
      failures.forEach((message) => console.error(`  ✗ ${message}`));
      process.exitCode = 1;
      return;
    }

    console.log("All budget approval notification checks passed.");
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
