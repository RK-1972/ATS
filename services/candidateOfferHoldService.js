/**
 * Central Candidate Offer Hold policy (BR-01–BR-05).
 * Activated on offer release (Released); explicit recruiter release only.
 */

const { writeEnterpriseAudit, userContext } = require("./enterpriseAuditService");
const {
  parseInterviewDateValue,
  parseInterviewTime,
  zonedLocalDateTimeToInstant
} = require("../utils/optalynxBusinessTimezone");

const HOLD_STATUS = Object.freeze({
  ACTIVE: "Active",
  RELEASED: "Released"
});

const OFFER_HOLD_BLOCK_MESSAGE =
  "Candidate is on Offer Hold. An authorized assigned recruiter must release the hold before mapping, stage progression on other requisitions, or interview scheduling.";

const CANCELLATION_REASON_OFFER_HOLD =
  "Automatically cancelled — candidate placed on Offer Hold";

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function recruiterEmployeeCode(req) {
  const code = String(req?.user?.employee_code || "").trim();
  if (!code) {
    throw httpError("Employee context is required.", 401);
  }
  return code;
}

function normalizeReason(reason) {
  const text = String(reason || "").trim();
  if (!text || !/\S/.test(text)) {
    return "";
  }
  return text;
}

async function resolveOfferHoldSourceRequisitionCode(client, hold) {
  const fromHold = String(hold?.source_requisition_code || "").trim();

  if (fromHold) {
    return fromHold;
  }

  const offerId = String(hold?.offer_id || "").trim();
  if (!offerId) {
    throw httpError(
      "Offer Hold is missing requisition context. Contact support to reconcile the hold record.",
      409
    );
  }

  const offerResult = await client.query(
    `SELECT requisition_code
     FROM om_offers
     WHERE offer_id = $1
     LIMIT 1`,
    [offerId]
  );

  const code = String(offerResult.rows[0]?.requisition_code || "").trim();
  if (!code) {
    throw httpError(
      "Cannot determine the requisition for this Offer Hold. Confirm recruiter assignment on the offer requisition, then retry.",
      409
    );
  }

  return code;
}

/**
 * Release authority: active rm_recruiter_assignments on the hold source requisition only.
 */
async function resolveOfferHoldReleaseAssignment(client, hold, employeeCode) {
  const requisitionCode = await resolveOfferHoldSourceRequisitionCode(client, hold);
  const recruiterCode = String(employeeCode || "").trim();

  if (!recruiterCode) {
    throw httpError("Employee context is required.", 401);
  }

  const assignments = await client.query(
    `SELECT assignment_id, recruiter_code, requisition_code, req_id
     FROM rm_recruiter_assignments
     WHERE is_active = true
       AND recruiter_code = $1
       AND requisition_code = $2
     ORDER BY assigned_on DESC, assignment_id DESC`,
    [recruiterCode, requisitionCode]
  );

  if (!assignments.rows.length) {
    throw httpError(
      `Release denied: you are not an active recruiter assigned to requisition ${requisitionCode}. Ask TA Lead to confirm recruiter assignment, then retry.`,
      403
    );
  }

  if (assignments.rows.length > 1) {
    throw httpError(
      `Release denied: multiple active recruiter assignments exist for requisition ${requisitionCode}. Resolve assignment ambiguity before releasing the hold.`,
      409
    );
  }

  return {
    requisitionCode,
    assignment: assignments.rows[0]
  };
}

async function evaluateOfferHoldReleaseEligibility(pool, hold, req, { client = null } = {}) {
  const employeeCode = String(req?.user?.employee_code || "").trim();
  if (!employeeCode) {
    return { can_release: false, reason: "missing_employee_context" };
  }

  const executor = client || pool;

  try {
    await resolveOfferHoldReleaseAssignment(executor, hold, employeeCode);
    return { can_release: true };
  } catch (error) {
    if (error.status === 403 || error.status === 409) {
      return { can_release: false, reason: error.message };
    }
    throw error;
  }
}

function interviewScheduledInstant(row) {
  const parsed = parseInterviewDateValue(row?.interview_date);
  if (!parsed) {
    return null;
  }

  const time = parseInterviewTime(row?.interview_time) || {
    hour: 0,
    minute: 0,
    second: 0
  };

  if (parsed.kind === "instant") {
    const d = parsed.instant;
    return new Date(
      Date.UTC(
        d.getUTCFullYear(),
        d.getUTCMonth(),
        d.getUTCDate(),
        time.hour,
        time.minute,
        time.second
      )
    );
  }

  return zonedLocalDateTimeToInstant({
    year: parsed.year,
    month: parsed.month,
    day: parsed.day,
    hour: time.hour,
    minute: time.minute,
    second: time.second
  });
}

function isFutureOrCurrentInterview(row, referenceInstant = new Date()) {
  const scheduled = interviewScheduledInstant(row);
  if (!scheduled) {
    return false;
  }
  return scheduled.getTime() >= referenceInstant.getTime();
}

/**
 * Lock order (always): cand_mstr row -> active rm_candidate_offer_hold row.
 * All issuance, restricted mutations and release must use the same order.
 */
async function lockCandidateRow(client, candidateId) {
  const id = Number(candidateId);
  if (!Number.isFinite(id) || id <= 0) {
    throw httpError("candidate_id is required.", 400);
  }

  const result = await client.query(
    `SELECT candidate_id
     FROM cand_mstr
     WHERE candidate_id = $1
     FOR UPDATE`,
    [id]
  );

  if (!result.rows.length) {
    throw httpError("Candidate not found.", 404);
  }

  return result.rows[0];
}

/**
 * Run work under candidate row lock + transaction (serialization point for hold policy).
 */
async function withCandidatePolicyTransaction(pool, candidateId, fn) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await lockCandidateRow(client, candidateId);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (_rollbackError) {
      // preserve original
    }
    throw error;
  } finally {
    client.release();
  }
}

async function getActiveHoldForCandidate(pool, candidateId, { client = pool, forUpdate = false } = {}) {
  const id = Number(candidateId);
  if (!Number.isFinite(id) || id <= 0) {
    return null;
  }

  const lock = forUpdate ? " FOR UPDATE" : "";
  const result = await client.query(
    `SELECT *
     FROM rm_candidate_offer_hold
     WHERE candidate_id = $1
       AND hold_status = $2
     ORDER BY hold_id DESC
     LIMIT 1${lock}`,
    [id, HOLD_STATUS.ACTIVE]
  );

  return result.rows[0] || null;
}

async function recordHoldEvent(
  client,
  holdId,
  eventType,
  req,
  { fromStatus = null, toStatus = null, reason = null, metadata = null } = {}
) {
  const user = userContext(req);
  await client.query(
    `INSERT INTO rm_candidate_offer_hold_event (
      hold_id, event_type, actor_employee_code, actor_name, actor_role,
      from_status, to_status, reason, metadata
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      holdId,
      eventType,
      req?.user?.employee_code || null,
      user.name,
      user.role,
      fromStatus,
      toStatus,
      reason,
      metadata ? JSON.stringify(metadata) : null
    ]
  );
}

/**
 * Throws 409 when candidate has an active offer hold (safe message).
 */
async function assertNoActiveHoldUnderPolicyLock(client, candidateId, req, options = {}) {
  const hold = await getActiveHoldForCandidate(client, candidateId, {
    client,
    forUpdate: true,
    ...options
  });

  if (hold) {
    throw httpError(OFFER_HOLD_BLOCK_MESSAGE, 409);
  }

  return null;
}

async function assertCandidateEligibleForRestrictedMutation(
  pool,
  candidateId,
  req,
  options = {}
) {
  const executor = options.client || pool;

  if (options.client) {
    return assertNoActiveHoldUnderPolicyLock(executor, candidateId, req, options);
  }

  return withCandidatePolicyTransaction(pool, candidateId, async (client) => {
    await assertNoActiveHoldUnderPolicyLock(client, candidateId, req);
    return null;
  });
}

/**
 * Block stage progression on requisitions other than the hold source requisition.
 */
async function assertCandidateEligibleForStageOnMapping(
  pool,
  candidateId,
  requisitionCode,
  req,
  options = {}
) {
  const runCheck = async (client) => {
    const hold = await getActiveHoldForCandidate(client, candidateId, {
      client,
      forUpdate: true
    });

    if (!hold) {
      return null;
    }

    const source = String(hold.source_requisition_code || "").trim();
    const target = String(requisitionCode || "").trim();

    if (source && target && source === target) {
      return hold;
    }

    throw httpError(OFFER_HOLD_BLOCK_MESSAGE, 409);
  };

  if (options.client) {
    return runCheck(options.client);
  }

  return withCandidatePolicyTransaction(pool, candidateId, runCheck);
}

/**
 * Idempotent hold activation inside an open transaction (client).
 */
async function activateHoldOnOfferRelease(client, offerRow, req) {
  const candidateId = Number(offerRow.candidate_id);
  const offerId = String(offerRow.offer_id || "").trim();

  if (!Number.isFinite(candidateId) || candidateId <= 0 || !offerId) {
    throw httpError("Offer must be linked to a candidate before release.", 400);
  }

  await lockCandidateRow(client, candidateId);
  const activationEmployeeCode = recruiterEmployeeCode(req);

  const existing = await getActiveHoldForCandidate(client, candidateId, {
    client,
    forUpdate: true
  });

  if (existing) {
    if (String(existing.offer_id) === offerId) {
      return { hold: existing, created: false };
    }

    throw httpError(
      "Candidate already has an active Offer Hold from another offer.",
      409
    );
  }

  const insert = await client.query(
    `INSERT INTO rm_candidate_offer_hold (
      candidate_id, offer_id, source_requisition_code, hold_status,
      activated_by_employee_code, activated_by
    ) VALUES ($1,$2,$3,$4,$5,$6)
    RETURNING *`,
    [
      candidateId,
      offerId,
      offerRow.requisition_code || null,
      HOLD_STATUS.ACTIVE,
      activationEmployeeCode,
      userContext(req).name
    ]
  );

  const hold = insert.rows[0];

  await recordHoldEvent(client, hold.hold_id, "OfferHoldActivated", req, {
    fromStatus: null,
    toStatus: HOLD_STATUS.ACTIVE,
    metadata: {
      offer_id: offerId,
      requisition_code: offerRow.requisition_code || null
    }
  });

  return { hold, created: true };
}

async function listFutureCancellableInterviews(pool, candidateId, referenceInstant = new Date()) {
  const result = await pool.query(
    `SELECT interview_id, interview_status, interview_date, interview_time, candidate_id, requisition_code
     FROM im_interviews
     WHERE candidate_id = $1
       AND interview_status NOT IN ('Cancelled', 'Completed')`,
    [Number(candidateId)]
  );

  return (result.rows || []).filter((row) => isFutureOrCurrentInterview(row, referenceInstant));
}

async function runHoldActivationSideEffects(pool, hold, req) {
  const interviewService = require("./interviewService");
  const interviewNotificationService = require("./interviewNotificationService");
  const candidateId = Number(hold.candidate_id);
  const referenceInstant = new Date();
  const targets = await listFutureCancellableInterviews(pool, candidateId, referenceInstant);

  const summary = {
    attempted: targets.length,
    cancelled: [],
    failed: [],
    notifications: [],
    skipped_not_future: 0
  };

  for (const row of targets) {
    const interviewId = row.interview_id;

    try {
      await interviewService.cancelInterviewForOfferHold(pool, interviewId, req, {
        offerId: hold.offer_id,
        holdId: hold.hold_id
      });
      summary.cancelled.push(interviewId);

      const notifyResult =
        await interviewNotificationService.notifyInterviewCancelledOfferHold(
          pool,
          {
            interviewId,
            holdId: hold.hold_id,
            offerId: hold.offer_id
          },
          req
        );
      summary.notifications.push({
        interview_id: interviewId,
        ...notifyResult
      });
    } catch (error) {
      summary.failed.push({
        interview_id: interviewId,
        message: error.message
      });
    }
  }

  await pool.query(
    `UPDATE rm_candidate_offer_hold
     SET activation_side_effects = $1::jsonb, modified_on = NOW()
     WHERE hold_id = $2`,
    [JSON.stringify(summary), hold.hold_id]
  );

  await writeEnterpriseAudit(pool, {
    eventType: "OfferHoldActivationSideEffects",
    module: "Recruitment Management",
    entity: "Candidate",
    entityId: String(candidateId),
    action: "Offer hold activation processed interview cancellations",
    userName: userContext(req).name,
    userRole: userContext(req).role,
    metadata: summary
  });

  return summary;
}

async function releaseOfferHold(pool, candidateId, reason, req) {
  const normalizedReason = normalizeReason(reason);
  if (!normalizedReason) {
    throw httpError("Release reason is required.", 400);
  }

  const employeeCode = recruiterEmployeeCode(req);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await lockCandidateRow(client, candidateId);

    const hold = await getActiveHoldForCandidate(client, candidateId, {
      client,
      forUpdate: true
    });

    if (!hold) {
      throw httpError("Candidate is not on an active Offer Hold.", 404);
    }

    const releaseContext = await resolveOfferHoldReleaseAssignment(
      client,
      hold,
      employeeCode
    );

    const updated = await client.query(
      `UPDATE rm_candidate_offer_hold
       SET hold_status = $1,
           released_at = NOW(),
           released_by = $2,
           release_reason = $3,
           modified_on = NOW()
       WHERE hold_id = $4
       RETURNING *`,
      [HOLD_STATUS.RELEASED, userContext(req).name, normalizedReason, hold.hold_id]
    );

    await recordHoldEvent(client, hold.hold_id, "OfferHoldReleased", req, {
      fromStatus: HOLD_STATUS.ACTIVE,
      toStatus: HOLD_STATUS.RELEASED,
      reason: normalizedReason,
      metadata: {
        offer_id: hold.offer_id,
        requisition_code: releaseContext.requisitionCode,
        assignment_id: releaseContext.assignment.assignment_id
      }
    });

    await client.query("COMMIT");

    const releasedHold = updated.rows[0];

    await writeEnterpriseAudit(pool, {
      eventType: "OfferHoldReleased",
      module: "Recruitment Management",
      entity: "Candidate",
      entityId: String(candidateId),
      action: "Candidate released from Offer Hold",
      userName: userContext(req).name,
      userRole: userContext(req).role,
      metadata: {
        offer_id: hold.offer_id,
        reason: normalizedReason
      }
    });

    return { hold: releasedHold };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function getOfferHoldStatusForCandidate(pool, candidateId, req) {
  const hold = await getActiveHoldForCandidate(pool, candidateId);
  if (!hold) {
    return { on_hold: false };
  }

  const eligibility = await evaluateOfferHoldReleaseEligibility(pool, hold, req);

  return {
    on_hold: true,
    hold_id: hold.hold_id,
    offer_id: hold.offer_id,
    source_requisition_code: hold.source_requisition_code,
    activated_at: hold.activated_at,
    can_release: eligibility.can_release,
    release_denied_reason: eligibility.can_release ? null : eligibility.reason,
    activation_side_effects: hold.activation_side_effects || null
  };
}

module.exports = {
  HOLD_STATUS,
  OFFER_HOLD_BLOCK_MESSAGE,
  CANCELLATION_REASON_OFFER_HOLD,
  interviewScheduledInstant,
  isFutureOrCurrentInterview,
  lockCandidateRow,
  withCandidatePolicyTransaction,
  assertNoActiveHoldUnderPolicyLock,
  getActiveHoldForCandidate,
  assertCandidateEligibleForRestrictedMutation,
  assertCandidateEligibleForStageOnMapping,
  activateHoldOnOfferRelease,
  runHoldActivationSideEffects,
  releaseOfferHold,
  getOfferHoldStatusForCandidate,
  listFutureCancellableInterviews,
  resolveOfferHoldSourceRequisitionCode,
  resolveOfferHoldReleaseAssignment,
  evaluateOfferHoldReleaseEligibility
};
