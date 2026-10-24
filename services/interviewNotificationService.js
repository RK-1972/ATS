/**
 * Phase 6C-5 — interview schedule candidate email notifications.
 */

const notificationService = require("./notificationService");

const { NOTIFICATION_CHANNELS, config: notificationConfigResolver } =
  notificationService;

const INTERVIEW_NOTIFICATION_EVENTS = {
  INTERVIEW_SCHEDULED: "interview_scheduled",
  INTERVIEW_CANCELLED_OFFER_HOLD: "interview_cancelled_offer_hold"
};

const INTERVIEW_NOTIFICATION_TEMPLATES = {
  INTERVIEW_SCHEDULED: "INTERVIEW-SCHEDULED",
  INTERVIEW_CANCELLED_OFFER_HOLD: "INTERVIEW-CANCELLED-OFFER-HOLD"
};

let interviewEmailDelivererOverride = null;
let interviewCancelledEmailDelivererOverride = null;

function setInterviewEmailDeliverer(deliverer) {
  interviewEmailDelivererOverride = deliverer;
}

function clearInterviewEmailDeliverer() {
  interviewEmailDelivererOverride = null;
}

function setInterviewCancelledEmailDeliverer(deliverer) {
  interviewCancelledEmailDelivererOverride = deliverer;
}

function clearInterviewCancelledEmailDeliverer() {
  interviewCancelledEmailDelivererOverride = null;
}

function buildInterviewScheduledCorrelationId(interviewId) {
  return `interview-scheduled-${String(interviewId || "").trim()}`;
}

function buildOfferHoldCancelCorrelationId(holdId, interviewId, recipientEmail) {
  const hold = String(holdId || "").trim();
  const interview = String(interviewId || "").trim();
  const recipient = String(recipientEmail || "")
    .trim()
    .toLowerCase();

  return `offer-hold-cancel-${hold}-${interview}-${recipient}`;
}

async function shouldAttemptEmailDelivery(pool) {
  const config = await notificationConfigResolver.loadNotificationConfig(pool);
  return notificationConfigResolver.isDeliverableChannel(
    config,
    NOTIFICATION_CHANNELS.EMAIL
  );
}

async function executeInterviewEmail(deliverInterviewEmail, ...args) {
  if (interviewEmailDelivererOverride) {
    return interviewEmailDelivererOverride(...args);
  }

  return deliverInterviewEmail(...args);
}

async function executeInterviewCancelledEmail(deliverFn, ...args) {
  if (interviewCancelledEmailDelivererOverride) {
    return interviewCancelledEmailDelivererOverride(...args);
  }

  return deliverFn(...args);
}

function formatInterviewDateLabel(interviewDate) {
  const parsed = new Date(interviewDate);
  if (Number.isNaN(parsed.getTime())) {
    return String(interviewDate || "");
  }

  return parsed
    .toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric"
    })
    .replace(/ /g, "-");
}

function formatInterviewTimeLabel(interviewTime) {
  const raw = String(interviewTime || "").trim();
  if (!raw) {
    return "";
  }

  const parsed = new Date(`2000-01-01T${raw}`);
  if (Number.isNaN(parsed.getTime())) {
    return raw;
  }

  return parsed.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true
  });
}

function buildOfferHoldCancellationHtml({
  recipientName,
  roundType,
  interviewDate,
  interviewTime
}) {
  const dateLabel = formatInterviewDateLabel(interviewDate);
  const timeLabel = formatInterviewTimeLabel(interviewTime);
  const slot =
    dateLabel && timeLabel ? `${dateLabel} at ${timeLabel}` : dateLabel || timeLabel;

  return `
    <p>Dear ${recipientName || "Participant"},</p>
    <p>
      The ${roundType || "interview"} session scheduled${slot ? ` for ${slot}` : ""}
      has been cancelled due to an update in the candidate's recruitment workflow.
    </p>
    <p>No further action is required on this session.</p>
    <p>Thank you,<br/>OPTALYNX Recruitment</p>
  `;
}

async function defaultDeliverOfferHoldCancellationEmail({
  recipientEmail,
  recipientName,
  roundType,
  interviewDate,
  interviewTime
}) {
  const { sendTransactionalEmail } = require("./graphEmailAdapter");
  await sendTransactionalEmail({
    to: recipientEmail,
    subject: `Interview cancelled — ${roundType || "session"}`,
    html: buildOfferHoldCancellationHtml({
      recipientName,
      roundType,
      interviewDate,
      interviewTime
    })
  });
}

/**
 * Post-schedule interview_scheduled notification for candidate email.
 */
async function notifyInterviewScheduled(
  pool,
  {
    interviewId,
    candidateEmail,
    candidateName,
    roundType,
    interviewDate,
    interviewTime,
    teamsLink,
    recruiterEmail,
    mapId,
    reqId
  },
  { deliverInterviewEmail } = {}
) {
  const normalizedInterviewId = String(interviewId || "").trim();
  const recipientEmail = String(candidateEmail || "").trim();
  const normalizedRecruiterEmail = String(recruiterEmail || "").trim();
  const normalizedCandidateName = String(candidateName || "").trim();

  if (
    typeof deliverInterviewEmail !== "function"
    || !normalizedInterviewId
    || !recipientEmail
    || !normalizedCandidateName
    || !normalizedRecruiterEmail
  ) {
    return { skipped: true, reason: "missing_required_fields" };
  }

  if (!(await shouldAttemptEmailDelivery(pool))) {
    return { skipped: true, reason: "email_channel_disabled" };
  }

  const result = await notificationService.send(pool, {
    event: INTERVIEW_NOTIFICATION_EVENTS.INTERVIEW_SCHEDULED,
    recipient: recipientEmail,
    channel: NOTIFICATION_CHANNELS.EMAIL,
    templateKey: INTERVIEW_NOTIFICATION_TEMPLATES.INTERVIEW_SCHEDULED,
    correlationId: buildInterviewScheduledCorrelationId(normalizedInterviewId),
    payload: {
      interview_id: normalizedInterviewId,
      map_id: mapId != null ? Number(mapId) : null,
      req_id: reqId != null ? Number(reqId) : null,
      round_type: roundType,
      interview_date: interviewDate,
      interview_time: interviewTime
    },
    deliver: async () => {
      await executeInterviewEmail(
        deliverInterviewEmail,
        recipientEmail,
        normalizedCandidateName,
        roundType,
        interviewDate,
        interviewTime,
        teamsLink,
        normalizedRecruiterEmail
      );
    }
  });

  if (result.error) {
    console.error(
      "[interviewNotificationService] interview_scheduled delivery failed:",
      result.error.message
    );
  }

  return result;
}

/**
 * Notify candidate and panel participants after offer-hold cancellation (post-commit).
 */
async function notifyInterviewCancelledOfferHold(
  pool,
  { interviewId, holdId, offerId },
  req,
  options = {}
) {
  const normalizedInterviewId = String(interviewId || "").trim();
  const normalizedHoldId = String(holdId || "").trim();

  if (!normalizedInterviewId || !normalizedHoldId) {
    return { skipped: true, reason: "missing_ids", deliveries: [] };
  }

  if (!(await shouldAttemptEmailDelivery(pool))) {
    return { skipped: true, reason: "email_channel_disabled", deliveries: [] };
  }

  const interviewResult = await pool.query(
    `SELECT interview_id, round_type, interview_date, interview_time, interview_status, candidate_id
     FROM im_interviews
     WHERE interview_id = $1`,
    [normalizedInterviewId]
  );

  const interviewRow = interviewResult.rows[0];
  if (!interviewRow || interviewRow.interview_status !== "Cancelled") {
    return { skipped: true, reason: "interview_not_cancelled", deliveries: [] };
  }

  const panelResult = await pool.query(
    `SELECT interviewer_name, interviewer_email
     FROM im_panel_assignments
     WHERE interview_id = $1`,
    [normalizedInterviewId]
  );

  let candidateName = "Candidate";
  let candidateEmail = null;

  if (interviewRow.candidate_id) {
    const candidateResult = await pool.query(
      `SELECT first_name, last_name, email_id
       FROM cand_mstr
       WHERE candidate_id = $1`,
      [interviewRow.candidate_id]
    );
    const candidate = candidateResult.rows[0];
    if (candidate) {
      candidateName = `${candidate.first_name || ""} ${candidate.last_name || ""}`.trim()
        || candidateName;
      candidateEmail = String(candidate.email_id || "").trim() || null;
    }
  }

  const recipients = [];
  const seen = new Set();

  const addRecipient = (email, name) => {
    const normalizedEmail = String(email || "").trim();
    if (!normalizedEmail) {
      return;
    }

    const key = normalizedEmail.toLowerCase();
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    recipients.push({
      email: normalizedEmail,
      name: String(name || "").trim() || normalizedEmail
    });
  };

  addRecipient(candidateEmail, candidateName);

  for (const panelRow of panelResult.rows || []) {
    addRecipient(panelRow.interviewer_email, panelRow.interviewer_name);
  }

  if (!recipients.length) {
    return { skipped: true, reason: "no_recipients", deliveries: [] };
  }

  const deliverFn =
    typeof options.deliverInterviewCancelledEmail === "function"
      ? options.deliverInterviewCancelledEmail
      : defaultDeliverOfferHoldCancellationEmail;

  const deliveries = [];

  for (const recipient of recipients) {
    const correlationId = buildOfferHoldCancelCorrelationId(
      normalizedHoldId,
      normalizedInterviewId,
      recipient.email
    );

    const result = await notificationService.send(pool, {
      event: INTERVIEW_NOTIFICATION_EVENTS.INTERVIEW_CANCELLED_OFFER_HOLD,
      recipient: recipient.email,
      channel: NOTIFICATION_CHANNELS.EMAIL,
      templateKey: INTERVIEW_NOTIFICATION_TEMPLATES.INTERVIEW_CANCELLED_OFFER_HOLD,
      correlationId,
      payload: {
        interview_id: normalizedInterviewId,
        hold_id: normalizedHoldId,
        offer_id: offerId ? String(offerId) : null,
        round_type: interviewRow.round_type,
        interview_date: interviewRow.interview_date,
        interview_time: interviewRow.interview_time
      },
      deliver: async () => {
        await executeInterviewCancelledEmail(deliverFn, {
          recipientEmail: recipient.email,
          recipientName: recipient.name,
          roundType: interviewRow.round_type,
          interviewDate: interviewRow.interview_date,
          interviewTime: interviewRow.interview_time
        });
      }
    });

    deliveries.push({
      recipient: recipient.email,
      correlationId,
      idempotentReplay: Boolean(result.idempotentReplay),
      status: result.delivery?.status || null,
      error: result.error ? result.error.message : null
    });
  }

  return {
    skipped: false,
    interview_id: normalizedInterviewId,
    hold_id: normalizedHoldId,
    deliveries
  };
}

module.exports = {
  INTERVIEW_NOTIFICATION_EVENTS,
  INTERVIEW_NOTIFICATION_TEMPLATES,
  buildInterviewScheduledCorrelationId,
  buildOfferHoldCancelCorrelationId,
  setInterviewEmailDeliverer,
  clearInterviewEmailDeliverer,
  setInterviewCancelledEmailDeliverer,
  clearInterviewCancelledEmailDeliverer,
  notifyInterviewScheduled,
  notifyInterviewCancelledOfferHold
};
