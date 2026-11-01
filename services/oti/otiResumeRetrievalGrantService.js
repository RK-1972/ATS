/**
 * Time-limited single-purpose resume retrieval grants (Phase 4).
 */

const crypto = require("crypto");
const { assertResumeDownloadPermitted } = require("./connectors/otiConnectorPermissions");
const otiCapabilityAuth = require("./otiCapabilityAuth");

const DEFAULT_GRANT_MINUTES = 15;

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function buildGrantUuid() {
  return `oti-grant-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

function buildReplayNonce() {
  return crypto.randomBytes(16).toString("hex");
}

async function recordRetrievalEvent(pool, payload) {
  await pool.query(
    `INSERT INTO oti_resume_retrieval_event (
       grant_id, external_lead_id, event_type, status, message, actor_employee_code
     ) VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      payload.grant_id || null,
      payload.external_lead_id,
      payload.event_type,
      payload.status || null,
      payload.message || null,
      payload.actor_employee_code || null
    ]
  );
}

async function createRetrievalGrant(pool, { externalLeadId, providerKey, requestedBy, permissionSnapshot }) {
  assertResumeDownloadPermitted(permissionSnapshot);

  const grantUuid = buildGrantUuid();
  const replayNonce = buildReplayNonce();
  const expiresOn = new Date(Date.now() + DEFAULT_GRANT_MINUTES * 60 * 1000);

  const insert = await pool.query(
    `INSERT INTO oti_resume_retrieval_grant (
       grant_uuid, external_lead_id, provider_key, requested_by, status, expires_on,
       replay_nonce, permission_snapshot, max_attempts
     ) VALUES ($1,$2,$3,$4,'pending',$5,$6,$7,1)
     RETURNING *`,
    [
      grantUuid,
      externalLeadId,
      providerKey,
      requestedBy,
      expiresOn,
      replayNonce,
      JSON.stringify(permissionSnapshot || {})
    ]
  );

  return insert.rows[0];
}

async function loadGrantByUuid(pool, grantUuid) {
  const result = await pool.query(
    "SELECT * FROM oti_resume_retrieval_grant WHERE grant_uuid = $1 LIMIT 1",
    [String(grantUuid || "").trim()]
  );

  return result.rows[0] || null;
}

async function loadGrantById(pool, grantId) {
  const result = await pool.query(
    "SELECT * FROM oti_resume_retrieval_grant WHERE grant_id = $1 LIMIT 1",
    [grantId]
  );

  return result.rows[0] || null;
}

async function reloadAndAssertGrantExecutable(pool, grantId, context) {
  const grant = await loadGrantById(pool, grantId);
  assertGrantExecutable(grant, { ...context, skipAttemptLimit: true });
  return grant;
}

function assertGrantExecutable(grant, { requestedBy, replayNonce, skipAttemptLimit = false } = {}) {
  if (!grant) {
    throw httpError("Retrieval grant not found.", 404);
  }

  if (grant.revoked_on) {
    throw httpError("Retrieval grant has been revoked.", 403);
  }

  if (grant.consumed_on || grant.status === "completed") {
    throw httpError("Retrieval grant has already been used.", 409);
  }

  if (new Date(grant.expires_on).getTime() <= Date.now()) {
    throw httpError("Retrieval grant has expired.", 410);
  }

  if (String(grant.requested_by || "") !== String(requestedBy || "")) {
    throw httpError("Retrieval grant belongs to a different user.", 403);
  }

  if (replayNonce && String(grant.replay_nonce || "") !== String(replayNonce)) {
    throw httpError("Invalid retrieval grant nonce.", 403);
  }

  if (
    !skipAttemptLimit &&
    Number(grant.attempt_count || 0) >= Number(grant.max_attempts || 1)
  ) {
    throw httpError("Retrieval grant retry limit reached.", 429);
  }
}

async function markGrantStatus(pool, grantId, status, fields = {}, options = {}) {
  const requireStatuses = Array.isArray(options.requireStatuses)
    ? options.requireStatuses.map((item) => String(item))
    : null;

  const params = [
    grantId,
    status,
    fields.failure_reason || null,
    fields.consumed_on || null,
    fields.document_id || null,
    Boolean(fields.increment_attempt)
  ];

  let sql = `UPDATE oti_resume_retrieval_grant
     SET status = $2,
         failure_reason = COALESCE($3, failure_reason),
         consumed_on = COALESCE($4, consumed_on),
         document_id = COALESCE($5, document_id),
         attempt_count = attempt_count + CASE WHEN $6 THEN 1 ELSE 0 END,
         updated_on = NOW()
     WHERE grant_id = $1`;

  if (requireStatuses && requireStatuses.length > 0) {
    sql += " AND status = ANY($7) AND revoked_on IS NULL";
    params.push(requireStatuses);
  }

  sql += " RETURNING grant_id";

  const result = await pool.query(sql, params);

  if (requireStatuses && requireStatuses.length > 0 && result.rowCount === 0) {
    throw httpError("Retrieval grant is no longer active.", 403);
  }

  return result.rows[0] || null;
}

const REVOCABLE_GRANT_STATUSES = new Set(["pending", "retrieving", "approved"]);

async function revokeGrant(pool, grantUuid, req, context = {}) {
  const grant = await loadGrantByUuid(pool, grantUuid);
  if (!grant) {
    throw httpError("Retrieval grant not found.", 404);
  }

  const externalLeadId = Number(context.external_lead_id);
  if (Number.isFinite(externalLeadId) && externalLeadId > 0) {
    if (Number(grant.external_lead_id) !== externalLeadId) {
      throw httpError("Retrieval grant does not belong to this external lead.", 403);
    }
  }

  if (grant.revoked_on || grant.status === "revoked") {
    throw httpError("Retrieval grant has already been revoked.", 409);
  }

  if (grant.consumed_on || grant.status === "completed") {
    throw httpError("Completed retrieval grants cannot be revoked.", 409);
  }

  if (!REVOCABLE_GRANT_STATUSES.has(String(grant.status || "").trim())) {
    throw httpError("Retrieval grant cannot be revoked in its current state.", 409);
  }

  const operationContext = otiCapabilityAuth.extractOtiOperationContext(req, context);
  await otiCapabilityAuth.assertExternalLeadAccessible(
    pool,
    req,
    grant.external_lead_id,
    operationContext
  );

  const actorCode = String(req.user?.employee_code || "").trim();
  if (!otiCapabilityAuth.isAdminUser(req) && String(grant.requested_by || "") !== actorCode) {
    throw httpError("Only the requesting recruiter can revoke this grant.", 403);
  }

  const revokeResult = await pool.query(
    `UPDATE oti_resume_retrieval_grant
     SET status = 'revoked', revoked_on = NOW(), updated_on = NOW()
     WHERE grant_id = $1
       AND status = ANY($2)
       AND revoked_on IS NULL
     RETURNING grant_id`,
    [grant.grant_id, Array.from(REVOCABLE_GRANT_STATUSES)]
  );

  if (revokeResult.rowCount === 0) {
    throw httpError("Retrieval grant cannot be revoked in its current state.", 409);
  }

  await recordRetrievalEvent(pool, {
    grant_id: grant.grant_id,
    external_lead_id: grant.external_lead_id,
    event_type: "grant_revoked",
    status: "revoked",
    actor_employee_code: actorCode
  });

  return { grant_uuid: grant.grant_uuid, status: "revoked" };
}

async function expireStaleGrants(pool) {
  await pool.query(
    `UPDATE oti_resume_retrieval_grant
     SET status = 'expired', updated_on = NOW()
     WHERE status IN ('pending', 'approved', 'retrieving')
       AND expires_on <= NOW()`
  );
}

module.exports = {
  DEFAULT_GRANT_MINUTES,
  createRetrievalGrant,
  loadGrantByUuid,
  loadGrantById,
  reloadAndAssertGrantExecutable,
  assertGrantExecutable,
  markGrantStatus,
  revokeGrant,
  expireStaleGrants,
  recordRetrievalEvent,
  REVOCABLE_GRANT_STATUSES
};
