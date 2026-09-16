/**
 * Phase 6C-4 — candidate portal transactional email notifications.
 */

const notificationService = require("./notificationService");
const graphEmailAdapter = require("./graphEmailAdapter");

const { NOTIFICATION_CHANNELS, config: notificationConfigResolver } =
  notificationService;

const PORTAL_NOTIFICATION_EVENTS = {
  APPLICATION_SUBMITTED: "application_submitted",
  STAGE_CHANGED: "stage_changed"
};

const PORTAL_NOTIFICATION_TEMPLATES = {
  APPLICATION_SUBMITTED: "PORTAL-APPLICATION-SUBMITTED",
  STAGE_CHANGED: "PORTAL-STAGE-CHANGED"
};

let graphEmailDelivererOverride = null;

function setGraphEmailDeliverer(deliverer) {
  graphEmailDelivererOverride = deliverer;
}

function clearGraphEmailDeliverer() {
  graphEmailDelivererOverride = null;
}

function buildApplicationSubmittedCorrelationId(mappingId) {
  return `portal-application-${mappingId}`;
}

function buildStageChangedCorrelationId(mappingId, stageCode) {
  return `portal-stage-${mappingId}-${stageCode}`;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function resolveCandidateDisplayName(candidateContext, fallbackEmail) {
  const fullName = String(candidateContext?.full_name || "").trim();

  if (fullName) {
    return fullName;
  }

  return fallbackEmail || "Candidate";
}

async function executeGraphEmail(message) {
  if (graphEmailDelivererOverride) {
    return graphEmailDelivererOverride(message);
  }

  return graphEmailAdapter.sendTransactionalEmail(message);
}

async function loadPortalCandidateRecipient(pool, candidateId) {
  const result = await pool.query(
    `SELECT
       cm.candidate_id,
       cm.email_id,
       cm.first_name,
       cm.last_name,
       cpa.portal_account_id
     FROM cand_mstr cm
     INNER JOIN candidate_portal_account cpa
       ON cpa.candidate_id = cm.candidate_id
      AND cpa.is_active = TRUE
     WHERE cm.candidate_id = $1
     LIMIT 1`,
    [candidateId]
  );

  const row = result.rows[0];

  if (!row?.email_id) {
    return null;
  }

  return {
    candidateId: row.candidate_id,
    emailId: String(row.email_id).trim(),
    fullName: [row.first_name, row.last_name].filter(Boolean).join(" ").trim()
  };
}

async function shouldAttemptEmailDelivery(pool) {
  const config = await notificationConfigResolver.loadNotificationConfig(pool);
  return notificationConfigResolver.isDeliverableChannel(
    config,
    NOTIFICATION_CHANNELS.EMAIL
  );
}

async function resolveSenderMailbox(pool) {
  const config = await notificationConfigResolver.loadNotificationConfig(pool);
  return (
    notificationConfigResolver.getDefaultSender(config)
    || process.env.EMAIL_USER
    || null
  );
}

function buildApplicationSubmittedEmail({ candidateName, application }) {
  const requisitionCode = escapeHtml(application.requisition_code);
  const title = escapeHtml(application.title || application.requisition_code);
  const stageName = escapeHtml(application.stage_name || "Applied");

  return {
    subject: `Application Received — ${application.requisition_code}`,
    html: `
      <p>Hello ${escapeHtml(candidateName)},</p>
      <p>
        Thank you for applying through the Optalynx Candidate Portal.
      </p>
      <p>
        Your application for <strong>${title}</strong>
        (${requisitionCode}) has been submitted successfully.
      </p>
      <p>
        Current status: <strong>${stageName}</strong>
      </p>
      <p>
        You can sign in to your portal to track application progress.
      </p>
      <br/>
      <p>Regards,<br/>Optalynx</p>
    `
  };
}

function buildStageChangedEmail({
  candidateName,
  requisitionCode,
  positionTitle,
  stageName
}) {
  const safeCode = escapeHtml(requisitionCode);
  const safeTitle = escapeHtml(positionTitle || requisitionCode);
  const safeStage = escapeHtml(stageName);

  return {
    subject: `Application Update — ${requisitionCode}`,
    html: `
      <p>Hello ${escapeHtml(candidateName)},</p>
      <p>
        Your application status has been updated for
        <strong>${safeTitle}</strong> (${safeCode}).
      </p>
      <p>
        Current status: <strong>${safeStage}</strong>
      </p>
      <p>
        Sign in to your Candidate Portal to view your applications.
      </p>
      <br/>
      <p>Regards,<br/>Optalynx</p>
    `
  };
}

/**
 * Post-commit application_submitted notification for portal apply.
 */
async function notifyApplicationSubmitted(
  pool,
  { candidateContext, application, mappingId }
) {
  const recipientEmail = String(candidateContext?.email_id || "").trim();
  const normalizedMappingId = Number(mappingId);

  if (!recipientEmail || !Number.isInteger(normalizedMappingId) || normalizedMappingId <= 0) {
    return { skipped: true, reason: "missing_recipient_or_mapping" };
  }

  if (!(await shouldAttemptEmailDelivery(pool))) {
    return { skipped: true, reason: "email_channel_disabled" };
  }

  const senderMailbox = await resolveSenderMailbox(pool);

  if (!senderMailbox) {
    return { skipped: true, reason: "missing_sender_mailbox" };
  }

  const candidateName = resolveCandidateDisplayName(
    candidateContext,
    recipientEmail
  );
  const emailContent = buildApplicationSubmittedEmail({
    candidateName,
    application
  });

  const result = await notificationService.send(pool, {
    event: PORTAL_NOTIFICATION_EVENTS.APPLICATION_SUBMITTED,
    recipient: recipientEmail,
    channel: NOTIFICATION_CHANNELS.EMAIL,
    templateKey: PORTAL_NOTIFICATION_TEMPLATES.APPLICATION_SUBMITTED,
    correlationId: buildApplicationSubmittedCorrelationId(normalizedMappingId),
    payload: {
      candidate_id: Number(candidateContext?.candidate_id) || null,
      mapping_id: normalizedMappingId,
      requisition_code: application.requisition_code,
      stage_name: application.stage_name || "Applied"
    },
    deliver: async () => {
      await executeGraphEmail({
        to: recipientEmail,
        subject: emailContent.subject,
        html: emailContent.html,
        senderMailbox
      });
    }
  });

  if (result.error) {
    console.error(
      "[candidatePortalNotificationService] application_submitted delivery failed:",
      result.error.message
    );
  }

  return result;
}

/**
 * Post-commit stage_changed notification for portal candidates.
 */
async function notifyStageChanged(
  pool,
  {
    mappingId,
    candidateId,
    requisitionCode,
    stageName,
    positionTitle,
    stageCode
  }
) {
  const normalizedMappingId = Number(mappingId);
  const normalizedCandidateId = Number(candidateId);

  if (
    !Number.isInteger(normalizedMappingId)
    || normalizedMappingId <= 0
    || !Number.isInteger(normalizedCandidateId)
    || normalizedCandidateId <= 0
  ) {
    return { skipped: true, reason: "missing_mapping_or_candidate" };
  }

  const recipient = await loadPortalCandidateRecipient(pool, normalizedCandidateId);

  if (!recipient?.emailId) {
    return { skipped: true, reason: "portal_candidate_not_found" };
  }

  let candidateFacingStage = null;

  if (stageCode) {
    const { buildCandidateFacingStageResolver } = require("./candidatePortalStageResolver");
    const resolveStage = await buildCandidateFacingStageResolver(pool);
    const resolved = resolveStage(stageName);
    const normalizedCode = String(stageCode).trim().toUpperCase();

    candidateFacingStage = {
      stage_name: resolved?.stage_name || String(stageName || "").trim(),
      stage_code: normalizedCode
    };
  } else {
    const { buildCandidateFacingStageResolver } = require("./candidatePortalStageResolver");
    const resolveStage = await buildCandidateFacingStageResolver(pool);
    candidateFacingStage = resolveStage(stageName);
  }

  if (!candidateFacingStage?.stage_name || !candidateFacingStage?.stage_code) {
    return { skipped: true, reason: "non_candidate_facing_stage" };
  }

  if (!(await shouldAttemptEmailDelivery(pool))) {
    return { skipped: true, reason: "email_channel_disabled" };
  }

  const senderMailbox = await resolveSenderMailbox(pool);

  if (!senderMailbox) {
    return { skipped: true, reason: "missing_sender_mailbox" };
  }

  const candidateName = resolveCandidateDisplayName(
    { full_name: recipient.fullName },
    recipient.emailId
  );
  const emailContent = buildStageChangedEmail({
    candidateName,
    requisitionCode,
    positionTitle,
    stageName: candidateFacingStage.stage_name
  });

  const result = await notificationService.send(pool, {
    event: PORTAL_NOTIFICATION_EVENTS.STAGE_CHANGED,
    recipient: recipient.emailId,
    channel: NOTIFICATION_CHANNELS.EMAIL,
    templateKey: PORTAL_NOTIFICATION_TEMPLATES.STAGE_CHANGED,
    correlationId: buildStageChangedCorrelationId(
      normalizedMappingId,
      candidateFacingStage.stage_code
    ),
    payload: {
      candidate_id: normalizedCandidateId,
      mapping_id: normalizedMappingId,
      requisition_code: requisitionCode,
      stage_code: candidateFacingStage.stage_code,
      stage_name: candidateFacingStage.stage_name
    },
    deliver: async () => {
      await executeGraphEmail({
        to: recipient.emailId,
        subject: emailContent.subject,
        html: emailContent.html,
        senderMailbox
      });
    }
  });

  if (result.error) {
    console.error(
      "[candidatePortalNotificationService] stage_changed delivery failed:",
      result.error.message
    );
  }

  return result;
}

module.exports = {
  PORTAL_NOTIFICATION_EVENTS,
  PORTAL_NOTIFICATION_TEMPLATES,
  buildApplicationSubmittedCorrelationId,
  buildStageChangedCorrelationId,
  setGraphEmailDeliverer,
  clearGraphEmailDeliverer,
  notifyApplicationSubmitted,
  notifyStageChanged
};
