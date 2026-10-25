const EMPLOYEE_ACTIVITY_MIN_INTERVAL_MS = 5000;

const lastWriteMsBySession = new Map();

function resetEmployeeActivityThrottleForTests() {
  lastWriteMsBySession.clear();
}

/**
 * Limits genuine-activity DB writes per session (in-memory, per process).
 */
function assertEmployeeActivityWriteAllowed(sessionId, { nowMs = Date.now() } = {}) {
  const id = String(sessionId || "").trim();
  if (!id) {
    return { allowed: false, reason: "missing_session" };
  }

  const lastMs = lastWriteMsBySession.get(id) || 0;
  if (nowMs - lastMs < EMPLOYEE_ACTIVITY_MIN_INTERVAL_MS) {
    return { allowed: false, reason: "throttled" };
  }

  lastWriteMsBySession.set(id, nowMs);
  return { allowed: true };
}

module.exports = {
  EMPLOYEE_ACTIVITY_MIN_INTERVAL_MS,
  assertEmployeeActivityWriteAllowed,
  resetEmployeeActivityThrottleForTests
};
