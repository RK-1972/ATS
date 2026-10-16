/**
 * Enforces approved-position source-of-truth on Talent Demand draft / requisition updates.
 */

const requisitionFieldResolutionService = require("../services/requisitionFieldResolutionService");

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function normalizeText(value) {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value).trim();
}

function payloadIncludesApprovedPositionId(payload) {
  return (
    payload &&
    Object.prototype.hasOwnProperty.call(payload, "approved_position_id")
  );
}

function assertApprovedPositionIdImmutable(existingApprovedPositionId, payload) {
  const existing = normalizeText(existingApprovedPositionId);
  if (!existing) {
    return;
  }

  if (!payloadIncludesApprovedPositionId(payload)) {
    return;
  }

  const incoming = normalizeText(payload.approved_position_id);
  if (incoming === "" || incoming === existing) {
    return;
  }

  throw httpError(
    "approved_position_id cannot be changed once linked to an approved workforce position.",
    400
  );
}

async function loadAuthoritativePositionTitle(queryable, approvedPositionId) {
  const positionId = normalizeText(approvedPositionId);
  if (!positionId) {
    return null;
  }

  const result = await queryable.query(
    `SELECT position_title
     FROM wp_approved_positions
     WHERE position_id = $1`,
    [positionId]
  );

  const row = result.rows[0];
  if (!row) {
    throw httpError(`Approved position not found: ${positionId}`, 404);
  }

  return normalizeText(row.position_title);
}

function assertJobTitleMatchesAuthoritative(payloadJobTitle, authoritativeTitle) {
  if (payloadJobTitle === undefined) {
    return;
  }

  const requestedTitle = normalizeText(payloadJobTitle);
  if (!requestedTitle) {
    return;
  }

  const expected = normalizeText(authoritativeTitle);
  if (requestedTitle !== expected) {
    throw httpError(
      "job_title must match the approved position designation.",
      400
    );
  }
}

/**
 * @param {object} queryable - pg Pool or Client
 * @param {object} options
 * @param {string|null|undefined} options.existingApprovedPositionId
 * @param {object} options.payload - update body (draft or requisition editor)
 * @param {string|null|undefined} [options.existingRequisitionCode]
 */
async function assertApprovedPositionUpdateIntegrity(queryable, options = {}) {
  const {
    existingApprovedPositionId,
    payload = {},
    existingRequisitionCode = null
  } = options;

  assertApprovedPositionIdImmutable(existingApprovedPositionId, payload);

  const existingId = normalizeText(existingApprovedPositionId);
  const incomingId = payloadIncludesApprovedPositionId(payload)
    ? normalizeText(payload.approved_position_id)
    : "";

  const effectivePositionId = existingId || incomingId;
  if (!effectivePositionId) {
    return;
  }

  if (!existingId && incomingId) {
    await requisitionFieldResolutionService.assertApprovedPositionSelectable(
      queryable,
      incomingId,
      { existingRequisitionCode }
    );
  }

  const authoritativeTitle = await loadAuthoritativePositionTitle(
    queryable,
    effectivePositionId
  );

  assertJobTitleMatchesAuthoritative(payload.job_title, authoritativeTitle);
}

module.exports = {
  assertApprovedPositionUpdateIntegrity,
  assertApprovedPositionIdImmutable,
  assertJobTitleMatchesAuthoritative,
  loadAuthoritativePositionTitle
};
