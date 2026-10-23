const {
  inferCatalogStageCodeFromOperationalStage
} = require("./candidatePortalStageResolver");
const { assertCanAssignRecruiters, isTaLeadUser } = require("./requisitionCapabilityAuth");

const STAGE_BUCKET_ORDER = {
  L1: 1,
  L2: 2,
  HR: 3,
  OTHER: 0
};

const CATALOG_STAGE_RANK = {
  APPLIED: 1,
  SCREENING: 2,
  L1_INTERVIEW: 3,
  L2_INTERVIEW: 4,
  CLIENT_INTERVIEW: 5,
  OFFER: 6,
  JOINED: 7
};

const REPEAT_GUARD_CODES = {
  ALLOW: "ALLOW",
  CONFIRM_SELECTED: "CONFIRM_SELECTED",
  OVERRIDE_REJECTED: "OVERRIDE_REJECTED",
  ACTIVE_SCHEDULED: "ACTIVE_SCHEDULED",
  PENDING_FEEDBACK: "PENDING_FEEDBACK"
};

function httpError(message, status = 400, extra = {}) {
  const error = new Error(message);
  error.status = status;
  Object.assign(error, extra);
  return error;
}

function isAdminUser(req) {
  return String(req?.user?.role_name || "").trim() === "Admin";
}

/**
 * Groups L1 / L2 / HR interview rounds for repeat-session rules.
 */
function resolveInterviewStageBucket(roundType) {
  const value = String(roundType || "").trim().toLowerCase();

  if (!value) {
    return "OTHER";
  }

  if (value.startsWith("l1") || value.includes("l1 ")) {
    return "L1";
  }

  if (value.includes("hr round") || value === "hr" || value.startsWith("hr ")) {
    return "HR";
  }

  if (
    value.startsWith("l2")
    || value.includes("l2 ")
    || value.includes("managerial")
    || value.includes("client round")
  ) {
    return "L2";
  }

  return "OTHER";
}

function bucketRank(bucket) {
  return STAGE_BUCKET_ORDER[bucket] || 0;
}

function catalogStageRank(stageName) {
  const code = inferCatalogStageCodeFromOperationalStage(stageName);
  return CATALOG_STAGE_RANK[code] || 0;
}

function normalizeOutcome(value) {
  const text = String(value || "").trim();
  if (!text) {
    return null;
  }

  if (/^selected$/i.test(text)) {
    return "Selected";
  }

  if (/^rejected$/i.test(text)) {
    return "Rejected";
  }

  if (/^hold$/i.test(text)) {
    return "Hold";
  }

  return text;
}

function isTerminalCancelled(interview) {
  return String(interview?.interview_status || interview?.interviewStatus || "")
    .trim()
    === "Cancelled";
}

function isActiveScheduled(interview) {
  const status = String(interview?.interview_status || interview?.interviewStatus || "")
    .trim();

  return status === "Scheduled" && !interview?.feedback_submitted && !interview?.feedbackSubmitted;
}

function isCompletedWithFeedback(interview) {
  const feedbackSubmitted = Boolean(
    interview?.feedback_submitted || interview?.feedbackSubmitted
  );
  const status = String(interview?.interview_status || interview?.interviewStatus || "")
    .trim();

  return feedbackSubmitted && (status === "Completed" || status === "Scheduled");
}

function parseTimestamp(value) {
  if (value == null || value === "") {
    return null;
  }

  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.getTime();
}

/**
 * When feedback exists, completion time (modified_on) defines "latest" decision.
 */
function decisionSortKey(interview) {
  const feedbackSubmitted = Boolean(
    interview?.feedback_submitted || interview?.feedbackSubmitted
  );

  if (feedbackSubmitted) {
    const completedAt = parseTimestamp(interview?.modified_on || interview?.modifiedOn);

    if (completedAt != null) {
      return completedAt;
    }
  }

  const date = interview?.interview_date || interview?.interviewDate;
  const time = interview?.interview_time || interview?.interviewTime || "00:00:00";

  if (date) {
    const combined = new Date(`${date}T${time}`);

    if (!Number.isNaN(combined.getTime())) {
      return combined.getTime();
    }
  }

  return parseTimestamp(interview?.created_on || interview?.createdOn)
    ?? Number(interview?.round_no || interview?.roundNo || 0);
}

/**
 * Stable session numbering follows schedule creation order, then interview slot.
 */
function sessionScheduleSortKey(interview) {
  const created = parseTimestamp(interview?.created_on || interview?.createdOn);

  if (created != null) {
    return created;
  }

  const date = interview?.interview_date || interview?.interviewDate;
  const time = interview?.interview_time || interview?.interviewTime || "00:00:00";

  if (date) {
    const combined = new Date(`${date}T${time}`);

    if (!Number.isNaN(combined.getTime())) {
      return combined.getTime();
    }
  }

  return Number(interview?.round_no || interview?.roundNo || 0);
}

function buildSessionLabel(bucket, sessionNumber) {
  if (!bucket || bucket === "OTHER") {
    return sessionNumber > 1 ? `Session ${sessionNumber}` : "Session 1";
  }

  return `${bucket} Session ${sessionNumber}`;
}

/**
 * Latest completed session with feedback wins for the stage bucket.
 */
function resolveCurrentStageDecision(sessions, bucket) {
  const inBucket = sessions
    .filter((row) => resolveInterviewStageBucket(row.round_type || row.roundType) === bucket)
    .filter((row) => isCompletedWithFeedback(row))
    .sort((left, right) => decisionSortKey(right) - decisionSortKey(left));

  if (!inBucket.length) {
    return null;
  }

  const latest = inBucket[0];
  const outcome = normalizeOutcome(latest.final_outcome || latest.finalOutcome);

  return {
    interviewId: latest.interview_id || latest.interviewId || null,
    scheduleId: latest.schedule_id || latest.scheduleId || null,
    outcome,
    roundType: latest.round_type || latest.roundType || null,
    decidedOn: latest.modified_on || latest.modifiedOn || null,
    interviewDate: latest.interview_date || latest.interviewDate || null,
    interviewTime: latest.interview_time || latest.interviewTime || null
  };
}

function assignSessionNumbers(sessions) {
  const buckets = new Map();

  const sorted = [...sessions].sort(
    (left, right) => sessionScheduleSortKey(left) - sessionScheduleSortKey(right)
  );

  return sorted.map((row) => {
    const bucket = resolveInterviewStageBucket(row.round_type || row.roundType);
    const next = (buckets.get(bucket) || 0) + 1;
    buckets.set(bucket, next);

    return {
      ...row,
      stageBucket: bucket,
      sessionNumber: next,
      sessionLabel: buildSessionLabel(bucket, next)
    };
  });
}

function resolveMappingProgressBucket(stageName) {
  const value = String(stageName || "").trim().toLowerCase();

  if (!value) {
    return "OTHER";
  }

  if (value.includes("offer") || value.includes("join")) {
    return "OFFER";
  }

  if (value.includes("client")) {
    return "CLIENT";
  }

  if (value.includes("hr")) {
    return "HR";
  }

  if (value.includes("l2")) {
    return "L2";
  }

  if (value.includes("l1") || value.includes("screening")) {
    return "L1";
  }

  if (value.includes("interview")) {
    return "L1";
  }

  return "OTHER";
}

const MAPPING_PROGRESS_RANK = {
  OTHER: 0,
  L1: 1,
  L2: 2,
  HR: 3,
  CLIENT: 4,
  OFFER: 5
};

/**
 * Do not move pipeline stage backward when feedback is for an earlier interview bucket.
 */
function shouldApplyPipelineStageFromInterviewFeedback(
  mappingStageName,
  interviewRoundType
) {
  const interviewBucket = resolveInterviewStageBucket(interviewRoundType);
  const mappingBucket = resolveMappingProgressBucket(mappingStageName);
  const interviewRank = bucketRank(interviewBucket);
  const mappingRank = MAPPING_PROGRESS_RANK[mappingBucket] ?? 0;

  if (!interviewRank) {
    return true;
  }

  if (mappingRank > interviewRank) {
    return false;
  }

  return true;
}

/**
 * Pipeline stage transitions apply only for the session that owns the current stage decision.
 */
function isInterviewCurrentStageDecision(interview, allSessions) {
  const bucket = resolveInterviewStageBucket(interview.round_type || interview.roundType);
  const decision = resolveCurrentStageDecision(allSessions, bucket);
  const interviewId = interview.interview_id || interview.interviewId;

  if (!decision?.interviewId || !interviewId) {
    return true;
  }

  return String(decision.interviewId) === String(interviewId);
}

async function listInterviewsForMap(pool, mapId) {
  const result = await pool.query(
    `SELECT
        i.interview_id,
        i.schedule_id,
        i.map_id,
        i.round_no,
        i.round_type,
        i.interview_date,
        i.interview_time,
        i.interview_status,
        i.feedback_submitted,
        i.final_outcome,
        i.remarks,
        i.created_on,
        i.modified_on
     FROM im_interviews i
     WHERE i.map_id = $1
     ORDER BY i.created_on ASC NULLS LAST, i.interview_id ASC`,
    [mapId]
  );

  return result.rows;
}

async function allocateSessionRoundNo(pool, mapId, roundType) {
  const bucket = resolveInterviewStageBucket(roundType);
  const rows = await listInterviewsForMap(pool, mapId);
  const sameBucket = rows.filter(
    (row) => resolveInterviewStageBucket(row.round_type) === bucket
  );

  const maxRound = sameBucket.reduce(
    (max, row) => Math.max(max, Number(row.round_no) || 0),
    0
  );

  return maxRound + 1;
}

function evaluateRepeatScheduleGuardState(sessions, roundType) {
  const bucket = resolveInterviewStageBucket(roundType);
  const inBucket = sessions.filter(
    (row) => resolveInterviewStageBucket(row.round_type || row.roundType) === bucket
  );

  const activeScheduled = inBucket.filter((row) => isActiveScheduled(row));

  if (activeScheduled.length) {
    return {
      code: REPEAT_GUARD_CODES.ACTIVE_SCHEDULED,
      bucket,
      message:
        "An interview is already scheduled at this stage. Cancel or complete it before scheduling another session.",
      activeScheduledInterviewId: activeScheduled[0].interview_id || activeScheduled[0].interviewId,
      previousSessionCount: inBucket.filter((row) => !isTerminalCancelled(row)).length,
      currentDecision: resolveCurrentStageDecision(sessions, bucket)
    };
  }

  const pendingFeedback = inBucket.filter((row) => {
    if (isTerminalCancelled(row)) {
      return false;
    }

    const status = String(row.interview_status || row.interviewStatus || "").trim();
    const feedbackSubmitted = Boolean(row.feedback_submitted || row.feedbackSubmitted);

    return (status === "Completed" || status === "Scheduled") && !feedbackSubmitted;
  });

  if (pendingFeedback.length) {
    return {
      code: REPEAT_GUARD_CODES.PENDING_FEEDBACK,
      bucket,
      message:
        "A prior session at this stage is awaiting feedback. Complete or cancel it before scheduling another session.",
      pendingInterviewId: pendingFeedback[0].interview_id || pendingFeedback[0].interviewId,
      previousSessionCount: inBucket.filter((row) => !isTerminalCancelled(row)).length,
      currentDecision: resolveCurrentStageDecision(sessions, bucket)
    };
  }

  const completedSessions = inBucket.filter(
    (row) => isCompletedWithFeedback(row) && !isTerminalCancelled(row)
  );

  if (!completedSessions.length) {
    return {
      code: REPEAT_GUARD_CODES.ALLOW,
      bucket,
      message: null,
      previousSessionCount: inBucket.filter((row) => !isTerminalCancelled(row)).length,
      currentDecision: resolveCurrentStageDecision(sessions, bucket)
    };
  }

  const decision = resolveCurrentStageDecision(sessions, bucket);

  if (decision?.outcome === "Rejected") {
    return {
      code: REPEAT_GUARD_CODES.OVERRIDE_REJECTED,
      bucket,
      message:
        "The current decision for this stage is Rejected. An authorized override is required to schedule another session.",
      previousSessionCount: completedSessions.length,
      currentDecision: decision
    };
  }

  if (decision?.outcome === "Selected") {
    return {
      code: REPEAT_GUARD_CODES.CONFIRM_SELECTED,
      bucket,
      message:
        "A previous session at this stage was completed with Selected. Confirm and provide a reason to schedule another session.",
      previousSessionCount: completedSessions.length,
      currentDecision: decision
    };
  }

  return {
    code: REPEAT_GUARD_CODES.CONFIRM_SELECTED,
    bucket,
    message:
      "A previous session exists at this stage. Confirm and provide a reason to schedule another session.",
    previousSessionCount: completedSessions.length,
    currentDecision: decision
  };
}

function parseRepeatSchedulePayload(payload = {}) {
  return {
    repeatConfirmation: Boolean(
      payload.repeat_confirmation ?? payload.repeatConfirmation
    ),
    repeatReason: String(payload.repeat_reason ?? payload.repeatReason ?? "").trim(),
    repeatOverrideAcknowledged: Boolean(
      payload.repeat_override_acknowledged ?? payload.repeatOverrideAcknowledged
    )
  };
}

async function assertRepeatScheduleAuthorized(pool, req, mapId, roundType, payload) {
  const sessions = await listInterviewsForMap(pool, mapId);
  const guard = evaluateRepeatScheduleGuardState(sessions, roundType);
  const repeat = parseRepeatSchedulePayload(payload);

  if (guard.code === REPEAT_GUARD_CODES.ALLOW) {
    return { guard, repeatMetadata: null };
  }

  if (guard.code === REPEAT_GUARD_CODES.ACTIVE_SCHEDULED) {
    throw httpError(guard.message, 409, {
      guardCode: guard.code,
      guard
    });
  }

  if (guard.code === REPEAT_GUARD_CODES.PENDING_FEEDBACK) {
    throw httpError(guard.message, 409, {
      guardCode: guard.code,
      guard
    });
  }

  if (!repeat.repeatConfirmation) {
    throw httpError(
      "Repeat interview confirmation is required for this stage.",
      409,
      {
        guardCode: guard.code,
        guard,
        requiresRepeatConfirmation: true
      }
    );
  }

  if (!repeat.repeatReason) {
    throw httpError(
      "A reason is required to schedule another interview at this stage.",
      400,
      {
        guardCode: guard.code,
        guard,
        requiresRepeatReason: true
      }
    );
  }

  if (guard.code === REPEAT_GUARD_CODES.OVERRIDE_REJECTED) {
    if (!repeat.repeatOverrideAcknowledged) {
      throw httpError(
        "Authorized override acknowledgement is required after a Rejected stage decision.",
        409,
        {
          guardCode: guard.code,
          guard,
          requiresRepeatOverride: true
        }
      );
    }

    try {
      await assertCanAssignRecruiters(pool, req);
    } catch (error) {
      throw httpError(
        error.message
          || "Enterprise Access Denied. You are not authorized to override a Rejected stage decision.",
        error.status || 403,
        {
          guardCode: guard.code,
          guard,
          unauthorizedOverride: true
        }
      );
    }
  }

  return {
    guard,
    repeatMetadata: {
      repeatReason: repeat.repeatReason,
      guardCode: guard.code,
      stageBucket: guard.bucket,
      previousSessionCount: guard.previousSessionCount,
      previousDecision: guard.currentDecision,
      overrideAcknowledged: guard.code === REPEAT_GUARD_CODES.OVERRIDE_REJECTED,
      overrideAuthorizedByRole: isAdminUser(req)
        ? "Admin"
        : isTaLeadUser(req)
          ? "TA Lead"
          : "Operator"
    }
  };
}

async function buildInterviewProgressStageGroups(pool, mapId, interviewRows) {
  const numbered = assignSessionNumbers(
    interviewRows.map((row) => ({
      interview_id: row.interviewId || row.interview_id,
      schedule_id: row.scheduleId || row.schedule_id,
      round_type: row.roundType || row.round_type,
      round_no: row.roundNo || row.round_no,
      interview_date: row.interviewDate || row.interview_date,
      interview_time: row.interviewTime || row.interview_time,
      interview_status: row.interviewStatus || row.interview_status,
      feedback_submitted: row.feedbackSubmitted ?? row.feedback_submitted,
      final_outcome: row.finalOutcome || row.final_outcome,
      modified_on: row.actionOn || row.modified_on || null,
      created_on: row.createdOn || row.created_on || null,
      interviewer_name: row.interviewerName || row.interviewer_name,
      assignment_status: row.assignmentStatus || row.assignment_status
    }))
  );

  const repeatHistory = await pool.query(
    `SELECT interview_id, comments, metadata, created_on
     FROM im_interview_history
     WHERE event_type = 'InterviewScheduled'
       AND interview_id IN (
         SELECT interview_id FROM im_interviews WHERE map_id = $1
       )
     ORDER BY created_on ASC`,
    [mapId]
  ).catch(() => ({ rows: [] }));

  const repeatReasonByInterview = new Map();

  for (const row of repeatHistory.rows) {
    const metadata = row.metadata || {};
    if (metadata.repeatReason) {
      repeatReasonByInterview.set(row.interview_id, metadata.repeatReason);
    }
  }

  const bucketOrder = ["L1", "L2", "HR", "OTHER"];
  const groups = new Map();

  for (const session of numbered) {
    const bucket = session.stageBucket || "OTHER";

    if (!groups.has(bucket)) {
      groups.set(bucket, []);
    }

    groups.get(bucket).push({
      interviewId: session.interview_id,
      scheduleId: session.schedule_id,
      sessionNumber: session.sessionNumber,
      sessionLabel: session.sessionLabel,
      roundType: session.round_type,
      interviewDate: session.interview_date,
      interviewTime: session.interview_time,
      interviewStatus: session.interview_status,
      feedbackSubmitted: Boolean(session.feedback_submitted),
      sessionOutcome: normalizeOutcome(session.final_outcome),
      interviewerName: session.interviewer_name || null,
      assignmentStatus: session.assignment_status || null,
      modifiedOn: session.modified_on || null,
      createdOn: session.created_on || null,
      decidedOn: session.modified_on || null,
      repeatReason: repeatReasonByInterview.get(session.interview_id) || null,
      viewFeedbackPath: session.schedule_id
        ? `/view-feedback/${session.schedule_id}`
        : null
    });
  }

  return bucketOrder
    .filter((bucket) => groups.has(bucket))
    .map((bucket) => {
      const sessions = groups.get(bucket);
      const rawForDecision = sessions.map((item) => ({
        round_type: item.roundType,
        final_outcome: item.sessionOutcome,
        feedback_submitted: item.feedbackSubmitted,
        interview_status: item.interviewStatus,
        modified_on: item.decidedOn || item.modifiedOn,
        interview_date: item.interviewDate,
        interview_time: item.interviewTime,
        created_on: item.createdOn,
        interview_id: item.interviewId
      }));

      const currentDecision = resolveCurrentStageDecision(rawForDecision, bucket);

      return {
        stageKey: bucket,
        stageLabel: bucket === "OTHER" ? "Other" : bucket,
        currentDecision: currentDecision
          ? {
              outcome: currentDecision.outcome,
              interviewId: currentDecision.interviewId,
              scheduleId: currentDecision.scheduleId,
              decidedOn: currentDecision.decidedOn,
              sessionLabel: sessions.find(
                (item) => item.interviewId === currentDecision.interviewId
              )?.sessionLabel || null
            }
          : null,
        sessions
      };
    });
}

function mapInterviewRowsToFeedbackSummaries(interviewRows) {
  const numbered = assignSessionNumbers(
    (interviewRows || []).map((row) => ({
      interview_id: row.interview_id,
      schedule_id: row.schedule_id,
      round_type: row.round_type,
      round_no: row.round_no,
      interview_date: row.interview_date,
      interview_time: row.interview_time,
      interview_status: row.interview_status,
      feedback_submitted: row.feedback_submitted,
      final_outcome: row.feedback_outcome || row.final_outcome,
      created_on: row.created_on,
      modified_on: row.modified_on,
      feedback_id: row.feedback_id,
      submitted_on: row.submitted_on
    }))
  );

  return numbered.map((row) => {
    const scheduleId = row.schedule_id;

    return {
      interviewId: row.interview_id,
      scheduleId: scheduleId || null,
      feedbackId: row.feedback_id || null,
      sessionLabel: row.sessionLabel,
      stageBucket: row.stageBucket,
      roundType: row.round_type,
      feedbackSubmitted: Boolean(row.feedback_submitted),
      hasFeedbackRecord: Boolean(row.feedback_id),
      sessionOutcome: normalizeOutcome(row.final_outcome),
      submittedOn: row.submitted_on || null,
      viewFeedbackPath: scheduleId ? `/view-feedback/${scheduleId}` : null
    };
  });
}

async function getRepeatSchedulePrecheck(pool, mapId, roundType, req) {
  const recruitmentService = require("./recruitmentService");
  await recruitmentService.assertAuthorizedMappingAccess(pool, req, mapId);

  const sessions = await listInterviewsForMap(pool, mapId);
  const guard = evaluateRepeatScheduleGuardState(sessions, roundType);

  return {
    mapId,
    roundType,
    stageBucket: guard.bucket,
    guardCode: guard.code,
    message: guard.message,
    previousSessionCount: guard.previousSessionCount,
    currentDecision: guard.currentDecision,
    requiresRepeatConfirmation: guard.code !== REPEAT_GUARD_CODES.ALLOW,
    requiresRepeatReason: guard.code !== REPEAT_GUARD_CODES.ALLOW,
    requiresRepeatOverride: guard.code === REPEAT_GUARD_CODES.OVERRIDE_REJECTED
  };
}

module.exports = {
  REPEAT_GUARD_CODES,
  resolveInterviewStageBucket,
  resolveCurrentStageDecision,
  assignSessionNumbers,
  buildSessionLabel,
  shouldApplyPipelineStageFromInterviewFeedback,
  isInterviewCurrentStageDecision,
  resolveMappingProgressBucket,
  decisionSortKey,
  sessionScheduleSortKey,
  listInterviewsForMap,
  allocateSessionRoundNo,
  evaluateRepeatScheduleGuardState,
  assertRepeatScheduleAuthorized,
  getRepeatSchedulePrecheck,
  buildInterviewProgressStageGroups,
  mapInterviewRowsToFeedbackSummaries,
  parseRepeatSchedulePayload,
  catalogStageRank,
  bucketRank
};
