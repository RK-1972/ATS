/**
 * Offer domain reactions to Workflow Engine events.
 * Owns om_offers status, om_offer_approvals sync, history, and audit.
 * Does not own workflow task chaining — that stays in workflowService.
 */

const { writeEnterpriseAudit, userContext } = require("./enterpriseAuditService");

const MIRROR_VERSION_STATUS_PUBLISHED = "Published";

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
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

function isOfferWorkflowEvent(event = {}) {
  const workflowCode = String(event.workflowCode || "").toUpperCase();
  if (workflowCode === "OFFER") {
    return true;
  }

  const context = parseContext(event.executionContext);
  const meta = context.meta && typeof context.meta === "object" ? context.meta : {};
  const documentType = String(meta.document_type || "").toUpperCase();
  const instanceId = String(event.instanceId || "");

  return (
    documentType === "OFFER"
    || Boolean(meta.offer_id)
    || instanceId.startsWith("WF-OFF-")
  );
}

function resolveOfferId(event = {}) {
  const context = parseContext(event.executionContext);
  const meta = context.meta && typeof context.meta === "object" ? context.meta : {};

  if (meta.offer_id) {
    return String(meta.offer_id);
  }

  const instanceId = String(event.instanceId || "");
  if (instanceId.startsWith("WF-OFF-")) {
    return instanceId.replace(/^WF-OFF-/, "");
  }

  return null;
}

async function lockOffer(queryable, offerId) {
  const result = await queryable.query(
    `SELECT *
     FROM om_offers
     WHERE offer_id = $1
     FOR UPDATE`,
    [offerId]
  );

  if (!result.rows[0]) {
    throw httpError(`Offer not found: ${offerId}`, 404);
  }

  return result.rows[0];
}

async function getTaskTitle(queryable, taskId) {
  if (!taskId) {
    return null;
  }

  const result = await queryable.query(
    `SELECT title
     FROM wf_tasks
     WHERE task_id = $1`,
    [taskId]
  );

  return result.rows[0]?.title || null;
}

async function recordOfferHistory(
  queryable,
  offerId,
  eventType,
  actor,
  actorRole,
  fromStatus,
  toStatus,
  comments,
  metadata
) {
  await queryable.query(
    `INSERT INTO om_offer_history (
      offer_id, event_type, from_status, to_status, actor, actor_role, comments, metadata
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      offerId,
      eventType,
      fromStatus || null,
      toStatus || null,
      actor,
      actorRole || null,
      comments || null,
      metadata ? JSON.stringify(metadata) : null
    ]
  );
}

async function syncCompletedApprovalStep(queryable, offerId, completedTaskId, user, comments) {
  const taskTitle = await getTaskTitle(queryable, completedTaskId);
  if (!taskTitle) {
    return null;
  }

  const offerRow = await lockOffer(queryable, offerId);

  const result = await queryable.query(
    `UPDATE om_offer_approvals
     SET approval_status = 'Approved',
         approver_name = $1,
         approved_on = NOW(),
         comments = COALESCE($2, comments)
     WHERE offer_id = $3
       AND approval_step = $4
       AND approval_status IN ('Pending', 'Waiting')
       AND version_status = $5
       AND version = $6
     RETURNING *`,
    [
      user.name,
      comments || null,
      offerId,
      taskTitle,
      MIRROR_VERSION_STATUS_PUBLISHED,
      Number(offerRow.version)
    ]
  );

  return result.rows[0] || null;
}

async function syncActivatedApprovalStep(queryable, offerId, activatedTaskId) {
  const taskTitle = await getTaskTitle(queryable, activatedTaskId);
  if (!taskTitle) {
    return null;
  }

  const offerRow = await lockOffer(queryable, offerId);

  const result = await queryable.query(
    `UPDATE om_offer_approvals
     SET approval_status = 'Pending'
     WHERE offer_id = $1
       AND approval_step = $2
       AND approval_status = 'Waiting'
       AND version_status = $3
       AND version = $4
     RETURNING *`,
    [offerId, taskTitle, MIRROR_VERSION_STATUS_PUBLISHED, Number(offerRow.version)]
  );

  return result.rows[0] || null;
}

/**
 * Intermediate approval step activated (e.g. Step 1 → Step 2).
 */
async function handleOfferStepActivated(queryable, event, req) {
  if (!isOfferWorkflowEvent(event)) {
    return { businessActionCompleted: false, reason: "not_offer" };
  }

  const user = userContext(req);
  const offerId = resolveOfferId(event);
  if (!offerId) {
    throw httpError("Offer id missing from workflow context.", 400);
  }

  const offerRow = await lockOffer(queryable, offerId);
  const comments = event.comments || null;

  const completedStep = await syncCompletedApprovalStep(
    queryable,
    offerId,
    event.completedByTaskId,
    user,
    comments
  );
  const activatedStep = await syncActivatedApprovalStep(
    queryable,
    offerId,
    event.activatedTaskId
  );

  await writeEnterpriseAudit(queryable, {
    eventType: "OfferRouted",
    module: "Offer Management",
    entity: "Offer",
    entityId: offerId,
    action: "Offer routed to next approval step",
    previousValue: offerRow.offer_status,
    newValue: offerRow.offer_status,
    userName: user.name,
    userRole: user.role,
    metadata: {
      workflow_instance_id: event.instanceId,
      completed_task_id: event.completedByTaskId || null,
      activated_task_id: event.activatedTaskId || null,
      activated_assignee: event.activatedAssignee || null,
      completed_approval_step: completedStep?.approval_step || null,
      activated_approval_step: activatedStep?.approval_step || null,
      comments
    }
  });

  return {
    businessActionCompleted: true,
    offer_id: offerId,
    status: offerRow.offer_status,
    activated_approval_step: activatedStep?.approval_step || null
  };
}

/**
 * Final approval — mark offer Approved once all workflow steps complete.
 */
async function handleOfferWorkflowCompleted(queryable, event, req) {
  if (!isOfferWorkflowEvent(event)) {
    return { businessActionCompleted: false, reason: "not_offer" };
  }

  const user = userContext(req);
  const offerId = resolveOfferId(event);
  if (!offerId) {
    throw httpError("Offer id missing from workflow context.", 400);
  }

  const offerRow = await lockOffer(queryable, offerId);
  const priorStatus = offerRow.offer_status;
  const comments = event.comments || null;

  await syncCompletedApprovalStep(
    queryable,
    offerId,
    event.completedByTaskId,
    user,
    comments
  );

  await queryable.query(
    `UPDATE om_offers
     SET offer_status = 'Approved',
         modified_by = $1,
         modified_on = NOW()
     WHERE offer_id = $2`,
    [user.name, offerId]
  );

  await recordOfferHistory(
    queryable,
    offerId,
    "OfferApproved",
    user.name,
    user.role,
    priorStatus,
    "Approved",
    comments,
    {
      workflow_instance_id: event.instanceId,
      completed_by_task_id: event.completedByTaskId || null
    }
  );

  await writeEnterpriseAudit(queryable, {
    eventType: "OfferApproved",
    module: "Offer Management",
    entity: "Offer",
    entityId: offerId,
    action: `Offer approved for ${offerRow.candidate_name || offerId}`,
    previousValue: priorStatus,
    newValue: "Approved",
    userName: user.name,
    userRole: user.role,
    metadata: {
      workflow_instance_id: event.instanceId,
      completed_by_task_id: event.completedByTaskId || null,
      comments
    }
  });

  await writeEnterpriseAudit(queryable, {
    eventType: "OfferCompleted",
    module: "Offer Management",
    entity: "Offer",
    entityId: offerId,
    action: "Offer approval workflow completed",
    previousValue: priorStatus,
    newValue: "Approved",
    userName: user.name,
    userRole: user.role,
    metadata: {
      workflow_instance_id: event.instanceId
    }
  });

  const offerLetterService = require("./offerLetterService");
  await offerLetterService.ensureAwaitingLetterForOffer(queryable, offerId);

  return {
    businessActionCompleted: true,
    offer_id: offerId,
    status: "Approved"
  };
}

async function handleOfferWorkflowRejected(queryable, event, req) {
  if (!isOfferWorkflowEvent(event)) {
    return { businessActionCompleted: false, reason: "not_offer" };
  }

  const user = userContext(req);
  const offerId = resolveOfferId(event);
  if (!offerId) {
    throw httpError("Offer id missing from workflow context.", 400);
  }

  const offerRow = await lockOffer(queryable, offerId);
  const priorStatus = offerRow.offer_status;
  const comments = event.comments || null;
  const rejectedTaskTitle = await getTaskTitle(queryable, event.rejectedByTaskId);
  const submissionVersion = Number(offerRow.version);

  if (rejectedTaskTitle) {
    await queryable.query(
      `UPDATE om_offer_approvals
       SET approval_status = 'Rejected',
           approver_name = $1,
           approved_on = NOW(),
           comments = COALESCE($2, comments)
       WHERE offer_id = $3
         AND approval_step = $4
         AND version_status = $5
         AND version = $6`,
      [
        user.name,
        comments || null,
        offerId,
        rejectedTaskTitle,
        MIRROR_VERSION_STATUS_PUBLISHED,
        submissionVersion
      ]
    );
  }

  await queryable.query(
    `UPDATE om_offer_approvals
     SET approval_status = 'Cancelled'
     WHERE offer_id = $1
       AND approval_status = 'Waiting'
       AND version_status = $2
       AND version = $3`,
    [offerId, MIRROR_VERSION_STATUS_PUBLISHED, submissionVersion]
  );

  await queryable.query(
    `UPDATE om_offers
     SET offer_status = 'Withdrawn',
         modified_by = $1,
         modified_on = NOW()
     WHERE offer_id = $2`,
    [user.name, offerId]
  );

  await recordOfferHistory(
    queryable,
    offerId,
    "OfferWithdrawn",
    user.name,
    user.role,
    priorStatus,
    "Withdrawn",
    comments,
    {
      workflow_instance_id: event.instanceId,
      rejected_by_task_id: event.rejectedByTaskId || null
    }
  );

  await writeEnterpriseAudit(queryable, {
    eventType: "OfferRejected",
    module: "Offer Management",
    entity: "Offer",
    entityId: offerId,
    action: `Offer rejected during approval for ${offerRow.candidate_name || offerId}`,
    previousValue: priorStatus,
    newValue: "Withdrawn",
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
    offer_id: offerId,
    status: "Withdrawn"
  };
}

async function resolveOfferRequestorEmployeeCode(queryable, offerRow) {
  const keys = [offerRow.recruiter_id, offerRow.created_by].filter(Boolean);

  for (const key of keys) {
    const lookupKey = String(key).trim();
    if (!lookupKey) {
      continue;
    }

    const result = await queryable.query(
      `SELECT employee_code
       FROM user_mstr
       WHERE (
         employee_code = $1
         OR email_id = $1
         OR full_name = $1
       )
       AND COALESCE(is_active, TRUE) = TRUE
       LIMIT 1`,
      [lookupKey]
    );

    if (result.rows[0]?.employee_code) {
      return String(result.rows[0].employee_code).trim();
    }
  }

  return null;
}

const OFFER_CLARIFICATION_REQUESTOR_UNRESOLVED_MESSAGE =
  "Cannot request clarification because the offer requester could not be resolved to an active user.";

/**
 * Fail before send-back when no authoritative requester employee_code exists.
 */
async function assertOfferClarificationRequestorResolvable(queryable, offerId) {
  const offerRow = await lockOffer(queryable, offerId);
  const requestorEmployeeCode = await resolveOfferRequestorEmployeeCode(queryable, offerRow);

  if (!requestorEmployeeCode) {
    throw httpError(OFFER_CLARIFICATION_REQUESTOR_UNRESOLVED_MESSAGE, 409);
  }

  return requestorEmployeeCode;
}

/**
 * Clarification requested — mirrors requisition/budget domain hooks (operational audit only;
 * offer_status stays Pending Approval).
 */
async function handleOfferClarificationRequested(queryable, event, req) {
  if (!isOfferWorkflowEvent(event)) {
    return { businessActionCompleted: false, reason: "not_offer" };
  }

  const user = userContext(req);
  const offerId = resolveOfferId(event);
  if (!offerId) {
    throw httpError("Offer id missing from workflow context.", 400);
  }

  const offerRow = await lockOffer(queryable, offerId);
  const priorStatus = offerRow.offer_status;
  const requestorEmployeeCode = await resolveOfferRequestorEmployeeCode(queryable, offerRow);

  if (!requestorEmployeeCode) {
    throw httpError(OFFER_CLARIFICATION_REQUESTOR_UNRESOLVED_MESSAGE, 409);
  }

  await recordOfferHistory(
    queryable,
    offerId,
    "ClarificationRequested",
    user.name,
    user.role,
    priorStatus,
    priorStatus,
    event.comments || null,
    {
      workflow_instance_id: event.instanceId,
      task_id: event.taskId || null,
      source: "offer_clarification_requested"
    }
  );

  await writeEnterpriseAudit(queryable, {
    eventType: "ClarificationRequested",
    module: "Offer Management",
    entity: "Offer",
    entityId: offerId,
    action: "Clarification requested on offer approval",
    previousValue: priorStatus,
    newValue: priorStatus,
    userName: user.name,
    userRole: user.role,
    metadata: {
      workflow_instance_id: event.instanceId,
      workflow_code: event.workflowCode,
      task_id: event.taskId || null,
      comments: event.comments || null,
      source: "offer_clarification_requested"
    }
  });

  return {
    businessActionCompleted: true,
    offer_id: offerId,
    status: priorStatus,
    requestor_employee_code: requestorEmployeeCode
  };
}

async function handleOfferClarificationSubmitted(queryable, event, req) {
  if (!isOfferWorkflowEvent(event)) {
    return { businessActionCompleted: false, reason: "not_offer" };
  }

  const user = userContext(req);
  const offerId = resolveOfferId(event);
  if (!offerId) {
    throw httpError("Offer id missing from workflow context.", 400);
  }

  const offerRow = await lockOffer(queryable, offerId);
  const priorStatus = offerRow.offer_status;

  await recordOfferHistory(
    queryable,
    offerId,
    "ClarificationSubmitted",
    user.name,
    user.role,
    priorStatus,
    priorStatus,
    event.comments || null,
    {
      workflow_instance_id: event.instanceId,
      reactivated_task_id: event.reactivatedTaskId || null,
      source: "offer_clarification_submitted"
    }
  );

  await writeEnterpriseAudit(queryable, {
    eventType: "ClarificationSubmitted",
    module: "Offer Management",
    entity: "Offer",
    entityId: offerId,
    action: "Clarification submitted — offer approval resumed",
    previousValue: priorStatus,
    newValue: priorStatus,
    userName: user.name,
    userRole: user.role,
    metadata: {
      workflow_instance_id: event.instanceId,
      workflow_code: event.workflowCode,
      reactivated_task_id: event.reactivatedTaskId || null,
      comments: event.comments || null,
      source: "offer_clarification_submitted"
    }
  });

  return {
    businessActionCompleted: true,
    offer_id: offerId,
    status: priorStatus
  };
}

module.exports = {
  isOfferWorkflowEvent,
  resolveOfferId,
  handleOfferStepActivated,
  handleOfferWorkflowCompleted,
  handleOfferWorkflowRejected,
  handleOfferClarificationRequested,
  handleOfferClarificationSubmitted,
  assertOfferClarificationRequestorResolvable,
  resolveOfferRequestorEmployeeCode
};
