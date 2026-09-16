/**
 * Phase 6C-5 — interview schedule candidate email notifications.
 */

const notificationService = require("./notificationService");

const { NOTIFICATION_CHANNELS, config: notificationConfigResolver } =
  notificationService;

const INTERVIEW_NOTIFICATION_EVENTS = {
  INTERVIEW_SCHEDULED: "interview_scheduled"
};

const INTERVIEW_NOTIFICATION_TEMPLATES = {
  INTERVIEW_SCHEDULED: "INTERVIEW-SCHEDULED"
};

let interviewEmailDelivererOverride = null;

function setInterviewEmailDeliverer(deliverer) {
  interviewEmailDelivererOverride = deliverer;
}

function clearInterviewEmailDeliverer() {
  interviewEmailDelivererOverride = null;
}

function buildInterviewScheduledCorrelationId(interviewId) {
  return `interview-scheduled-${String(interviewId || "").trim()}`;
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

module.exports = {
  INTERVIEW_NOTIFICATION_EVENTS,
  INTERVIEW_NOTIFICATION_TEMPLATES,
  buildInterviewScheduledCorrelationId,
  setInterviewEmailDeliverer,
  clearInterviewEmailDeliverer,
  notifyInterviewScheduled
};
