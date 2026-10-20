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

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function summarizeUserAgent(value) {
  return formatUserAgentSummary(value);
}

async function recordLogin(pool, { sessionId, user, req }) {
  const normalizedSessionId = String(sessionId || "").trim();
  const employeeCode = String(user?.employee_code || "").trim();

  if (!normalizedSessionId || !employeeCode) {
    throw httpError("sessionId and employee_code are required to record login.", 400);
  }

  await pool.query(
    `INSERT INTO app_user_session (
       session_id, employee_code, user_id, email_id,
       login_at, last_seen_at, source_ip, status, user_agent_summary
     ) VALUES ($1,$2,$3,$4,NOW(),NOW(),$5,$6,$7)`,
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

  await reconcileSupersededActiveSessions(pool, {
    employeeCode,
    keepSessionId: normalizedSessionId
  });

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
    return await revokeActiveSessionsForEmployee(pool, employeeCode, {
      reason: "ACCOUNT_DEACTIVATED"
    });
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
 * Sessions with no heartbeat after grace period — interrupted, not logged out.
 */
async function markInterruptedSessions(pool, { inactivityMs = 30 * 60 * 1000, now = new Date() } = {}) {
  const cutoff = new Date(now.getTime() - inactivityMs);

  const result = await pool.query(
    `UPDATE app_user_session
     SET status = $2,
         termination_reason = $3
     WHERE status = $4
       AND COALESCE(last_seen_at, login_at) < $1`,
    [cutoff.toISOString(), SESSION_STATUS.INTERRUPTED, "INACTIVITY", SESSION_STATUS.ACTIVE]
  );

  return { updated: result.rowCount };
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
  recordLogin,
  touchSession,
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
