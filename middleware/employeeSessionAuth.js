const {
  SESSION_STATUS,
  refreshStaleSessionStatesForHeartbeat
} = require("../services/applicationSessionService");

const SESSION_INVALID_MESSAGE =
  "Your session is no longer active. Sign in again.";

const SESSION_INVALID_CODE = "SESSION_INVALID";

/**
 * Fail closed when JWT session_id is missing or not ACTIVE in app_user_session.
 */
async function assertEmployeeSessionActive(pool, verifiedUser) {
  const sessionId = verifiedUser?.session_id
    ? String(verifiedUser.session_id).trim()
    : "";

  if (!sessionId) {
    return {
      ok: false,
      status: 401,
      message: SESSION_INVALID_MESSAGE,
      code: SESSION_INVALID_CODE
    };
  }

  await refreshStaleSessionStatesForHeartbeat(pool);

  const result = await pool.query(
    `SELECT status
     FROM app_user_session
     WHERE session_id = $1::uuid`,
    [sessionId]
  );

  if (!result.rows.length || result.rows[0].status !== SESSION_STATUS.ACTIVE) {
    return {
      ok: false,
      status: 401,
      message: SESSION_INVALID_MESSAGE,
      code: SESSION_INVALID_CODE
    };
  }

  return { ok: true };
}

module.exports = {
  SESSION_INVALID_MESSAGE,
  SESSION_INVALID_CODE,
  assertEmployeeSessionActive
};
