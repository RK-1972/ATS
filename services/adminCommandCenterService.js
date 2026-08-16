const { buildExecutiveKpiSnapshot } = require("./hiringControlTowerKpis");
const platformConfigService = require("./platformConfigService");
const taskService = require("./taskService");
const { REQUISITION_STATUS } = require("../constants/requisitionStatus");

const PENDING_APPROVAL_STATUSES = [
  REQUISITION_STATUS.PENDING_LEVEL_1,
  REQUISITION_STATUS.PENDING_LEVEL_2
];

async function countUsers(pool) {
  const result = await pool.query(
    `SELECT
       COUNT(*)::int AS total_users,
       COUNT(*) FILTER (WHERE COALESCE(is_active, FALSE) = TRUE)::int AS active_users,
       COUNT(*) FILTER (WHERE COALESCE(is_active, FALSE) = FALSE)::int AS inactive_users
     FROM user_mstr`
  );

  return result.rows[0] || { total_users: 0, active_users: 0, inactive_users: 0 };
}

async function countPendingAccessApprovals(pool) {
  const result = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int
        FROM user_mstr
        WHERE COALESCE(is_active, FALSE) = FALSE) AS inactive_users,
       (SELECT COUNT(*)::int
        FROM rm_requisitions
        WHERE req_status = ANY($1::text[])) AS pending_req_approvals,
       (SELECT COUNT(*)::int
        FROM wp_budget_requests
        WHERE status = ANY($1::text[])) AS pending_budget_approvals`,
    [PENDING_APPROVAL_STATUSES]
  );

  const row = result.rows[0] || {};
  const inactiveUsers = row.inactive_users || 0;
  const pendingReqApprovals = row.pending_req_approvals || 0;
  const pendingBudgetApprovals = row.pending_budget_approvals || 0;

  return {
    inactive_users: inactiveUsers,
    pending_req_approvals: pendingReqApprovals,
    pending_budget_approvals: pendingBudgetApprovals,
    total: inactiveUsers + pendingReqApprovals + pendingBudgetApprovals
  };
}

async function loadPendingWorkflowAttentionItems(pool, limit = 3) {
  const result = await pool.query(
    `SELECT
       t.task_id,
       t.title,
       t.status,
       t.created_on,
       i.workflow_code,
       r.requisition_code,
       r.position_title,
       o.offer_id,
       o.candidate_name
     FROM wf_tasks t
     INNER JOIN wf_assignments a
       ON a.task_id = t.task_id
      AND a.active = TRUE
     INNER JOIN wf_instances i
       ON i.instance_id = t.instance_id
     LEFT JOIN rm_requisitions r
       ON r.workflow_instance_id = i.instance_id
     LEFT JOIN om_offers o
       ON o.workflow_instance_id = i.instance_id
     WHERE LOWER(COALESCE(t.status, '')) = 'pending'
       AND LOWER(COALESCE(i.status, '')) = 'running'
       AND (
         t.task_type IS NULL
         OR BTRIM(t.task_type) = ''
         OR LOWER(t.task_type) = 'approval'
       )
     ORDER BY t.created_on ASC NULLS LAST, t.task_id ASC
     LIMIT $1`,
    [limit]
  );

  return result.rows.map((row) => {
    const subject =
      row.position_title
      || row.candidate_name
      || row.requisition_code
      || row.workflow_code
      || row.title
      || "Approval task";

    return {
      id: `workflow-task-${row.task_id}`,
      type: "workflow_exception",
      title: "Workflow approval pending",
      detail: `${row.title || "Approval task"} · ${subject}`,
      route: "/business-rules",
      tone: "warning"
    };
  });
}

function buildConfigurationAttentionItem({ configIsDirty, configErrors, configWarnings, draftChanges }) {
  if (!configIsDirty && configErrors.length === 0 && configWarnings.length === 0) {
    return null;
  }

  if (configErrors.length > 0) {
    return {
      id: "configuration-validation-errors",
      type: "configuration_exception",
      title: "Configuration exception",
      detail:
        configErrors.length === 1
          ? configErrors[0]
          : `${configErrors.length} platform configuration validation errors require review`,
      route: "/platform-configuration",
      tone: "error"
    };
  }

  if (configIsDirty) {
    return {
      id: "configuration-unpublished-draft",
      type: "configuration_exception",
      title: "Configuration exception",
      detail:
        draftChanges > 0
          ? `${draftChanges} unpublished platform configuration change${draftChanges === 1 ? "" : "s"} in draft`
          : "Unpublished platform configuration draft requires review",
      route: "/platform-configuration",
      tone: "orange"
    };
  }

  return {
    id: "configuration-warnings",
    type: "configuration_exception",
    title: "Configuration review",
    detail:
      configWarnings.length === 1
        ? configWarnings[0]
        : `${configWarnings.length} platform configuration warnings require review`,
    route: "/platform-configuration",
    tone: "info"
  };
}

async function buildAttentionItems(pool, context) {
  const items = [];

  if (context.inactiveUsers > 0) {
    items.push({
      id: "access-inactive-users",
      type: "access_approval",
      title: "Pending access approval",
      detail: `${context.inactiveUsers} inactive user account${context.inactiveUsers === 1 ? "" : "s"} require review`,
      route: "/users",
      tone: "warning"
    });
  }

  if (context.pendingReqApprovals > 0) {
    items.push({
      id: "access-pending-requisitions",
      type: "access_approval",
      title: "Pending requisition approval",
      detail: `${context.pendingReqApprovals} requisition${context.pendingReqApprovals === 1 ? "" : "s"} awaiting approval`,
      route: "/requisition-queues",
      tone: "warning"
    });
  }

  if (context.pendingBudgetApprovals > 0) {
    items.push({
      id: "access-pending-budget",
      type: "access_approval",
      title: "Pending budget approval",
      detail: `${context.pendingBudgetApprovals} budget request${context.pendingBudgetApprovals === 1 ? "" : "s"} awaiting approval`,
      route: "/workforce-planning",
      tone: "warning"
    });
  }

  const workflowItems = await loadPendingWorkflowAttentionItems(pool);
  items.push(...workflowItems);

  const configurationItem = buildConfigurationAttentionItem(context);
  if (configurationItem) {
    items.push(configurationItem);
  }

  if (context.clarifications > 0) {
    items.push({
      id: "governance-clarifications",
      type: "governance",
      title: "Governance review",
      detail: `${context.clarifications} open clarification item${context.clarifications === 1 ? "" : "s"} require review`,
      route: "/business-rules",
      tone: "info"
    });
  }

  if (context.budgetExceptions > 0) {
    items.push({
      id: "governance-budget-exceptions",
      type: "governance",
      title: "Budget exception",
      detail: `${context.budgetExceptions} offer${context.budgetExceptions === 1 ? "" : "s"} exceed configured budget variance threshold`,
      route: "/offers",
      tone: "error"
    });
  }

  if (context.escalatedTasks > 0) {
    items.push({
      id: "workflow-escalated-tasks",
      type: "workflow_exception",
      title: "Escalated workflow task",
      detail: `${context.escalatedTasks} escalated enterprise task${context.escalatedTasks === 1 ? "" : "s"} require attention`,
      route: "/business-rules",
      tone: "error"
    });
  }

  return items.slice(0, 10);
}

async function buildAdminCommandCenterSnapshot(pool) {
  const [userCounts, pendingAccess, executiveSnapshot, configBundle, taskBundle] =
    await Promise.all([
      countUsers(pool),
      countPendingAccessApprovals(pool),
      buildExecutiveKpiSnapshot(pool),
      platformConfigService.getConfigBundle(pool),
      taskService.getTaskBundle(pool)
    ]);

  const configValidation = platformConfigService.validateConfiguration(configBundle.config);
  const configErrors = configValidation.errors || [];
  const configWarnings = configValidation.warnings || [];
  const draftChanges = Number(configBundle.config?.meta?.draft_changes) || 0;
  const hctKpis = executiveSnapshot.kpis || {};
  const taskSummary = taskBundle.summary || {};

  const governanceExceptions =
    (hctKpis.clarifications || 0)
    + (hctKpis.budgetExceptions || 0)
    + configErrors.length
    + (configBundle.isDirty ? 1 : 0)
    + (taskSummary.escalated || 0);

  const openWorkflowTasks =
    (hctKpis.pendingApprovals || 0) + (taskSummary.pending || 0);

  const attentionItems = await buildAttentionItems(pool, {
    inactiveUsers: userCounts.inactive_users || 0,
    pendingReqApprovals: pendingAccess.pending_req_approvals || 0,
    pendingBudgetApprovals: pendingAccess.pending_budget_approvals || 0,
    clarifications: hctKpis.clarifications || 0,
    budgetExceptions: hctKpis.budgetExceptions || 0,
    configIsDirty: Boolean(configBundle.isDirty),
    configErrors,
    configWarnings,
    draftChanges,
    escalatedTasks: taskSummary.escalated || 0
  });

  return {
    kpis: {
      total_users: userCounts.total_users || 0,
      active_users: userCounts.active_users || 0,
      pending_access_items: pendingAccess.total || 0,
      active_requisitions: hctKpis.activeProcesses || 0,
      open_workflow_tasks: openWorkflowTasks,
      governance_exceptions: governanceExceptions
    },
    attention_items: attentionItems,
    metadata: {
      computed_at: new Date().toISOString(),
      sources: {
        total_users: "user_mstr",
        active_users: "user_mstr.is_active",
        pending_access_items: "user_mstr + rm_requisitions + wp_budget_requests",
        active_requisitions: "rm_requisitions via hiringControlTowerKpis.countActiveProcesses",
        open_workflow_tasks: "wf_tasks + et_tasks",
        governance_exceptions: "hiringControlTowerKpis + pc_config_state + et_tasks",
        attention_items: "aggregated operational records"
      }
    }
  };
}

module.exports = {
  buildAdminCommandCenterSnapshot
};
