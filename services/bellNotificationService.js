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

const TASK_LINKED_CLARIFICATION_EVENTS = new Set([
  "offer_clarification_submitted",
  "budget_clarification_submitted",
  "requisition_clarification_submitted"
]);

const INTERVIEW_SCHEDULE_BELL_EVENTS = new Set([
  "interview_scheduled",
  "interview_rescheduled"
]);

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
    interview_id:
      metadata.interview_id ||
      (INTERVIEW_SCHEDULE_BELL_EVENTS.has(String(row.event_key || ""))
        ? metadata.document_number || null
        : null),
    attempted_on: row.attempted_on,
    bell_dismissed:
      metadata.bell_dismissed === true || metadata.bell_dismissed === "true"
  };
}

function resolveBellTaskId(row) {
  const taskId = row?.task_id ?? row?.route_state?.taskId ?? null;
  if (taskId == null || taskId === "") {
    return null;
  }
  return Number(taskId);
}

async function loadActiveBellTaskIds(executor, employeeCode, taskIds) {
  const normalizedIds = [...new Set(taskIds.filter((id) => Number.isFinite(id)))];

  if (!normalizedIds.length) {
    return { reliable: true, ids: new Set() };
  }

  try {
    const result = await executor.query(
      `SELECT DISTINCT t.task_id
     FROM wf_tasks t
     INNER JOIN wf_assignments a ON a.task_id = t.task_id
     WHERE a.assignee = $1
       AND a.active = TRUE
       AND LOWER(t.status) = 'pending'
       AND t.task_id = ANY($2::bigint[])`,
      [employeeCode, normalizedIds]
    );

    return {
      reliable: true,
      ids: new Set(result.rows.map((row) => String(row.task_id)))
    };
  } catch (error) {
    console.error(
      "[bellNotificationService] active task lookup failed:",
      error.message
    );
    return { reliable: false, ids: new Set() };
  }
}

async function loadInterviewScheduleEligibility(executor, interviewIds) {
  const normalizedIds = [
    ...new Set(
      interviewIds.map((id) => String(id || "").trim()).filter(Boolean)
    )
  ];

  if (!normalizedIds.length) {
    return { reliable: true, byId: new Map() };
  }

  const byId = new Map(normalizedIds.map((id) => [id, "unknown"]));

  try {
    const result = await executor.query(
      `SELECT interview_id, interview_status
     FROM im_interviews
     WHERE interview_id = ANY($1::varchar[])`,
      [normalizedIds]
    );

    for (const row of result.rows) {
      const interviewId = String(row.interview_id || "").trim();
      if (!interviewId) {
        continue;
      }

      const status = String(row.interview_status || "").trim();
      if (status === "Scheduled") {
        byId.set(interviewId, "scheduled");
      } else if (status) {
        byId.set(interviewId, "not_scheduled");
      }
    }

    return { reliable: true, byId };
  } catch (error) {
    console.error(
      "[bellNotificationService] interview eligibility lookup failed:",
      error.message
    );
    return { reliable: false, byId: new Map() };
  }
}

async function filterResolvedActionBellRows(executor, employeeCode, rows) {
  const withoutDismissed = rows.filter((row) => !row.bell_dismissed);

  const clarificationTaskIds = [];
  const scheduleInterviewIds = [];

  withoutDismissed.forEach((row) => {
    const eventKey = String(row.event_key || "").trim();

    if (TASK_LINKED_CLARIFICATION_EVENTS.has(eventKey)) {
      const taskId = resolveBellTaskId(row);
      if (Number.isFinite(taskId)) {
        clarificationTaskIds.push(taskId);
      }
    }

    if (INTERVIEW_SCHEDULE_BELL_EVENTS.has(eventKey)) {
      const interviewId = String(
        row.interview_id || row.document_number || ""
      ).trim();
      if (interviewId) {
        scheduleInterviewIds.push(interviewId);
      }
    }
  });

  const [activeTaskLookup, interviewEligibility] = await Promise.all([
    loadActiveBellTaskIds(executor, employeeCode, clarificationTaskIds),
    loadInterviewScheduleEligibility(executor, scheduleInterviewIds)
  ]);

  return withoutDismissed.filter((row) => {
    const eventKey = String(row.event_key || "").trim();

    if (TASK_LINKED_CLARIFICATION_EVENTS.has(eventKey)) {
      const taskId = resolveBellTaskId(row);
      if (!Number.isFinite(taskId)) {
        return true;
      }
      if (!activeTaskLookup.reliable) {
        return true;
      }
      return activeTaskLookup.ids.has(String(taskId));
    }

    if (INTERVIEW_SCHEDULE_BELL_EVENTS.has(eventKey)) {
      const interviewId = String(
        row.interview_id || row.document_number || ""
      ).trim();
      if (!interviewId) {
        return true;
      }
      if (!interviewEligibility.reliable) {
        return true;
      }
      const eligibility = interviewEligibility.byId.get(interviewId) || "unknown";
      if (eligibility === "unknown") {
        return true;
      }
      return eligibility === "scheduled";
    }

    return true;
  });
}

function toBellNotificationResponse(row) {
  return {
    delivery_id: row.delivery_id,
    event_key: row.event_key,
    title: row.title,
    message: row.message,
    category: row.category,
    route: row.route,
    route_state: row.route_state,
    task_id: row.task_id,
    document_number: row.document_number,
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

  const mapped = result.rows
    .map(mapBellRow)
    .filter((row) => row.title && row.category);

  const activeRows = await filterResolvedActionBellRows(
    executor,
    recipient,
    mapped
  );

  return activeRows.map(toBellNotificationResponse);
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
