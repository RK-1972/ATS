/**
 * Talent Demand — react to Workflow Engine events for REQUISITION.
 * Owns TD/requisition business outcomes. No workflow task chaining logic here.
 */

const { writeEnterpriseAudit, userContext } = require("./enterpriseAuditService");
const { isLegacyDualWriteEnabled } = require("../config/operationalCutover");
const { REQUISITION_STATUS } = require("../constants/requisitionStatus");

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function tableExists(queryable, tableName) {
  const result = await queryable.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = $1
     ) AS exists`,
    [tableName]
  );
  return Boolean(result.rows[0]?.exists);
}

/**
 * Resolve operational requisition linked to a completed REQUISITION workflow.
 */
async function findRequisitionForWorkflow(queryable, event) {
  const byWorkflow = await queryable.query(
    `SELECT *
     FROM rm_requisitions
     WHERE workflow_instance_id = $1
     LIMIT 1`,
    [event.instanceId]
  );

  if (byWorkflow.rows[0]) {
    return byWorkflow.rows[0];
  }

  const requisitionCode =
    event.requisitionCode ||
    event.executionContext?.meta?.requisition_id ||
    event.executionContext?.requisition_id ||
    null;

  if (!requisitionCode) {
    return null;
  }

  const byCode = await queryable.query(
    `SELECT *
     FROM rm_requisitions
     WHERE requisition_code = $1
     LIMIT 1`,
    [requisitionCode]
  );

  return byCode.rows[0] || null;
}

/**
 * Apply Talent Demand / requisition approval when the approval workflow completes.
 *
 * @param {object} queryable - same client as workflow completion TX
 * @param {object} event - { instanceId, workflowCode, completedByTaskId, ... }
 * @param {object} req - request for actor context
 * @returns {Promise<object>}
 */
async function handleRequisitionWorkflowCompleted(queryable, event, req) {
  const user = userContext(req);
  const approvedOn = new Date().toISOString();
  const approvedBy = user.name;
  const approvalStatus = "Approved";

  const requisition = await findRequisitionForWorkflow(queryable, event);

  if (!requisition) {
    throw httpError(
      `No operational requisition found for workflow instance ${event.instanceId}.`,
      404
    );
  }

  const previousStatus = requisition.req_status;
  const nextStatus = REQUISITION_STATUS.APPROVED;

  // rm_requisitions has no approved_by / approved_on / approval_status columns.
  // Persist approval on req_status + modified_* and record details in audit.
  await queryable.query(
    `UPDATE rm_requisitions
     SET req_status = $1,
         modified_by = $2,
         modified_on = NOW()
     WHERE requisition_code = $3`,
    [nextStatus, approvedBy, requisition.requisition_code]
  );

  if (
    isLegacyDualWriteEnabled() &&
    requisition.req_id &&
    (await tableExists(queryable, "req_mstr"))
  ) {
    await queryable.query(
      `UPDATE req_mstr
       SET req_status = $1,
           updated_on = CURRENT_TIMESTAMP
       WHERE req_id = $2`,
      [nextStatus, requisition.req_id]
    );
  }

  await writeEnterpriseAudit(queryable, {
    eventType: "RequisitionApproved",
    module: "Talent Demand",
    entity: "Requisition",
    entityId: requisition.requisition_code,
    action: `Requisition ${requisition.requisition_code} approved via workflow completion`,
    previousValue: previousStatus,
    newValue: nextStatus,
    userName: approvedBy,
    userRole: user.role,
    metadata: {
      workflow_instance_id: event.instanceId,
      workflow_code: event.workflowCode,
      completed_by_task_id: event.completedByTaskId || null,
      approved_by: approvedBy,
      approved_on: approvedOn,
      approval_status: approvalStatus,
      source: "talent_demand_workflow_completion"
    }
  });

  return {
    businessActionCompleted: true,
    requisition_code: requisition.requisition_code,
    req_id: requisition.req_id || null,
    previous_status: previousStatus,
    req_status: nextStatus,
    approved_by: approvedBy,
    approved_on: approvedOn,
    approval_status: approvalStatus
  };
}

/**
 * Apply Talent Demand / requisition rejection when the approval workflow is rejected.
 *
 * @param {object} queryable - same client as workflow reject TX
 * @param {object} event - { instanceId, workflowCode, rejectedByTaskId, ... }
 * @param {object} req - request for actor context
 * @returns {Promise<object>}
 */
async function handleRequisitionWorkflowRejected(queryable, event, req) {
  const user = userContext(req);
  const rejectedOn = new Date().toISOString();
  const rejectedBy = user.name;
  const rejectionStatus = REQUISITION_STATUS.REJECTED;

  const requisition = await findRequisitionForWorkflow(queryable, event);

  if (!requisition) {
    throw httpError(
      `No operational requisition found for workflow instance ${event.instanceId}.`,
      404
    );
  }

  const previousStatus = requisition.req_status;
  const nextStatus = REQUISITION_STATUS.REJECTED;

  await queryable.query(
    `UPDATE rm_requisitions
     SET req_status = $1,
         modified_by = $2,
         modified_on = NOW()
     WHERE requisition_code = $3`,
    [nextStatus, rejectedBy, requisition.requisition_code]
  );

  if (
    isLegacyDualWriteEnabled() &&
    requisition.req_id &&
    (await tableExists(queryable, "req_mstr"))
  ) {
    await queryable.query(
      `UPDATE req_mstr
       SET req_status = $1,
           updated_on = CURRENT_TIMESTAMP
       WHERE req_id = $2`,
      [nextStatus, requisition.req_id]
    );
  }

  await writeEnterpriseAudit(queryable, {
    eventType: "RequisitionRejected",
    module: "Talent Demand",
    entity: "Requisition",
    entityId: requisition.requisition_code,
    action: `Requisition ${requisition.requisition_code} rejected via workflow rejection`,
    previousValue: previousStatus,
    newValue: nextStatus,
    userName: rejectedBy,
    userRole: user.role,
    metadata: {
      workflow_instance_id: event.instanceId,
      workflow_code: event.workflowCode,
      rejected_by_task_id: event.rejectedByTaskId || null,
      cancelled_task_ids: event.cancelledTaskIds || [],
      rejected_by: rejectedBy,
      rejected_on: rejectedOn,
      approval_status: rejectionStatus,
      comments: event.comments || "",
      source: "talent_demand_workflow_rejection"
    }
  });

  return {
    businessActionCompleted: true,
    requisition_code: requisition.requisition_code,
    req_id: requisition.req_id || null,
    previous_status: previousStatus,
    req_status: nextStatus,
    rejected_by: rejectedBy,
    rejected_on: rejectedOn,
    approval_status: rejectionStatus
  };
}

/**
 * Persist req_status (+ optional legacy dual-write). Same pattern as completed/rejected.
 */
async function applyRequisitionStatus(queryable, requisition, nextStatus, actorName) {
  await queryable.query(
    `UPDATE rm_requisitions
     SET req_status = $1,
         modified_by = $2,
         modified_on = NOW()
     WHERE requisition_code = $3`,
    [nextStatus, actorName, requisition.requisition_code]
  );

  if (
    isLegacyDualWriteEnabled() &&
    requisition.req_id &&
    (await tableExists(queryable, "req_mstr"))
  ) {
    await queryable.query(
      `UPDATE req_mstr
       SET req_status = $1,
           updated_on = CURRENT_TIMESTAMP
       WHERE req_id = $2`,
      [nextStatus, requisition.req_id]
    );
  }
}

/**
 * Infer resume status after clarification without a new DB column.
 * Completed approval tasks ⇒ Level-2 path; otherwise Level-1.
 */
async function resolveClarificationResumeStatus(queryable, instanceId) {
  const result = await queryable.query(
    `SELECT COUNT(*)::int AS completed_approvals
     FROM wf_tasks
     WHERE instance_id = $1
       AND LOWER(COALESCE(task_type, '')) = 'approval'
       AND status = 'Completed'`,
    [instanceId]
  );

  return Number(result.rows[0]?.completed_approvals || 0) > 0
    ? REQUISITION_STATUS.PENDING_LEVEL_2
    : REQUISITION_STATUS.PENDING_LEVEL_1;
}

/**
 * Intermediate approval step activated (e.g. L1 → L2).
 * Mirrors budgetWorkflowCompletionService.handleBudgetStepActivated.
 */
async function handleRequisitionStepActivated(queryable, event, req) {
  const user = userContext(req);
  const requisition = await findRequisitionForWorkflow(queryable, event);

  if (!requisition) {
    throw httpError(
      `No operational requisition found for workflow instance ${event.instanceId}.`,
      404
    );
  }

  const previousStatus = requisition.req_status;
  const nextStatus = REQUISITION_STATUS.PENDING_LEVEL_2;

  await applyRequisitionStatus(queryable, requisition, nextStatus, user.name);

  await writeEnterpriseAudit(queryable, {
    eventType: "RequisitionRouted",
    module: "Talent Demand",
    entity: "Requisition",
    entityId: requisition.requisition_code,
    action: `Requisition routed to Level-2 approval`,
    previousValue: previousStatus,
    newValue: nextStatus,
    userName: user.name,
    userRole: user.role,
    metadata: {
      workflow_instance_id: event.instanceId,
      workflow_code: event.workflowCode,
      activated_task_id: event.activatedTaskId || null,
      activated_assignee: event.activatedAssignee || null,
      comments: event.comments || null,
      source: "talent_demand_step_activated"
    }
  });

  return {
    businessActionCompleted: true,
    requisition_code: requisition.requisition_code,
    req_id: requisition.req_id || null,
    previous_status: previousStatus,
    req_status: nextStatus,
    current_approver: event.activatedAssignee || null
  };
}

/**
 * Clarification requested — mirrors handleBudgetClarificationRequested.
 */
async function handleRequisitionClarificationRequested(queryable, event, req) {
  const user = userContext(req);
  const requisition = await findRequisitionForWorkflow(queryable, event);

  if (!requisition) {
    throw httpError(
      `No operational requisition found for workflow instance ${event.instanceId}.`,
      404
    );
  }

  const previousStatus = requisition.req_status;
  const nextStatus = REQUISITION_STATUS.CLARIFICATION_REQUESTED;
  const resumeStatus =
    previousStatus === REQUISITION_STATUS.PENDING_LEVEL_2
      ? REQUISITION_STATUS.PENDING_LEVEL_2
      : REQUISITION_STATUS.PENDING_LEVEL_1;

  await applyRequisitionStatus(queryable, requisition, nextStatus, user.name);

  await writeEnterpriseAudit(queryable, {
    eventType: "ClarificationRequested",
    module: "Talent Demand",
    entity: "Requisition",
    entityId: requisition.requisition_code,
    action: "Clarification requested on requisition",
    previousValue: previousStatus,
    newValue: nextStatus,
    userName: user.name,
    userRole: user.role,
    metadata: {
      workflow_instance_id: event.instanceId,
      workflow_code: event.workflowCode,
      task_id: event.taskId || null,
      comments: event.comments || null,
      clarification_resume_status: resumeStatus,
      source: "talent_demand_clarification_requested"
    }
  });

  return {
    businessActionCompleted: true,
    requisition_code: requisition.requisition_code,
    req_id: requisition.req_id || null,
    previous_status: previousStatus,
    req_status: nextStatus,
    resume_status: resumeStatus
  };
}

/**
 * Clarification submitted — mirrors handleBudgetClarificationSubmitted.
 */
async function handleRequisitionClarificationSubmitted(queryable, event, req) {
  const user = userContext(req);
  const requisition = await findRequisitionForWorkflow(queryable, event);

  if (!requisition) {
    throw httpError(
      `No operational requisition found for workflow instance ${event.instanceId}.`,
      404
    );
  }

  const previousStatus = requisition.req_status;
  const nextStatus = await resolveClarificationResumeStatus(
    queryable,
    event.instanceId
  );

  await applyRequisitionStatus(queryable, requisition, nextStatus, user.name);

  await writeEnterpriseAudit(queryable, {
    eventType: "ClarificationSubmitted",
    module: "Talent Demand",
    entity: "Requisition",
    entityId: requisition.requisition_code,
    action: "Clarification submitted — workflow resumed",
    previousValue: previousStatus,
    newValue: nextStatus,
    userName: user.name,
    userRole: user.role,
    metadata: {
      workflow_instance_id: event.instanceId,
      workflow_code: event.workflowCode,
      reactivated_task_id: event.reactivatedTaskId || null,
      reactivated_assignee: event.reactivatedAssignee || null,
      comments: event.comments || null,
      same_instance: true,
      source: "talent_demand_clarification_submitted"
    }
  });

  return {
    businessActionCompleted: true,
    requisition_code: requisition.requisition_code,
    req_id: requisition.req_id || null,
    previous_status: previousStatus,
    req_status: nextStatus
  };
}

module.exports = {
  handleRequisitionWorkflowCompleted,
  handleRequisitionWorkflowRejected,
  handleRequisitionStepActivated,
  handleRequisitionClarificationRequested,
  handleRequisitionClarificationSubmitted,
  findRequisitionForWorkflow
};
