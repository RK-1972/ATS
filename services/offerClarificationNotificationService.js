/**
 * Offer clarification in-app notification audit (bell feed uses workflow tasks;
 * this service records idempotent in_app deliveries per enterprise conventions).
 */

const notificationService = require("./notificationService");

const { NOTIFICATION_CHANNELS } = notificationService;

const EVENTS = {
  CLARIFICATION_REQUESTED: "offer_clarification_requested",
  CLARIFICATION_SUBMITTED: "offer_clarification_submitted"
};

const TEMPLATES = {
  CLARIFICATION_REQUESTED: "OFFER-CLARIFICATION-REQUESTED",
  CLARIFICATION_SUBMITTED: "OFFER-CLARIFICATION-SUBMITTED"
};

function buildRequestCorrelationId(offerId, approverTaskId) {
  return `offer-clarification-request-${String(offerId || "").trim()}-${Number(approverTaskId)}`;
}

function buildSubmittedCorrelationId(offerId, approverTaskId, submittedOnIso) {
  const roundKey = submittedOnIso
    ? String(submittedOnIso).slice(0, 19)
    : String(Date.now());
  return `offer-clarification-submitted-${String(offerId || "").trim()}-${Number(approverTaskId)}-${roundKey}`;
}

function buildContextMessage({ offerId, candidateName, requisitionCode, positionTitle }) {
  const parts = [`Offer ${offerId}`];
  if (candidateName) {
    parts.push(`(${candidateName})`);
  }
  if (requisitionCode) {
    parts.push(`· ${requisitionCode}`);
  }
  if (positionTitle) {
    parts.push(`· ${positionTitle}`);
  }
  return parts.join(" ");
}

async function notifyOfferClarificationRequested(
  pool,
  {
    offerId,
    requestorEmployeeCode,
    approverTaskId,
    comments,
    candidateName,
    requisitionCode,
    positionTitle
  }
) {
  const recipient = String(requestorEmployeeCode || "").trim();
  const normalizedOfferId = String(offerId || "").trim();

  if (!recipient || !normalizedOfferId || !approverTaskId) {
    return { skipped: true, reason: "missing_required_fields" };
  }

  const contextLabel = buildContextMessage({
    offerId: normalizedOfferId,
    candidateName,
    requisitionCode,
    positionTitle
  });

  return notificationService.send(pool, {
    event: EVENTS.CLARIFICATION_REQUESTED,
    recipient,
    channel: NOTIFICATION_CHANNELS.IN_APP,
    templateKey: TEMPLATES.CLARIFICATION_REQUESTED,
    correlationId: buildRequestCorrelationId(normalizedOfferId, approverTaskId),
    payload: {
      offer_id: normalizedOfferId,
      approver_task_id: Number(approverTaskId),
      title: "Offer clarification required",
      message: `${contextLabel} — an approver requested clarification. Open My Offer Requests to respond.`,
      comments_preview: String(comments || "").trim().slice(0, 500),
      requisition_code: requisitionCode || null,
      candidate_name: candidateName || null,
      position_title: positionTitle || null
    }
  });
}

async function notifyOfferClarificationSubmitted(
  pool,
  {
    offerId,
    approverEmployeeCode,
    approverTaskId,
    requestorName,
    candidateName,
    requisitionCode
  }
) {
  const recipient = String(approverEmployeeCode || "").trim();
  const normalizedOfferId = String(offerId || "").trim();

  if (!recipient || !normalizedOfferId || !approverTaskId) {
    return { skipped: true, reason: "missing_required_fields" };
  }

  const contextLabel = buildContextMessage({
    offerId: normalizedOfferId,
    candidateName,
    requisitionCode
  });

  const submittedOnIso = new Date().toISOString();
  const bellNotificationService = require("./bellNotificationService");

  return bellNotificationService.notifyOutcome(pool, EVENTS.CLARIFICATION_SUBMITTED, {
    recipientEmployeeCode: recipient,
    templateKey: TEMPLATES.CLARIFICATION_SUBMITTED,
    correlationId: buildSubmittedCorrelationId(
      normalizedOfferId,
      approverTaskId,
      submittedOnIso
    ),
    message: `${contextLabel} — ${requestorName || "The requester"} submitted a clarification response. Review in Pending Offer Approvals.`,
    routeState: {
      offerId: normalizedOfferId,
      taskId: Number(approverTaskId)
    },
    context: {
      offer_id: normalizedOfferId,
      document_number: normalizedOfferId,
      approver_task_id: Number(approverTaskId),
      task_id: Number(approverTaskId),
      submitted_by: requestorName || null,
      requisition_code: requisitionCode || null,
      candidate_name: candidateName || null
    }
  });
}

module.exports = {
  EVENTS,
  TEMPLATES,
  buildRequestCorrelationId,
  buildSubmittedCorrelationId,
  notifyOfferClarificationRequested,
  notifyOfferClarificationSubmitted
};
