/**
 * Budget domain reactions to Workflow Engine events.
 * Owns Budget Request status, timeline, Approved Positions, and audit.
 * Does not own workflow task chaining — that stays in workflowService.
 */

const { writeEnterpriseAudit, userContext } = require("./enterpriseAuditService");

const BUDGET_PENDING_LEVEL_1_STATUS = "Pending Level-1 Approval";
const BUDGET_PENDING_LEVEL_2_STATUS = "Pending Level-2 Approval";

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function clonePayload(payload) {
  return JSON.parse(JSON.stringify(payload));
}

function nowIso() {
  return new Date().toISOString();
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

function isBudgetWorkflowEvent(event = {}) {
  const context = parseContext(event.executionContext);
  const meta = context.meta && typeof context.meta === "object" ? context.meta : {};
  const documentType = String(meta.document_type || "").toUpperCase();
  const instanceId = String(event.instanceId || "");

  return (
    documentType === "BUDGET"
    || Boolean(meta.budget_request_id)
    || instanceId.startsWith("WF-BR-")
  );
}

function resolveBudgetRequestId(event = {}) {
  const context = parseContext(event.executionContext);
  const meta = context.meta && typeof context.meta === "object" ? context.meta : {};
  if (meta.budget_request_id) {
    return String(meta.budget_request_id);
  }
  if (meta.requisition_id && String(event.instanceId || "").startsWith("WF-BR-")) {
    return String(meta.requisition_id);
  }
  const instanceId = String(event.instanceId || "");
  if (instanceId.startsWith("WF-BR-")) {
    return instanceId.replace(/^WF-BR-/, "");
  }
  return null;
}

function appendTimelineEntry(request, step, actor, comment) {
  return {
    ...request,
    timeline: [
      ...(request.timeline || []),
      { step, actor, date: nowIso(), comment: comment || null }
    ],
    history: [
      ...(request.history || []),
      {
        action: step,
        actor,
        date: nowIso(),
        comment: comment || null
      }
    ]
  };
}

async function lockWorkforceDraft(queryable) {
  const locked = await queryable.query(
    `SELECT *
     FROM wp_config_state
     WHERE id = 1
     FOR UPDATE`
  );

  if (!locked.rows[0]) {
    throw httpError("Workforce Planning configuration state not found.", 500);
  }

  return locked.rows[0];
}

async function persistWorkforceDraft(queryable, draft, userName) {
  await queryable.query(
    `UPDATE wp_config_state
     SET draft_payload = $1, modified_by = $2, modified_on = NOW()
     WHERE id = 1`,
    [JSON.stringify(draft), userName]
  );
}

function updateBudgetInDraft(draft, requestId, updater) {
  const next = clonePayload(draft);
  let found = null;

  next.budget_requests = (next.budget_requests || []).map((item) => {
    if (item.id !== requestId) {
      return item;
    }
    found = updater({ ...item });
    return found;
  });

  const queueIndex = (next.approval_queue || []).findIndex(
    (item) => item.id === requestId
  );

  if (queueIndex >= 0) {
    const base = next.approval_queue[queueIndex];
    const updated = updater({ ...base });
    found = updated;
    next.approval_queue = next.approval_queue.map((item, index) =>
      index === queueIndex ? updated : item
    );
  } else if (found) {
    next.approval_queue = [found, ...(next.approval_queue || [])];
  }

  if (!found) {
    throw httpError(`Budget request not found: ${requestId}`, 404);
  }

  next.meta = { ...(next.meta || {}), last_updated: nowIso() };
  return { draft: next, request: found };
}

async function materializeApprovedPosition(queryable, row, request, approvedPosition, userName) {
  const materializedVersion = Number(row.version) || 1.0;
  const materializedFrom = new Date();

  await queryable.query(
    `INSERT INTO wp_budget_requests (
      request_id, department, position_title, grade, headcount, proposed_budget,
      justification, status, submitted_by, submitted_on, priority, current_approver,
      workflow_instance_id, version, version_status, effective_from, modified_by
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
    ON CONFLICT (request_id) DO UPDATE SET
      department = EXCLUDED.department,
      position_title = EXCLUDED.position_title,
      grade = EXCLUDED.grade,
      headcount = EXCLUDED.headcount,
      proposed_budget = EXCLUDED.proposed_budget,
      justification = EXCLUDED.justification,
      status = EXCLUDED.status,
      submitted_by = EXCLUDED.submitted_by,
      submitted_on = EXCLUDED.submitted_on,
      priority = EXCLUDED.priority,
      current_approver = EXCLUDED.current_approver,
      workflow_instance_id = EXCLUDED.workflow_instance_id,
      modified_by = EXCLUDED.modified_by,
      modified_on = NOW()`,
    [
      request.id,
      request.department,
      request.position,
      request.grade || null,
      request.headcount || 1,
      request.proposed_budget || 0,
      request.justification || null,
      "Approved",
      request.submitted_by || null,
      request.submitted_on || null,
      request.priority || "Medium",
      null,
      request.workflow_instance_id || null,
      materializedVersion,
      "Published",
      materializedFrom,
      userName
    ]
  );

  await queryable.query(
    `INSERT INTO wp_approved_positions (
      position_id, source_request_id, department, position_title, grade, headcount,
      budget_approved, budget_consumed, remaining_budget, expiry_date,
      requisitions_created, status, version, version_status, effective_from, modified_by
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
    ON CONFLICT (position_id) DO UPDATE SET
      source_request_id = EXCLUDED.source_request_id,
      department = EXCLUDED.department,
      position_title = EXCLUDED.position_title,
      grade = EXCLUDED.grade,
      headcount = EXCLUDED.headcount,
      budget_approved = EXCLUDED.budget_approved,
      remaining_budget = EXCLUDED.remaining_budget,
      expiry_date = EXCLUDED.expiry_date,
      status = EXCLUDED.status,
      modified_by = EXCLUDED.modified_by,
      modified_on = NOW()`,
    [
      approvedPosition.id,
      approvedPosition.source_request_id || null,
      approvedPosition.department,
      approvedPosition.position,
      approvedPosition.grade || null,
      approvedPosition.headcount || 1,
      approvedPosition.budget_approved || 0,
      approvedPosition.budget_consumed || 0,
      approvedPosition.remaining_budget || 0,
      approvedPosition.expiry_date || null,
      approvedPosition.requisitions_created || 0,
      approvedPosition.status || "Active",
      materializedVersion,
      "Published",
      materializedFrom,
      userName
    ]
  );

  await queryable.query(
    `INSERT INTO wp_position_lifecycle (position_id, event_type, from_status, to_status, actor, comments)
     VALUES ($1,'Approved','Draft','Active',$2,$3)`,
    [
      approvedPosition.id,
      userName,
      `Approved via workflow ${request.workflow_instance_id || ""}`
    ]
  );
}

/**
 * Intermediate approval step activated (e.g. L1 → L2).
 */
async function handleBudgetStepActivated(queryable, event, req) {
  if (!isBudgetWorkflowEvent(event)) {
    return { businessActionCompleted: false, reason: "not_budget" };
  }

  const user = userContext(req);
  const requestId = resolveBudgetRequestId(event);
  if (!requestId) {
    throw httpError("Budget request id missing from workflow context.", 400);
  }

  const row = await lockWorkforceDraft(queryable);
  const draft = clonePayload(row.draft_payload);
  const nextApprover = event.activatedAssignee || null;
  const comments = event.comments || null;

  const { draft: nextDraft, request } = updateBudgetInDraft(draft, requestId, (item) =>
    appendTimelineEntry(
      {
        ...item,
        status: BUDGET_PENDING_LEVEL_2_STATUS,
        current_approver: nextApprover || item.current_approver || "Level-2 Approver",
        workflow_instance_id: event.instanceId
      },
      "Level-1 Approved",
      user.name,
      comments
    )
  );

  await persistWorkforceDraft(queryable, nextDraft, user.name);

  await writeEnterpriseAudit(queryable, {
    eventType: "BudgetRouted",
    module: "Workforce Planning",
    entity: "Budget Request",
    entityId: requestId,
    action: `Budget routed to Level-2 approval`,
    previousValue: BUDGET_PENDING_LEVEL_1_STATUS,
    newValue: BUDGET_PENDING_LEVEL_2_STATUS,
    userName: user.name,
    userRole: user.role,
    metadata: {
      workflow_instance_id: event.instanceId,
      activated_task_id: event.activatedTaskId || null,
      comments,
      notify_next_approver: "placeholder"
    }
  });

  return {
    businessActionCompleted: true,
    budget_request_id: requestId,
    status: request.status,
    current_approver: request.current_approver
  };
}

/**
 * Final approval — create Approved Position once.
 */
async function handleBudgetWorkflowCompleted(queryable, event, req) {
  if (!isBudgetWorkflowEvent(event)) {
    return { businessActionCompleted: false, reason: "not_budget" };
  }

  const user = userContext(req);
  const requestId = resolveBudgetRequestId(event);
  if (!requestId) {
    throw httpError("Budget request id missing from workflow context.", 400);
  }

  const row = await lockWorkforceDraft(queryable);
  const draft = clonePayload(row.draft_payload);
  const comments = event.comments || null;

  let approvedPosition = null;
  const prior = (draft.approval_queue || []).find((item) => item.id === requestId)
    || (draft.budget_requests || []).find((item) => item.id === requestId);

  if (!prior) {
    throw httpError(`Budget request not found: ${requestId}`, 404);
  }

  const timelineStep =
    prior.status === BUDGET_PENDING_LEVEL_2_STATUS
      ? "Level-2 Approved"
      : "Approved";

  const { draft: nextDraft, request } = updateBudgetInDraft(draft, requestId, (item) => {
    approvedPosition = {
      id: `AP-2026-${String((draft.approved_positions || []).length + 90).padStart(4, "0")}`,
      department: item.department,
      position: item.position,
      grade: item.grade,
      headcount: item.headcount,
      budget_approved: item.proposed_budget,
      budget_consumed: 0,
      remaining_budget: item.proposed_budget,
      expiry_date: "2026-12-31",
      requisitions_created: 0,
      status: "Active",
      source_request_id: item.id
    };

    return appendTimelineEntry(
      {
        ...item,
        status: "Approved",
        current_approver: null,
        workflow_instance_id: event.instanceId
      },
      timelineStep === "Level-2 Approved" ? "Level-2 Approved" : "Approved",
      user.name,
      comments
    );
  });

  // Ensure final Approved timeline entry when Level-2 Approved was recorded
  if (timelineStep === "Level-2 Approved") {
    const idx = nextDraft.approval_queue.findIndex((item) => item.id === requestId);
    if (idx >= 0) {
      nextDraft.approval_queue[idx] = appendTimelineEntry(
        nextDraft.approval_queue[idx],
        "Approved",
        user.name,
        comments
      );
    }
  }

  nextDraft.approved_positions = [
    approvedPosition,
    ...(nextDraft.approved_positions || [])
  ];
  nextDraft.dashboard = {
    ...(nextDraft.dashboard || {}),
    approved_headcount:
      Number(nextDraft.dashboard?.approved_headcount || 0) + Number(request.headcount || 0),
    vacant_positions:
      Number(nextDraft.dashboard?.vacant_positions || 0) + Number(request.headcount || 0)
  };

  await persistWorkforceDraft(queryable, nextDraft, user.name);
  await materializeApprovedPosition(
    queryable,
    row,
    { ...request, workflow_instance_id: event.instanceId },
    approvedPosition,
    user.name
  );

  await writeEnterpriseAudit(queryable, {
    eventType: "BudgetApproved",
    module: "Workforce Planning",
    entity: "Budget Request",
    entityId: requestId,
    action: `Budget approved for ${request.position}`,
    previousValue: prior.status,
    newValue: "Approved",
    userName: user.name,
    userRole: user.role,
    metadata: {
      workflow_instance_id: event.instanceId,
      completed_by_task_id: event.completedByTaskId || null,
      approved_position_id: approvedPosition.id,
      comments
    }
  });

  await writeEnterpriseAudit(queryable, {
    eventType: "BudgetCompleted",
    module: "Workforce Planning",
    entity: "Budget Request",
    entityId: requestId,
    action: "Budget workflow completed",
    previousValue: prior.status,
    newValue: "Approved",
    userName: user.name,
    userRole: user.role,
    metadata: {
      workflow_instance_id: event.instanceId,
      approved_position_id: approvedPosition.id
    }
  });

  return {
    businessActionCompleted: true,
    budget_request_id: requestId,
    status: "Approved",
    approved_position_id: approvedPosition.id
  };
}

async function handleBudgetWorkflowRejected(queryable, event, req) {
  if (!isBudgetWorkflowEvent(event)) {
    return { businessActionCompleted: false, reason: "not_budget" };
  }

  const user = userContext(req);
  const requestId = resolveBudgetRequestId(event);
  if (!requestId) {
    throw httpError("Budget request id missing from workflow context.", 400);
  }

  const row = await lockWorkforceDraft(queryable);
  const draft = clonePayload(row.draft_payload);
  const comments = event.comments || null;
  const prior = (draft.approval_queue || []).find((item) => item.id === requestId)
    || (draft.budget_requests || []).find((item) => item.id === requestId);

  const { draft: nextDraft } = updateBudgetInDraft(draft, requestId, (item) =>
    appendTimelineEntry(
      {
        ...item,
        status: "Rejected",
        current_approver: null,
        workflow_instance_id: event.instanceId
      },
      "Rejected",
      user.name,
      comments
    )
  );

  await persistWorkforceDraft(queryable, nextDraft, user.name);

  await writeEnterpriseAudit(queryable, {
    eventType: "BudgetRejected",
    module: "Workforce Planning",
    entity: "Budget Request",
    entityId: requestId,
    action: `Budget rejected for ${prior?.position || requestId}`,
    previousValue: prior?.status || null,
    newValue: "Rejected",
    userName: user.name,
    userRole: user.role,
    metadata: {
      workflow_instance_id: event.instanceId,
      rejected_by_task_id: event.rejectedByTaskId || null,
      comments
    }
  });

  return {
    businessActionCompleted: true,
    budget_request_id: requestId,
    status: "Rejected"
  };
}

async function handleBudgetClarificationRequested(queryable, event, req) {
  if (!isBudgetWorkflowEvent(event)) {
    return { businessActionCompleted: false, reason: "not_budget" };
  }

  const user = userContext(req);
  const requestId = resolveBudgetRequestId(event);
  if (!requestId) {
    throw httpError("Budget request id missing from workflow context.", 400);
  }

  const row = await lockWorkforceDraft(queryable);
  const draft = clonePayload(row.draft_payload);
  const comments = event.comments || null;
  const prior = (draft.approval_queue || []).find((item) => item.id === requestId)
    || (draft.budget_requests || []).find((item) => item.id === requestId);

  const { draft: nextDraft, request } = updateBudgetInDraft(draft, requestId, (item) =>
    appendTimelineEntry(
      {
        ...item,
        status: "Clarification Requested",
        workflow_instance_id: event.instanceId,
        clarification_resume_status:
          item.status === BUDGET_PENDING_LEVEL_2_STATUS
            || item.clarification_resume_status === BUDGET_PENDING_LEVEL_2_STATUS
            ? BUDGET_PENDING_LEVEL_2_STATUS
            : BUDGET_PENDING_LEVEL_1_STATUS
      },
      "Clarification Requested",
      user.name,
      comments
    )
  );

  await persistWorkforceDraft(queryable, nextDraft, user.name);

  await writeEnterpriseAudit(queryable, {
    eventType: "ClarificationRequested",
    module: "Workforce Planning",
    entity: "Budget Request",
    entityId: requestId,
    action: "Clarification requested on budget request",
    previousValue: prior?.status || null,
    newValue: "Clarification Requested",
    userName: user.name,
    userRole: user.role,
    metadata: {
      workflow_instance_id: event.instanceId,
      task_id: event.taskId || null,
      comments,
      requestor_employee_code: request.submitted_by_employee_code || null
    }
  });

  return {
    businessActionCompleted: true,
    budget_request_id: requestId,
    status: "Clarification Requested",
    requestor_employee_code: request.submitted_by_employee_code || null,
    resume_status: request.clarification_resume_status || BUDGET_PENDING_LEVEL_1_STATUS
  };
}

async function handleBudgetClarificationSubmitted(queryable, event, req) {
  if (!isBudgetWorkflowEvent(event)) {
    return { businessActionCompleted: false, reason: "not_budget" };
  }

  const user = userContext(req);
  const requestId = resolveBudgetRequestId(event);
  if (!requestId) {
    throw httpError("Budget request id missing from workflow context.", 400);
  }

  const row = await lockWorkforceDraft(queryable);
  const draft = clonePayload(row.draft_payload);
  const comments = event.comments || null;
  const prior = (draft.approval_queue || []).find((item) => item.id === requestId)
    || (draft.budget_requests || []).find((item) => item.id === requestId);

  const resumeStatus =
    prior?.clarification_resume_status
    || (prior?.status === BUDGET_PENDING_LEVEL_2_STATUS
      ? BUDGET_PENDING_LEVEL_2_STATUS
      : BUDGET_PENDING_LEVEL_1_STATUS);

  const { draft: nextDraft, request } = updateBudgetInDraft(draft, requestId, (item) =>
    appendTimelineEntry(
      {
        ...item,
        status: resumeStatus,
        workflow_instance_id: event.instanceId,
        current_approver: event.reactivatedAssignee || item.current_approver
      },
      "Clarification Submitted",
      user.name,
      comments
    )
  );

  await persistWorkforceDraft(queryable, nextDraft, user.name);

  await writeEnterpriseAudit(queryable, {
    eventType: "ClarificationSubmitted",
    module: "Workforce Planning",
    entity: "Budget Request",
    entityId: requestId,
    action: "Clarification submitted — workflow resumed",
    previousValue: "Clarification Requested",
    newValue: resumeStatus,
    userName: user.name,
    userRole: user.role,
    metadata: {
      workflow_instance_id: event.instanceId,
      comments,
      resumed_task_id: event.reactivatedTaskId || null
    }
  });

  await writeEnterpriseAudit(queryable, {
    eventType: "BudgetResumed",
    module: "Workforce Planning",
    entity: "Budget Request",
    entityId: requestId,
    action: "Budget approval resumed at same level",
    previousValue: "Clarification Requested",
    newValue: resumeStatus,
    userName: user.name,
    userRole: user.role,
    metadata: {
      workflow_instance_id: event.instanceId,
      approval_route_id: request.approval_route_id || null,
      same_instance: true
    }
  });

  return {
    businessActionCompleted: true,
    budget_request_id: requestId,
    status: resumeStatus
  };
}

module.exports = {
  isBudgetWorkflowEvent,
  resolveBudgetRequestId,
  handleBudgetStepActivated,
  handleBudgetWorkflowCompleted,
  handleBudgetWorkflowRejected,
  handleBudgetClarificationRequested,
  handleBudgetClarificationSubmitted,
  BUDGET_PENDING_LEVEL_1_STATUS,
  BUDGET_PENDING_LEVEL_2_STATUS
};
