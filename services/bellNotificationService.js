/**
 * Bell items that must outlive a pending workflow assignment.
 * Persists idempotent in_app rows in notification_deliveries (no new schema).
 * The header Bell reads only rows addressed to the authenticated employee.
 */

const notificationService = require("./notificationService");

const { NOTIFICATION_CHANNELS } = notificationService;

const BELL_OUTCOMES = {
  offer_approved: {
    title: "Offer Approved",
    category: "offer",
    route: "/offers/my-requests"
  },
  offer_rejected: {
    title: "Offer Rejected",
    category: "offer",
    route: "/offers/my-requests"
  },
  offer_clarification_submitted: {
    title: "Offer Clarification Received",
    category: "offer",
    route: "/offers/pending-approvals"
  },
  budget_approved: {
    title: "Budget Approved",
    category: "budget",
    route: "/workforce-planning/requests"
  },
  budget_rejected: {
    title: "Budget Rejected",
    category: "budget",
    route: "/workforce-planning/requests"
  },
  budget_clarification_submitted: {
    title: "Budget Clarification Received",
    category: "budget",
    route: "/my-approvals"
  },
  requisition_approved: {
    title: "Requisition Approved",
    category: "resourceRequisition",
    route: "/requisition-queues/approved"
  },
  requisition_rejected: {
    title: "Requisition Rejected",
    category: "resourceRequisition",
    route: "/requisition-queues/rejected"
  },
  requisition_clarification_submitted: {
    title: "Requisition Clarification Received",
    category: "resourceRequisition",
    route: "/my-approvals"
  },
  headcount_change_approved: {
    title: "Headcount Change Approved",
    category: "resourceRequisition",
    route: "/requisition-queues/approved"
  },
  headcount_change_rejected: {
    title: "Headcount Change Rejected",
    category: "resourceRequisition",
    route: "/requisition-queues/rejected"
  },
  requisition_budget_change_approved: {
    title: "Requisition Budget Change Approved",
    category: "resourceRequisition",
    route: "/requisition-queues/approved"
  },
  requisition_budget_change_rejected: {
    title: "Requisition Budget Change Rejected",
    category: "resourceRequisition",
    route: "/requisition-queues/rejected"
  },
  interview_scheduled: {
    title: "Interview Scheduled",
    category: "interviewScheduled",
    route: "/interviewer"
  },
  interview_rescheduled: {
    title: "Interview Rescheduled",
    category: "interviewScheduled",
    route: "/interviewer"
  },
  interview_cancelled: {
    title: "Interview Cancelled",
    category: "interviewScheduled",
    route: "/interviewer"
  },
  feedback_submitted: {
    title: "Interview Feedback Submitted",
    category: "feedback",
    route: "/interviewer"
  },
  ownership_approved: {
    title: "Ownership Request Approved",
    category: "candidateOwnership",
    route: "/recruiter/ownership-requests"
  },
  ownership_rejected: {
    title: "Ownership Request Rejected",
    category: "candidateOwnership",
    route: "/recruiter/ownership-requests"
  },
  requisition_assigned: {
    title: "Requisition Assigned",
    category: "assignedRequisition",
    route: "/recruiter/my-requisitions"
  }
};

const BELL_LIST_LIMIT = 50;

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function beginSavepoint(executor) {
  try {
    await executor.query("SAVEPOINT bell_notify");
    return true;
  } catch (_error) {
    return false;
  }
}

async function releaseSavepoint(executor) {
  await executor.query("RELEASE SAVEPOINT bell_notify");
}

async function rollbackSavepoint(executor) {
  try {
    await executor.query("ROLLBACK TO SAVEPOINT bell_notify");
  } catch (_error) {
    // The surrounding transaction may already be aborted.
  }
}

/**
 * Resolve a persisted actor key to an active employee_code.
 * Email addresses that do not match a user are not used as Bell recipients.
 */
async function resolveActiveEmployeeCode(executor, key) {
  const lookup = String(key || "").trim();

  if (!lookup) {
    return null;
  }

  try {
    const result = await executor.query(
      `SELECT employee_code
       FROM user_mstr
       WHERE (
         employee_code = $1
         OR email_id = $1
         OR full_name = $1
       )
         AND COALESCE(is_active, TRUE) = TRUE
       LIMIT 1`,
      [lookup]
    );

    if (result.rows[0]?.employee_code) {
      return String(result.rows[0].employee_code).trim();
    }
  } catch (error) {
    console.error(
      "[bellNotificationService] recipient lookup failed:",
      error.message
    );
    return null;
  }

  return lookup.includes("@") ? null : lookup;
}

async function notifyBell(executor, params = {}) {
  const event = String(params.event || "").trim();
  const spec = BELL_OUTCOMES[event];
  const recipient = String(params.recipientEmployeeCode || "").trim();
  const correlationId = String(params.correlationId || "").trim();
  const message = String(params.message || "").trim();

  if (!spec || !recipient || !correlationId || !message) {
    return { skipped: true, reason: "missing_required_fields" };
  }

  const routeState =
    params.routeState && typeof params.routeState === "object"
      ? params.routeState
      : null;
  const context =
    params.context && typeof params.context === "object" ? params.context : {};

  const useSavepoint = await beginSavepoint(executor);

  try {
    const result = await notificationService.send(executor, {
      event,
      recipient,
      channel: NOTIFICATION_CHANNELS.IN_APP,
      templateKey: params.templateKey || null,
      correlationId,
      payload: {
        ...context,
        bell: true,
        title: params.title || spec.title,
        message,
        category: spec.category,
        route: params.route || spec.route,
        route_state: routeState,
        task_id: routeState?.taskId || context.task_id || null,
        document_number: context.documentNumber || context.document_number || null
      }
    });

    if (useSavepoint) {
      await releaseSavepoint(executor);
    }

    return {
      skipped: false,
      idempotentReplay: Boolean(result?.idempotentReplay),
      delivery: result?.delivery || null
    };
  } catch (error) {
    if (useSavepoint) {
      await rollbackSavepoint(executor);
    }

    console.error(
      `[bellNotificationService] ${event} delivery failed:`,
      error.message
    );

    return {
      skipped: true,
      reason: "delivery_failed",
      error: error.message
    };
  }
}

async function notifyOutcome(executor, event, params = {}) {
  const recipientEmployeeCode = params.recipientEmployeeCode
    ? String(params.recipientEmployeeCode).trim()
    : await resolveActiveEmployeeCode(executor, params.recipientKey);

  if (!recipientEmployeeCode) {
    return { skipped: true, reason: "recipient_unresolved" };
  }

  return notifyBell(executor, {
    ...params,
    event,
    recipientEmployeeCode
  });
}

function mapBellRow(row) {
  const metadata =
    row.metadata && typeof row.metadata === "object" ? row.metadata : {};
  const routeState =
    metadata.route_state && typeof metadata.route_state === "object"
      ? metadata.route_state
      : null;

  return {
    delivery_id: row.delivery_id,
    event_key: row.event_key,
    title: metadata.title || null,
    message: metadata.message || null,
    category: metadata.category || null,
    route: metadata.route || null,
    route_state: routeState,
    task_id: metadata.task_id || routeState?.taskId || null,
    document_number: metadata.document_number || null,
    attempted_on: row.attempted_on
  };
}

async function listBellNotifications(executor, employeeCode) {
  const recipient = String(employeeCode || "").trim();

  if (!recipient) {
    throw httpError("Employee code is required.", 401);
  }

  const result = await executor.query(
    `SELECT delivery_id, event_key, metadata, attempted_on
     FROM notification_deliveries
     WHERE recipient = $1
       AND channel = 'in_app'
       AND status <> 'Failed'
       AND COALESCE(metadata->>'bell', '') = 'true'
     ORDER BY attempted_on DESC, delivery_id DESC
     LIMIT $2`,
    [recipient, BELL_LIST_LIMIT]
  );

  return result.rows.map(mapBellRow).filter((row) => row.title && row.category);
}

module.exports = {
  BELL_OUTCOMES,
  BELL_LIST_LIMIT,
  resolveActiveEmployeeCode,
  notifyBell,
  notifyOutcome,
  listBellNotifications,
  mapBellRow
};
