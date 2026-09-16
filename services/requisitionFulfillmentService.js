/**
 * Requisition fulfillment metrics and recruiting-capacity guards.
 * Reserved = Accepted offers; Filled = active governed JOINED mappings.
 */

const {
  REQUISITION_STATUS,
  isClosedRequisitionStatus
} = require("../constants/requisitionStatus");

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function normalizeRequiredHeadcount(headcount) {
  const parsed = Number(headcount);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return 1;
  }

  return Math.trunc(parsed);
}

function isJoinedStageName(stageName) {
  const normalized = String(stageName || "").trim();
  if (!normalized) {
    return false;
  }

  if (normalized === "Joined") {
    return true;
  }

  return /join/i.test(normalized);
}

function buildFulfillmentMetrics({
  headcount,
  reqStatus,
  reserved = 0,
  filled = 0
}) {
  const required = normalizeRequiredHeadcount(headcount);
  const reservedCount = Number(reserved) || 0;
  const filledCount = Number(filled) || 0;
  const remaining = Math.max(0, required - filledCount);
  const closureEligible =
    reqStatus === REQUISITION_STATUS.APPROVED && filledCount >= required;
  const dataQualityException = filledCount > required;

  let closureStatus = "Open";
  if (reqStatus === REQUISITION_STATUS.CLOSED_FILLED) {
    closureStatus = REQUISITION_STATUS.CLOSED_FILLED;
  } else if (reqStatus === REQUISITION_STATUS.CLOSED_CANCELLED) {
    closureStatus = REQUISITION_STATUS.CLOSED_CANCELLED;
  } else if (closureEligible) {
    closureStatus = "Closure Eligible";
  }

  return {
    required_headcount: required,
    reserved_headcount: reservedCount,
    filled_headcount: filledCount,
    remaining_headcount: remaining,
    closure_eligible: closureEligible,
    data_quality_exception: dataQualityException,
    closure_status: closureStatus
  };
}

async function countReservedOffers(queryable, requisitionCode) {
  const result = await queryable.query(
    `SELECT COUNT(*)::int AS total
     FROM om_offers
     WHERE requisition_code = $1
       AND offer_status = 'Accepted'`,
    [requisitionCode]
  );

  return result.rows[0]?.total ?? 0;
}

async function countFilledCandidates(queryable, requisitionCode) {
  const result = await queryable.query(
    `SELECT COUNT(DISTINCT m.candidate_id)::int AS total
     FROM rm_candidate_mappings m
     WHERE m.requisition_code = $1
       AND m.is_active = TRUE
       AND m.candidate_id IS NOT NULL
       AND (
         BTRIM(COALESCE(m.stage_name, '')) = 'Joined'
         OR LOWER(COALESCE(m.stage_name, '')) LIKE '%join%'
       )`,
    [requisitionCode]
  );

  return result.rows[0]?.total ?? 0;
}

async function getFulfillmentForRequisition(queryable, requisition) {
  const [reserved, filled] = await Promise.all([
    countReservedOffers(queryable, requisition.requisition_code),
    countFilledCandidates(queryable, requisition.requisition_code)
  ]);

  return buildFulfillmentMetrics({
    headcount: requisition.headcount,
    reqStatus: requisition.req_status,
    reserved,
    filled
  });
}

async function enrichRequisitionsWithFulfillment(queryable, requisitions = []) {
  if (!requisitions.length) {
    return [];
  }

  const codes = requisitions
    .map((row) => row.requisition_code)
    .filter(Boolean);

  const [reservedRows, filledRows] = await Promise.all([
    queryable.query(
      `SELECT requisition_code, COUNT(*)::int AS reserved
       FROM om_offers
       WHERE requisition_code = ANY($1::text[])
         AND offer_status = 'Accepted'
       GROUP BY requisition_code`,
      [codes]
    ),
    queryable.query(
      `SELECT requisition_code, COUNT(DISTINCT candidate_id)::int AS filled
       FROM rm_candidate_mappings
       WHERE requisition_code = ANY($1::text[])
         AND is_active = TRUE
         AND candidate_id IS NOT NULL
         AND (
           BTRIM(COALESCE(stage_name, '')) = 'Joined'
           OR LOWER(COALESCE(stage_name, '')) LIKE '%join%'
         )
       GROUP BY requisition_code`,
      [codes]
    )
  ]);

  const reservedByCode = Object.fromEntries(
    reservedRows.rows.map((row) => [row.requisition_code, row.reserved])
  );
  const filledByCode = Object.fromEntries(
    filledRows.rows.map((row) => [row.requisition_code, row.filled])
  );

  return requisitions.map((requisition) => ({
    ...requisition,
    fulfillment: buildFulfillmentMetrics({
      headcount: requisition.headcount,
      reqStatus: requisition.req_status,
      reserved: reservedByCode[requisition.requisition_code] || 0,
      filled: filledByCode[requisition.requisition_code] || 0
    })
  }));
}

async function lockRequisitionForUpdate(queryable, requisitionCode) {
  const result = await queryable.query(
    `SELECT *
     FROM rm_requisitions
     WHERE requisition_code = $1
     FOR UPDATE`,
    [requisitionCode]
  );

  if (!result.rows[0]) {
    throw httpError(`Requisition not found: ${requisitionCode}`, 404);
  }

  return result.rows[0];
}

function assertRequisitionOpenForRecruiting(requisition) {
  if (isClosedRequisitionStatus(requisition?.req_status)) {
    throw httpError(
      `Requisition ${requisition.requisition_code} is ${requisition.req_status} and cannot accept new recruiting activity.`,
      400
    );
  }
}

async function assertNoDuplicateAcceptedOffer(
  queryable,
  requisitionCode,
  candidateId,
  excludeOfferId = null
) {
  const params = [requisitionCode, candidateId];
  let sql = `SELECT offer_id
             FROM om_offers
             WHERE requisition_code = $1
               AND candidate_id = $2
               AND offer_status = 'Accepted'`;

  if (excludeOfferId) {
    sql += " AND offer_id <> $3";
    params.push(excludeOfferId);
  }

  sql += " LIMIT 1";

  const result = await queryable.query(sql, params);

  if (result.rows.length > 0) {
    throw httpError(
      "An active Accepted offer already exists for this candidate on this requisition.",
      409
    );
  }
}

async function assertReservedCapacityAvailable(
  queryable,
  requisition,
  excludeOfferId = null
) {
  const required = normalizeRequiredHeadcount(requisition.headcount);
  const params = [requisition.requisition_code];
  let sql = `SELECT COUNT(*)::int AS total
             FROM om_offers
             WHERE requisition_code = $1
               AND offer_status = 'Accepted'`;

  if (excludeOfferId) {
    sql += " AND offer_id <> $2";
    params.push(excludeOfferId);
  }

  const result = await queryable.query(sql, params);
  const reserved = result.rows[0]?.total ?? 0;

  if (reserved >= required) {
    throw httpError(
      `Accepted offer capacity reached for requisition ${requisition.requisition_code} (${reserved}/${required}).`,
      400
    );
  }
}

async function countClosureEligibleRequisitions(queryable) {
  const result = await queryable.query(
    `SELECT r.requisition_code, r.headcount
     FROM rm_requisitions r
     WHERE r.req_status = $1`,
    [REQUISITION_STATUS.APPROVED]
  );

  if (!result.rows.length) {
    return 0;
  }

  const enriched = await enrichRequisitionsWithFulfillment(queryable, result.rows);
  return enriched.filter((row) => row.fulfillment?.closure_eligible === true).length;
}

module.exports = {
  buildFulfillmentMetrics,
  countReservedOffers,
  countFilledCandidates,
  getFulfillmentForRequisition,
  enrichRequisitionsWithFulfillment,
  lockRequisitionForUpdate,
  assertRequisitionOpenForRecruiting,
  assertNoDuplicateAcceptedOffer,
  assertReservedCapacityAvailable,
  countClosureEligibleRequisitions,
  isJoinedStageName,
  normalizeRequiredHeadcount,
  isClosedRequisitionStatus
};
