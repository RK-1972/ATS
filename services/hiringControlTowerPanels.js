const {
  loadLifecycleContext,
  resolveBudgetWorkflowInstanceId
} = require("./hiringControlTowerLifecycle");

const DEFAULT_VARIANCE_THRESHOLD = 10;
const TERMINAL_OFFER_STATUSES = new Set(["Declined", "Withdrawn"]);
const MAX_ACTIVITY_EVENTS = 500;
const MAX_NOTIFICATION_DELIVERIES = 200;

function normalizeStatus(value) {
  return String(value || "").trim();
}

async function loadVarianceThreshold(pool) {
  const result = await pool.query(
    `SELECT COALESCE(max_budget_variance_pct, $1)::float AS threshold
     FROM pc_budget_governance
     ORDER BY modified_on DESC NULLS LAST
     LIMIT 1`,
    [DEFAULT_VARIANCE_THRESHOLD]
  );

  return result.rows[0]?.threshold ?? DEFAULT_VARIANCE_THRESHOLD;
}

function selectPrimaryOffer(offers = []) {
  const qualifying = offers.filter(
    (row) => !TERMINAL_OFFER_STATUSES.has(normalizeStatus(row.offer_status))
  );

  return qualifying[0] || null;
}

function toLpa(inrAmount) {
  const value = Number(inrAmount || 0);
  return Math.round((value / 100000) * 10) / 10;
}

function mapWorkflowEventType(eventType) {
  const normalized = normalizeStatus(eventType).toLowerCase();

  if (normalized.includes("approv")) {
    return "approved";
  }

  if (normalized.includes("reject")) {
    return "rejected";
  }

  if (normalized.includes("clarif")) {
    return "clarification";
  }

  if (normalized.includes("assign")) {
    return "assigned";
  }

  if (normalized.includes("escalat")) {
    return "escalated";
  }

  return "submitted";
}

function mapWfHistoryRow(row) {
  return {
    id: `wf-${row.history_id}`,
    time: row.recorded_on,
    actor: row.actor || "System",
    role: row.actor_role || "Workflow",
    action: row.action,
    event_type: mapWorkflowEventType(row.event_type),
    comment: row.comments || null,
    stage_key: row.stage_key || null
  };
}

function mapOfferHistoryRow(row) {
  const action = row.to_status
    ? `${row.event_type || "Offer"} — ${row.from_status || ""} → ${row.to_status}`.trim()
    : (row.event_type || "Offer update");

  return {
    id: `offer-${row.history_id}`,
    time: row.created_on,
    actor: row.actor || "System",
    role: row.actor_role || "Offer",
    action,
    event_type: mapWorkflowEventType(row.event_type),
    comment: row.comments || null,
    stage_key: "offer_progress"
  };
}

function collectWorkflowInstanceIds(requisition, ctx) {
  const ids = new Set();

  const budgetInstanceId = resolveBudgetWorkflowInstanceId(ctx.budgetRequest);
  if (budgetInstanceId) {
    ids.add(budgetInstanceId);
  }

  if (requisition.workflow_instance_id) {
    ids.add(requisition.workflow_instance_id);
  }

  for (const offer of ctx.offers) {
    if (offer.workflow_instance_id) {
      ids.add(offer.workflow_instance_id);
    }
  }

  return [...ids];
}

async function loadWorkflowHistory(pool, instanceIds) {
  if (!instanceIds.length) {
    return [];
  }

  const result = await pool.query(
    `SELECT history_id, instance_id, event_type, stage_key, actor, actor_role,
            action, comments, recorded_on
     FROM wf_history
     WHERE instance_id = ANY($1::varchar[])
     ORDER BY recorded_on ASC, history_id ASC`,
    [instanceIds]
  );

  return result.rows;
}

async function loadOfferHistoryChronological(pool, offerIds) {
  if (!offerIds.length) {
    return [];
  }

  const result = await pool.query(
    `SELECT history_id, offer_id, event_type, actor, actor_role,
            from_status, to_status, comments, created_on
     FROM om_offer_history
     WHERE offer_id = ANY($1::varchar[])
     ORDER BY created_on ASC, history_id ASC`,
    [offerIds]
  );

  return result.rows;
}

async function listNotificationDeliveriesForRequisition(pool, requisition) {
  const requisitionCode = normalizeStatus(requisition.requisition_code);
  const reqId = requisition.req_id;

  if (!requisitionCode) {
    return [];
  }

  const result = await pool.query(
    `SELECT delivery_id, event_key, recipient, channel, template_key, status,
            attempted_on, completed_on, metadata
     FROM notification_deliveries
     WHERE metadata->>'requisition_code' = $1
        OR ($2::int IS NOT NULL AND metadata->>'req_id' = $2::text)
     ORDER BY COALESCE(completed_on, attempted_on) ASC, delivery_id ASC
     LIMIT $3`,
    [requisitionCode, reqId ?? null, MAX_NOTIFICATION_DELIVERIES]
  );

  return result.rows;
}

function formatChannelLabel(channel) {
  const normalized = normalizeStatus(channel).toLowerCase();

  if (normalized === "email") {
    return "Email";
  }

  if (normalized === "in_app") {
    return "In-app";
  }

  if (normalized === "teams") {
    return "Teams";
  }

  if (normalized === "sms") {
    return "SMS";
  }

  if (normalized === "whatsapp") {
    return "WhatsApp";
  }

  return channel || "—";
}

async function buildApprovalPath(pool, instanceId) {
  if (!instanceId) {
    return [];
  }

  const result = await pool.query(
    `SELECT title, status, assignee
     FROM wf_tasks
     WHERE instance_id = $1
       AND (title ILIKE '%approval%' OR title ILIKE '%approve%')
     ORDER BY created_on ASC, task_id ASC`,
    [instanceId]
  );

  return result.rows.map((row) => {
    const status = normalizeStatus(row.status);

    let pathStatus = "Waiting";

    if (status === "Completed") {
      pathStatus = "Completed";
    } else if (status === "Pending") {
      pathStatus = "Running";
    } else if (status) {
      pathStatus = status;
    }

    return {
      step: row.title,
      owner: row.assignee || "—",
      status: pathStatus
    };
  });
}

function mergeActivityEvents(wfRows, offerRows) {
  const events = [
    ...wfRows.map(mapWfHistoryRow),
    ...offerRows.map(mapOfferHistoryRow)
  ];

  events.sort((a, b) => {
    const timeA = new Date(a.time).getTime();
    const timeB = new Date(b.time).getTime();

    if (timeA !== timeB) {
      return timeA - timeB;
    }

    return String(a.id).localeCompare(String(b.id));
  });

  if (events.length > MAX_ACTIVITY_EVENTS) {
    return events.slice(events.length - MAX_ACTIVITY_EVENTS);
  }

  return events;
}

function mapNotificationDeliveries(rows) {
  const deliveries = rows.map((row) => {
    const metadata = row.metadata && typeof row.metadata === "object"
      ? row.metadata
      : {};

    return {
      recipient: row.recipient,
      role: metadata.role || metadata.recipient_role || "—",
      channel: formatChannelLabel(row.channel),
      template: row.template_key || "—",
      status: row.status,
      time: row.completed_on || row.attempted_on
    };
  });

  return {
    title: deliveries.length
      ? "Notification delivery attempts"
      : null,
    deliveries
  };
}

async function buildOperationalPanels(pool, requisition) {
  const ctx = await loadLifecycleContext(pool, requisition);
  const threshold = await loadVarianceThreshold(pool);
  const primaryOffer = selectPrimaryOffer(ctx.offers);

  let budget;

  if (!primaryOffer) {
    budget = {
      has_offer: false,
      offer_id: null,
      approved_budget_lpa: null,
      offered_ctc_lpa: null,
      variance_pct: null,
      variance_threshold_pct: threshold,
      status: "No qualifying offer",
      exception_workflow_triggered: false,
      currency: "INR"
    };
  } else {
    const variancePct = Number(primaryOffer.variance_pct || 0);

    budget = {
      has_offer: true,
      offer_id: primaryOffer.offer_id,
      approved_budget_lpa: toLpa(primaryOffer.approved_budget),
      offered_ctc_lpa: toLpa(primaryOffer.offered_ctc),
      variance_pct: variancePct,
      variance_threshold_pct: threshold,
      status: variancePct > threshold ? "Exception Required" : "Within Budget",
      exception_workflow_triggered: variancePct > threshold,
      currency: primaryOffer.currency || "INR"
    };
  }

  const instanceIds = collectWorkflowInstanceIds(requisition, ctx);
  const offerIds = ctx.offers.map((row) => row.offer_id).filter(Boolean);

  const [wfHistoryRows, offerHistoryRows, notificationRows] = await Promise.all([
    loadWorkflowHistory(pool, instanceIds),
    loadOfferHistoryChronological(pool, offerIds),
    listNotificationDeliveriesForRequisition(pool, requisition)
  ]);

  const activityEvents = mergeActivityEvents(wfHistoryRows, offerHistoryRows);
  const notifications = mapNotificationDeliveries(notificationRows);

  const approvalInstanceId = primaryOffer?.workflow_instance_id
    || resolveBudgetWorkflowInstanceId(ctx.budgetRequest)
    || requisition.workflow_instance_id
    || null;

  const approvalPath = await buildApprovalPath(pool, approvalInstanceId);

  return {
    budget,
    approval_path: approvalPath,
    activity_events: activityEvents,
    notifications
  };
}

module.exports = {
  buildOperationalPanels,
  selectPrimaryOffer,
  loadVarianceThreshold
};
