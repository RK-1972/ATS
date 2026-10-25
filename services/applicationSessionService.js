const crypto = require("crypto");

const { resolveClientIp, normalizeIp } = require("../utils/clientIpResolver");
const { formatUserAgentSummary, resolveUserAgentSummaryForDisplay } = require("../utils/userAgentSummary");

const SESSION_STATUS = Object.freeze({
  ACTIVE: "ACTIVE",
  LOGGED_OUT: "LOGGED_OUT",
  EXPIRED: "EXPIRED",
  INTERRUPTED: "INTERRUPTED",
  REVOKED: "REVOKED"
});

const JWT_TTL_MS = 8 * 60 * 60 * 1000;
const EMPLOYEE_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const EMPLOYEE_IDLE_WARNING_LEAD_MS = 2 * 60 * 1000;

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function summarizeUserAgent(value) {
  return formatUserAgentSummary(value);
}

async function recordLogin(
  pool,
  { sessionId, user, req, queryExecutor = null, skipReconcile = false }
) {
  const normalizedSessionId = String(sessionId || "").trim();
  const employeeCode = String(user?.employee_code || "").trim();

  if (!normalizedSessionId || !employeeCode) {
    throw httpError("sessionId and employee_code are required to record login.", 400);
  }

  const query = queryExecutor || ((sql, params) => pool.query(sql, params));

  await query(
    `INSERT INTO app_user_session (
       session_id, employee_code, user_id, email_id,
       login_at, last_seen_at, last_user_activity_at,
       source_ip, status, user_agent_summary
     ) VALUES ($1,$2,$3,$4,NOW(),NOW(),NOW(),$5,$6,$7)`,
    [
      normalizedSessionId,
      employeeCode,
      user.user_id ?? null,
      user.email_id ?? null,
      resolveClientIp(req),
      SESSION_STATUS.ACTIVE,
      summarizeUserAgent(req?.headers?.["user-agent"])
    ]
  );

  if (!skipReconcile) {
    await reconcileSupersededActiveSessions(pool, {
      employeeCode,
      keepSessionId: normalizedSessionId
    });
  }

  return { session_id: normalizedSessionId, status: SESSION_STATUS.ACTIVE };
}

async function touchSession(pool, sessionId) {
  const id = String(sessionId || "").trim();
  if (!id) {
    return { updated: false };
  }

  const result = await pool.query(
    `UPDATE app_user_session
     SET last_seen_at = NOW()
     WHERE session_id = $1
       AND status = $2
     RETURNING session_id`,
    [id, SESSION_STATUS.ACTIVE]
  );

  return { updated: result.rowCount > 0 };
}

async function confirmLogout(pool, sessionId, { reason = "USER_LOGOUT" } = {}) {
  const id = String(sessionId || "").trim();
  if (!id) {
    return { updated: false };
  }

  const result = await pool.query(
    `UPDATE app_user_session
     SET status = $2,
         logout_at = NOW(),
         termination_reason = $3,
         last_seen_at = COALESCE(last_seen_at, NOW())
     WHERE session_id = $1
       AND status = $4
     RETURNING session_id`,
    [id, SESSION_STATUS.LOGGED_OUT, String(reason).slice(0, 64), SESSION_STATUS.ACTIVE]
  );

  return { updated: result.rowCount > 0 };
}

/**
 * Called after user_mstr is deactivated (is_active = false). Failures are logged only.
 */
async function onEmployeeAccountDeactivated(pool, employeeCode) {
  try {
    const revokeResult = await revokeActiveSessionsForEmployee(pool, employeeCode, {
      reason: "ACCOUNT_DEACTIVATED"
    });
    try {
      const { cancelPendingForEmployee } = require("./sessionTakeoverService");
      await cancelPendingForEmployee(pool, employeeCode, {
        reason: "ACCOUNT_DEACTIVATED"
      });
    } catch (takeoverCancelError) {
      console.error(
        "[applicationSession] Failed to cancel pending takeover requests",
        {
          employee_code: String(employeeCode || "").trim(),
          message: takeoverCancelError.message
        }
      );
    }
    return revokeResult;
  } catch (error) {
    console.error(
      "[applicationSession] Failed to revoke active sessions after deactivation",
      {
        employee_code: String(employeeCode || "").trim(),
        message: error.message
      }
    );
    return { updated: 0, failed: true };
  }
}

async function revokeActiveSessionsForEmployee(pool, employeeCode, { reason = "ACCOUNT_REVOKED" } = {}) {
  const code = String(employeeCode || "").trim();
  if (!code) {
    return { updated: 0 };
  }

  const result = await pool.query(
    `UPDATE app_user_session
     SET status = $2,
         termination_reason = $3,
         last_seen_at = COALESCE(last_seen_at, NOW())
     WHERE employee_code = $1
       AND status = $4`,
    [code, SESSION_STATUS.REVOKED, String(reason).slice(0, 64), SESSION_STATUS.ACTIVE]
  );

  return { updated: result.rowCount };
}

/**
 * Mark stale ACTIVE sessions as EXPIRED (JWT TTL elapsed since login).
 * Does not set logout_at — expiry time is not a confirmed logout.
 */
async function expireStaleActiveSessions(pool, { now = new Date() } = {}) {
  const cutoff = new Date(now.getTime() - JWT_TTL_MS);

  const result = await pool.query(
    `UPDATE app_user_session
     SET status = $2,
         termination_reason = $3,
         last_seen_at = COALESCE(last_seen_at, login_at)
     WHERE status = $4
       AND login_at < $1`,
    [cutoff.toISOString(), SESSION_STATUS.EXPIRED, "JWT_EXPIRED", SESSION_STATUS.ACTIVE]
  );

  return { updated: result.rowCount };
}

/**
 * When the same employee has multiple ACTIVE sessions, keep the newest login ACTIVE
 * and mark older ones INTERRUPTED (no logout_at — not a user logout).
 */
async function reconcileSupersededActiveSessions(
  pool,
  { employeeCode = null, keepSessionId = null } = {}
) {
  const values = [SESSION_STATUS.INTERRUPTED, "SUPERSEDED", SESSION_STATUS.ACTIVE];
  const conditions = [
    `s.status = $3`,
    `EXISTS (
       SELECT 1
       FROM app_user_session newer
       WHERE newer.employee_code = s.employee_code
         AND newer.status = $3
         AND newer.login_at > s.login_at
     )`
  ];

  if (employeeCode) {
    values.push(String(employeeCode).trim());
    conditions.push(`s.employee_code = $${values.length}`);
  }

  if (keepSessionId) {
    values.push(String(keepSessionId).trim());
    conditions.push(`s.session_id <> $${values.length}::uuid`);
  }

  const result = await pool.query(
    `UPDATE app_user_session s
     SET status = $1,
         termination_reason = $2
     WHERE ${conditions.join(" AND ")}`,
    values
  );

  return { updated: result.rowCount };
}

/**
 * Sessions with no genuine user activity — interrupted, not logged out.
 * Telemetry heartbeats update last_seen_at only, not last_user_activity_at.
 */
async function markInterruptedSessions(
  pool,
  { inactivityMs = EMPLOYEE_IDLE_TIMEOUT_MS, now = new Date() } = {}
) {
  const cutoff = new Date(now.getTime() - inactivityMs);

  const result = await pool.query(
    `UPDATE app_user_session
     SET status = $2,
         termination_reason = $3
     WHERE status = $4
       AND COALESCE(last_user_activity_at, login_at) < $1`,
    [cutoff.toISOString(), SESSION_STATUS.INTERRUPTED, "IDLE_TIMEOUT", SESSION_STATUS.ACTIVE]
  );

  return { updated: result.rowCount };
}

function toIso(value) {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return value;
}

function computeEmployeeIdleDeadlines(row, { now = new Date() } = {}) {
  const loginAt = row.login_at ? new Date(row.login_at) : null;
  const activityAt = new Date(
    row.last_user_activity_at || row.login_at || now
  );
  const nowMs = now.getTime();

  if (!loginAt || Number.isNaN(loginAt.getTime()) || Number.isNaN(activityAt.getTime())) {
    return null;
  }

  const absoluteExpiresAt = new Date(loginAt.getTime() + JWT_TTL_MS);
  const idleExpiresAt = new Date(activityAt.getTime() + EMPLOYEE_IDLE_TIMEOUT_MS);
  const warningAt = new Date(
    activityAt.getTime() + EMPLOYEE_IDLE_TIMEOUT_MS - EMPLOYEE_IDLE_WARNING_LEAD_MS
  );

  const effectiveExpiresAt = new Date(
    Math.min(idleExpiresAt.getTime(), absoluteExpiresAt.getTime())
  );

  return {
    server_now: new Date(nowMs).toISOString(),
    login_at: toIso(row.login_at),
    last_user_activity_at: toIso(row.last_user_activity_at || row.login_at),
    warning_at: warningAt.toISOString(),
    idle_expires_at: idleExpiresAt.toISOString(),
    absolute_expires_at: absoluteExpiresAt.toISOString(),
    effective_expires_at: effectiveExpiresAt.toISOString(),
    is_idle_expired: nowMs >= idleExpiresAt.getTime(),
    is_absolute_expired: nowMs >= absoluteExpiresAt.getTime()
  };
}

/**
 * Terminate a single session when idle deadline has passed (per-request enforcement).
 */
async function terminateIdleSessionIfDue(pool, sessionId, { now = new Date() } = {}) {
  const id = String(sessionId || "").trim();
  if (!id) {
    return { terminated: false };
  }

  const cutoff = new Date(now.getTime() - EMPLOYEE_IDLE_TIMEOUT_MS);

  const result = await pool.query(
    `UPDATE app_user_session
     SET status = $2,
         termination_reason = $3
     WHERE session_id = $1::uuid
       AND status = $4
       AND COALESCE(last_user_activity_at, login_at) < $5
     RETURNING session_id`,
    [
      id,
      SESSION_STATUS.INTERRUPTED,
      "IDLE_TIMEOUT",
      SESSION_STATUS.ACTIVE,
      cutoff.toISOString()
    ]
  );

  return { terminated: result.rowCount > 0 };
}

/**
 * Server-authoritative idle timeout completion (not USER_LOGOUT).
 * Idempotent when already INTERRUPTED with IDLE_TIMEOUT.
 */
async function completeIdleTimeoutTermination(pool, sessionId, { now = new Date() } = {}) {
  const id = String(sessionId || "").trim();
  if (!id) {
    return { ok: false, code: "MISSING_SESSION" };
  }

  const terminateResult = await terminateIdleSessionIfDue(pool, id, { now });
  if (terminateResult.terminated) {
    return { ok: true, terminated: true };
  }

  const result = await pool.query(
    `SELECT status, termination_reason
     FROM app_user_session
     WHERE session_id = $1::uuid`,
    [id]
  );

  if (!result.rows.length) {
    return { ok: false, code: "NOT_FOUND" };
  }

  const row = result.rows[0];
  if (
    row.status === SESSION_STATUS.INTERRUPTED
    && row.termination_reason === "IDLE_TIMEOUT"
  ) {
    return { ok: true, terminated: false, alreadyTerminated: true };
  }

  if (row.status !== SESSION_STATUS.ACTIVE) {
    return { ok: false, code: "INACTIVE" };
  }

  return { ok: false, code: "NOT_DUE" };
}

async function recordUserActivity(pool, sessionId, { now = new Date() } = {}) {
  const id = String(sessionId || "").trim();
  if (!id) {
    return { updated: false };
  }

  const idleTerminate = await terminateIdleSessionIfDue(pool, id, { now });
  if (idleTerminate.terminated) {
    return { updated: false };
  }

  const existing = await pool.query(
    `SELECT login_at, status
     FROM app_user_session
     WHERE session_id = $1::uuid`,
    [id]
  );

  if (!existing.rows.length || existing.rows[0].status !== SESSION_STATUS.ACTIVE) {
    return { updated: false };
  }

  const loginAt = new Date(existing.rows[0].login_at);
  if (Number.isNaN(loginAt.getTime()) || now.getTime() - loginAt.getTime() > JWT_TTL_MS) {
    return { updated: false };
  }

  const result = await pool.query(
    `UPDATE app_user_session
     SET last_user_activity_at = $2
     WHERE session_id = $1::uuid
       AND status = $3
     RETURNING session_id`,
    [id, now.toISOString(), SESSION_STATUS.ACTIVE]
  );

  return { updated: result.rowCount > 0 };
}

async function recordUserActivityThrottled(pool, sessionId, options = {}) {
  const {
    assertEmployeeActivityWriteAllowed
  } = require("../utils/employeeSessionActivityThrottle");

  const throttle = assertEmployeeActivityWriteAllowed(sessionId, {
    nowMs: options.now instanceof Date ? options.now.getTime() : Date.now()
  });

  if (!throttle.allowed) {
    let status = null;
    try {
      status = await getEmployeeIdleStatus(pool, sessionId);
    } catch {
      status = null;
    }
    return { updated: false, throttled: true, status };
  }

  const activity = await recordUserActivity(pool, sessionId, options);
  return { ...activity, throttled: false };
}

async function getEmployeeIdleStatus(pool, sessionId) {
  const id = String(sessionId || "").trim();
  if (!id) {
    throw httpError("Session identifier is required.", 400);
  }

  const result = await pool.query(
    `SELECT login_at, last_user_activity_at, status
     FROM app_user_session
     WHERE session_id = $1::uuid`,
    [id]
  );

  if (!result.rows.length || result.rows[0].status !== SESSION_STATUS.ACTIVE) {
    throw httpError("Your session is no longer active. Sign in again.", 401);
  }

  const deadlines = computeEmployeeIdleDeadlines(result.rows[0]);
  if (!deadlines) {
    throw httpError("Unable to resolve session idle status.", 500);
  }

  return deadlines;
}

const SESSION_MAINTENANCE_THROTTLE_MS = 5 * 60 * 1000;

let lastMaintenanceAttemptMs = 0;
let maintenanceInFlight = null;

/**
 * Expire JWT-stale sessions, then mark inactive ones interrupted (order matters).
 */
async function refreshStaleSessionStates(pool, { now = new Date(), inactivityMs } = {}) {
  const expireResult = await expireStaleActiveSessions(pool, { now });
  const supersededResult = await reconcileSupersededActiveSessions(pool);
  const interruptOptions = { now };
  if (inactivityMs !== undefined) {
    interruptOptions.inactivityMs = inactivityMs;
  }
  const interruptResult = await markInterruptedSessions(pool, interruptOptions);

  return {
    expired: expireResult.updated,
    superseded: supersededResult.updated,
    interrupted: interruptResult.updated
  };
}

function resetSessionMaintenanceThrottleForTests() {
  lastMaintenanceAttemptMs = 0;
  maintenanceInFlight = null;
}

async function refreshStaleSessionStatesThrottled(pool, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const nowMs = now.getTime();
  const throttleMs =
    options.throttleMs !== undefined ? options.throttleMs : SESSION_MAINTENANCE_THROTTLE_MS;

  if (maintenanceInFlight) {
    return maintenanceInFlight;
  }

  if (lastMaintenanceAttemptMs > 0 && nowMs - lastMaintenanceAttemptMs < throttleMs) {
    return { skipped: true, reason: "throttled" };
  }

  maintenanceInFlight = (async () => {
    lastMaintenanceAttemptMs = nowMs;
    try {
      const result = await refreshStaleSessionStates(pool, { ...options, now });
      return {
        skipped: false,
        expired: result.expired,
        superseded: result.superseded,
        interrupted: result.interrupted
      };
    } catch (error) {
      lastMaintenanceAttemptMs = 0;
      throw error;
    } finally {
      maintenanceInFlight = null;
    }
  })();

  return maintenanceInFlight;
}

async function refreshStaleSessionStatesForHeartbeat(pool, options = {}) {
  try {
    return await refreshStaleSessionStatesThrottled(pool, options);
  } catch (error) {
    console.error("[applicationSession] Session maintenance failed", {
      message: error.message
    });
    return { skipped: false, failed: true };
  }
}

function computeDurationSeconds(row) {
  const loginAt = row.login_at ? new Date(row.login_at) : null;
  if (!loginAt || Number.isNaN(loginAt.getTime())) {
    return null;
  }

  if (row.logout_at) {
    const logoutAt = new Date(row.logout_at);
    if (!Number.isNaN(logoutAt.getTime())) {
      return Math.max(0, Math.round((logoutAt.getTime() - loginAt.getTime()) / 1000));
    }
  }

  const status = String(row.status || "");
  if (status === SESSION_STATUS.EXPIRED || status === SESSION_STATUS.INTERRUPTED) {
    const end = row.last_seen_at ? new Date(row.last_seen_at) : null;
    if (end && !Number.isNaN(end.getTime())) {
      return Math.max(0, Math.round((end.getTime() - loginAt.getTime()) / 1000));
    }
  }

  if (status === SESSION_STATUS.ACTIVE) {
    const end = row.last_seen_at ? new Date(row.last_seen_at) : null;
    if (end && !Number.isNaN(end.getTime())) {
      return Math.max(0, Math.round((end.getTime() - loginAt.getTime()) / 1000));
    }
  }

  return null;
}

function mapSessionRow(row) {
  const loginAt = row.login_at;
  const logoutAt = row.logout_at;

  const fullName = row.full_name ? String(row.full_name).trim() : "";

  return {
    session_id: row.session_id,
    employee_code: row.employee_code,
    full_name: fullName || null,
    user_id: row.user_id,
    email_id: row.email_id,
    login_at: loginAt instanceof Date ? loginAt.toISOString() : loginAt,
    logout_at: logoutAt instanceof Date ? logoutAt.toISOString() : logoutAt,
    last_seen_at:
      row.last_seen_at instanceof Date
        ? row.last_seen_at.toISOString()
        : row.last_seen_at,
    source_ip: normalizeIp(row.source_ip) || row.source_ip,
    user_agent_summary: resolveUserAgentSummaryForDisplay(row.user_agent_summary),
    status: row.status,
    termination_reason: row.termination_reason,
    duration_seconds: computeDurationSeconds(row)
  };
}

module.exports = {
  SESSION_STATUS,
  JWT_TTL_MS,
  EMPLOYEE_IDLE_TIMEOUT_MS,
  EMPLOYEE_IDLE_WARNING_LEAD_MS,
  recordLogin,
  touchSession,
  recordUserActivity,
  recordUserActivityThrottled,
  getEmployeeIdleStatus,
  terminateIdleSessionIfDue,
  completeIdleTimeoutTermination,
  computeEmployeeIdleDeadlines,
  confirmLogout,
  revokeActiveSessionsForEmployee,
  onEmployeeAccountDeactivated,
  expireStaleActiveSessions,
  markInterruptedSessions,
  refreshStaleSessionStates,
  refreshStaleSessionStatesThrottled,
  refreshStaleSessionStatesForHeartbeat,
  resetSessionMaintenanceThrottleForTests,
  SESSION_MAINTENANCE_THROTTLE_MS,
  computeDurationSeconds,
  mapSessionRow,
  reconcileSupersededActiveSessions
};
