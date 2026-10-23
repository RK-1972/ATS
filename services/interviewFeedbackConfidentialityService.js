const { userContext } = require("./enterpriseAuditService");
const { hasOfferWorkspaceAccess } = require("./offerCapabilityAuth");
const {
  resolveInterviewStageBucket,
  mapInterviewRowsToFeedbackSummaries,
  resolveCurrentStageDecision
} = require("./interviewRepeatStageService");

function httpError(message, status = 403) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function isAdminUser(req) {
  return String(req?.user?.role_name || "").trim() === "Admin";
}

function isTaLeaderUser(req) {
  return String(req?.user?.role_name || "").trim() === "TA Leader";
}

function isRecruiterUser(req) {
  return String(req?.user?.role_name || "").trim() === "Recruiter";
}

function isInterviewerUser(req) {
  const primary = String(req?.user?.role_name || "").trim();
  const secondary = String(req?.user?.secondary_role || "").trim();
  return primary === "Interviewer" || secondary === "Interviewer";
}

function isHrInterviewRound(roundType) {
  return resolveInterviewStageBucket(roundType) === "HR";
}

/**
 * Strip HR outcome metadata from im_interviews rows for callers who cannot read HR feedback.
 * Preserves schedule fields (dates, status, round type) for L1/L2 and non-HR rows.
 */
function redactHrInterviewEnterpriseRow(row, canReadHr) {
  if (!row || canReadHr || !isHrInterviewRound(row.round_type)) {
    return row;
  }

  return {
    ...row,
    feedback_submitted: false,
    final_outcome: null,
    remarks: null
  };
}

/**
 * Redact HR outcome fields on mapped interview bundle DTO rows (camelCase and legacy snake_case).
 */
function redactHrInterviewBundleDto(interview, canReadHr) {
  if (!interview || canReadHr) {
    return interview;
  }

  const roundType = interview.roundType || interview.round_type;

  if (!isHrInterviewRound(roundType)) {
    return interview;
  }

  return {
    ...interview,
    feedbackSubmitted: null,
    feedback_submitted: null,
    finalOutcome: null,
    final_outcome: null,
    remarks: null
  };
}

function isPendingFeedbackBundleRow(row, canReadHr) {
  if (row.interviewStatus === "Cancelled") {
    return false;
  }

  const roundType = row.roundType || row.round_type;

  if (!canReadHr && isHrInterviewRound(roundType)) {
    return false;
  }

  return row.feedbackSubmitted === false || row.feedback_submitted === false;
}

function buildInterviewBundleSummaryFromDto(interviews, canReadHr) {
  const rows = interviews || [];

  return {
    scheduled: rows.filter((row) => row.interviewStatus === "Scheduled").length,
    completed: rows.filter((row) => row.interviewStatus === "Completed").length,
    pendingFeedback: rows.filter((row) => isPendingFeedbackBundleRow(row, canReadHr))
      .length
  };
}

async function sanitizeInterviewBundleForCaller(pool, req, bundle) {
  if (!bundle || typeof bundle !== "object") {
    return bundle;
  }

  const canReadHr = await canReadHrInterviewFeedback(pool, req);
  const interviews = (bundle.interviews || []).map((row) =>
    redactHrInterviewBundleDto(row, canReadHr)
  );

  return {
    ...bundle,
    interviews,
    summary: buildInterviewBundleSummaryFromDto(interviews, canReadHr)
  };
}

/**
 * HR interview feedback read: Admin, TA Leader role, or Offer Letter workspace
 * privilege (`hasOfferWorkspaceAccess` — same source as `POST /api/v1/offer-letters/:id/generate`).
 * TA Lead is intentionally excluded (distinct from TA Leader).
 */
async function canReadHrInterviewFeedback(pool, req) {
  if (isAdminUser(req)) {
    return true;
  }

  if (isTaLeaderUser(req)) {
    return true;
  }

  return hasOfferWorkspaceAccess(pool, req);
}

function denyHrFeedbackAccess() {
  throw httpError(
    "Enterprise Access Denied. You are not authorized to access feedback for this interview.",
    403
  );
}

async function resolveInterviewRoundType(pool, { scheduleId, interviewId } = {}) {
  const lookupKey = scheduleId ?? interviewId;

  if (lookupKey == null || lookupKey === "") {
    return null;
  }

  const result = await pool.query(
    `SELECT round_type
     FROM im_interviews
     WHERE schedule_id::text = $1::text OR interview_id = $1
     LIMIT 1`,
    [lookupKey]
  );

  if (result.rows.length) {
    return result.rows[0].round_type;
  }

  const legacy = await pool.query(
    `SELECT round_type
     FROM interview_schedule_trn
     WHERE schedule_id::text = $1::text
     LIMIT 1`,
    [lookupKey]
  );

  return legacy.rows[0]?.round_type || null;
}

async function assertInterviewFeedbackConfidentiality(pool, req, context = {}) {
  if (await canReadHrInterviewFeedback(pool, req)) {
    return;
  }

  const roundType = context.roundType
    || await resolveInterviewRoundType(pool, context);

  if (isHrInterviewRound(roundType)) {
    denyHrFeedbackAccess();
  }
}

function isSessionScheduledByCaller(req, interviewRow = {}) {
  const user = userContext(req);
  const createdBy = String(interviewRow.created_by || "").trim();
  const legacyCreatedBy = String(interviewRow.schedule_created_by || "").trim();

  if (user.employeeCode) {
    if (createdBy === user.employeeCode || legacyCreatedBy === user.employeeCode) {
      return true;
    }
  }

  if (user.name && createdBy) {
    if (createdBy.toLowerCase() === user.name.toLowerCase()) {
      return true;
    }
  }

  return false;
}

async function stripHrFromFeedbackSummaries(summaries, req, pool) {
  if (await canReadHrInterviewFeedback(pool, req)) {
    return summaries;
  }

  return (summaries || []).filter(
    (row) => !isHrInterviewRound(row.roundType)
  );
}

async function filterFeedbackSummariesForRecruiterScheduler(
  summaries,
  req,
  interviewRows,
  pool
) {
  const rowByInterviewId = new Map(
    (interviewRows || []).map((row) => [String(row.interview_id), row])
  );

  const visible = await stripHrFromFeedbackSummaries(summaries, req, pool);

  return visible.filter((summary) => {
    const source = rowByInterviewId.get(String(summary.interviewId)) || {};
    return isSessionScheduledByCaller(req, source);
  });
}

async function filterFeedbackSummariesForInterviewer(summaries, req, pool) {
  return stripHrFromFeedbackSummaries(summaries, req, pool);
}

async function filterStageGroupsForCaller(
  stageGroups,
  req,
  interviewRows,
  options = {}
) {
  const pool = options.pool;

  if (!pool) {
    throw new Error("pool is required for filterStageGroupsForCaller.");
  }

  if (await canReadHrInterviewFeedback(pool, req)) {
    return stageGroups;
  }

  const recruiterSchedulerOnly = options.recruiterSchedulerOnly === true;
  const rowByInterviewId = new Map(
    (interviewRows || []).map((row) => [String(row.interview_id), row])
  );

  return (stageGroups || [])
    .filter((group) => group.stageKey !== "HR")
    .map((group) => {
      let sessions = (group.sessions || []).filter(
        (session) => !isHrInterviewRound(session.roundType)
      );

      if (recruiterSchedulerOnly && isRecruiterUser(req)) {
        sessions = sessions.filter((session) => {
          const source = rowByInterviewId.get(String(session.interviewId)) || {};
          return isSessionScheduledByCaller(req, source);
        });
      }

      const rawForDecision = sessions.map((session) => ({
        interview_id: session.interviewId,
        round_type: session.roundType,
        final_outcome: session.sessionOutcome,
        feedback_submitted: session.feedbackSubmitted,
        interview_status: session.interviewStatus,
        modified_on: session.modifiedOn || session.decidedOn,
        interview_date: session.interviewDate,
        interview_time: session.interviewTime
      }));

      const decision = resolveCurrentStageDecision(rawForDecision, group.stageKey);
      const currentDecision = decision
        ? {
            outcome: decision.outcome,
            interviewId: decision.interviewId,
            scheduleId: decision.scheduleId,
            decidedOn: decision.decidedOn,
            sessionLabel:
              sessions.find((item) => item.interviewId === decision.interviewId)
                ?.sessionLabel || null
          }
        : null;

      return {
        ...group,
        sessions,
        currentDecision
      };
    })
    .filter((group) => group.sessions.length > 0 || group.currentDecision);
}

async function filterProgressRoundsForCaller(
  rounds,
  req,
  interviewRows,
  options = {}
) {
  const pool = options.pool;

  if (!pool) {
    throw new Error("pool is required for filterProgressRoundsForCaller.");
  }

  if (await canReadHrInterviewFeedback(pool, req)) {
    return rounds;
  }

  const recruiterSchedulerOnly = options.recruiterSchedulerOnly === true;
  const rowByInterviewId = new Map(
    (interviewRows || []).map((row) => [String(row.interview_id), row])
  );

  return (rounds || []).filter((round) => {
    if (isHrInterviewRound(round.roundType)) {
      return false;
    }

    if (recruiterSchedulerOnly && isRecruiterUser(req)) {
      const source = rowByInterviewId.get(String(round.interviewId)) || {};
      return isSessionScheduledByCaller(req, source);
    }

    return true;
  });
}

async function listInterviewRowsWithSchedulerForMap(pool, mapId) {
  const result = await pool.query(
    `
    SELECT
      i.interview_id,
      i.schedule_id,
      i.round_no,
      i.round_type,
      i.interview_date,
      i.interview_time,
      i.interview_status,
      i.feedback_submitted,
      i.final_outcome,
      i.created_by,
      i.created_on,
      i.modified_on,
      ist.created_by AS schedule_created_by,
      f.feedback_id,
      f.final_outcome AS feedback_outcome,
      f.submitted_on
    FROM im_interviews i
    LEFT JOIN interview_schedule_trn ist ON ist.schedule_id = i.schedule_id
    LEFT JOIN LATERAL (
      SELECT feedback_id, final_outcome, submitted_on
      FROM im_feedback
      WHERE interview_id = i.interview_id
      ORDER BY feedback_id DESC
      LIMIT 1
    ) f ON TRUE
    WHERE i.map_id = $1
    ORDER BY i.created_on ASC NULLS LAST, i.interview_id ASC
    `,
    [mapId]
  );

  return result.rows;
}

async function buildFeedbackSummariesFromRows(rows, req, options = {}) {
  const pool = options.pool;

  if (!pool) {
    throw new Error("pool is required for buildFeedbackSummariesFromRows.");
  }

  const summaries = mapInterviewRowsToFeedbackSummaries(rows);

  if (await canReadHrInterviewFeedback(pool, req)) {
    return summaries;
  }

  if (options.recruiterSchedulerOnly) {
    return filterFeedbackSummariesForRecruiterScheduler(
      summaries,
      req,
      rows,
      pool
    );
  }

  return filterFeedbackSummariesForInterviewer(summaries, req, pool);
}

module.exports = {
  isHrInterviewRound,
  redactHrInterviewEnterpriseRow,
  redactHrInterviewBundleDto,
  sanitizeInterviewBundleForCaller,
  buildInterviewBundleSummaryFromDto,
  isPendingFeedbackBundleRow,
  isTaLeaderUser,
  canReadHrInterviewFeedback,
  assertInterviewFeedbackConfidentiality,
  resolveInterviewRoundType,
  isSessionScheduledByCaller,
  stripHrFromFeedbackSummaries,
  filterFeedbackSummariesForRecruiterScheduler,
  filterFeedbackSummariesForInterviewer,
  filterStageGroupsForCaller,
  filterProgressRoundsForCaller,
  listInterviewRowsWithSchedulerForMap,
  buildFeedbackSummariesFromRows,
  isRecruiterUser,
  isInterviewerUser
};
