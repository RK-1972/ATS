const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { describe, it, beforeEach } = require("node:test");

const {
  EMPLOYEE_IDLE_TIMEOUT_MS,
  EMPLOYEE_IDLE_WARNING_LEAD_MS,
  JWT_TTL_MS,
  SESSION_STATUS,
  touchSession,
  recordUserActivity,
  recordUserActivityThrottled,
  terminateIdleSessionIfDue,
  completeIdleTimeoutTermination,
  computeEmployeeIdleDeadlines,
  markInterruptedSessions,
  confirmLogout,
  resetSessionMaintenanceThrottleForTests
} = require("../services/applicationSessionService");
const {
  assertEmployeeActivityWriteAllowed,
  resetEmployeeActivityThrottleForTests,
  EMPLOYEE_ACTIVITY_MIN_INTERVAL_MS
} = require("../utils/employeeSessionActivityThrottle");
const { assertEmployeeSessionActive } = require("../middleware/employeeSessionAuth");

describe("employee idle logout", () => {
  beforeEach(() => {
    resetSessionMaintenanceThrottleForTests();
    resetEmployeeActivityThrottleForTests();
  });

  it("computes warning at 13 minutes and idle expiry at 15 minutes from last activity", () => {
    const loginAt = "2026-06-01T10:00:00.000Z";
    const activityAt = "2026-06-01T10:00:00.000Z";
    const now = new Date("2026-06-01T10:12:00.000Z");

    const deadlines = computeEmployeeIdleDeadlines(
      { login_at: loginAt, last_user_activity_at: activityAt },
      { now }
    );

    assert.equal(deadlines.warning_at, "2026-06-01T10:13:00.000Z");
    assert.equal(deadlines.idle_expires_at, "2026-06-01T10:15:00.000Z");
    assert.equal(deadlines.is_idle_expired, false);
    assert.equal(
      deadlines.absolute_expires_at,
      new Date(new Date(loginAt).getTime() + JWT_TTL_MS).toISOString()
    );
  });

  it("does not extend absolute expiry when user activity is recorded late", () => {
    const loginAt = "2026-06-01T02:00:00.000Z";
    const activityAt = "2026-06-01T09:50:00.000Z";
    const now = new Date("2026-06-01T09:55:00.000Z");

    const deadlines = computeEmployeeIdleDeadlines(
      { login_at: loginAt, last_user_activity_at: activityAt },
      { now }
    );

    const absolute = new Date(deadlines.absolute_expires_at).getTime();
    const effective = new Date(deadlines.effective_expires_at).getTime();
    assert.equal(effective, Math.min(new Date(deadlines.idle_expires_at).getTime(), absolute));
    assert.equal(absolute, new Date(loginAt).getTime() + JWT_TTL_MS);
  });

  it("touchSession updates last_seen_at but not last_user_activity_at", async () => {
    let capturedSql = "";
    const pool = {
      query: async (sql) => {
        capturedSql = String(sql);
        return { rowCount: 1 };
      }
    };

    await touchSession(pool, "11111111-1111-4111-8111-111111111111");
    assert.match(capturedSql, /last_seen_at = NOW\(\)/);
    assert.doesNotMatch(capturedSql, /last_user_activity_at/i);
  });

  it("recordUserActivity updates last_user_activity_at for ACTIVE sessions", async () => {
    const now = new Date("2026-06-01T10:05:00.000Z");
    const calls = [];

    const pool = {
      query: async (sql, params) => {
        const text = String(sql);
        calls.push({ sql: text, params });
        if (text.includes("IDLE_TIMEOUT") && text.includes("UPDATE")) {
          return { rowCount: 0 };
        }
        if (text.includes("SELECT login_at, status")) {
          return {
            rows: [{ login_at: "2026-06-01T10:00:00.000Z", status: SESSION_STATUS.ACTIVE }]
          };
        }
        if (text.includes("SET last_user_activity_at")) {
          return { rowCount: 1 };
        }
        return { rowCount: 0, rows: [] };
      }
    };

    const result = await recordUserActivity(
      pool,
      "11111111-1111-4111-8111-111111111111",
      { now }
    );

    assert.equal(result.updated, true);
    const updateCall = calls.find((entry) => entry.sql.includes("SET last_user_activity_at"));
    assert.ok(updateCall);
    assert.equal(updateCall.params[1], now.toISOString());
  });

  it("recordUserActivity refuses to revive an idle-terminated session", async () => {
    const now = new Date("2026-06-01T10:20:00.000Z");
    const pool = {
      query: async (sql) => {
        const text = String(sql);
        if (text.includes("IDLE_TIMEOUT") && text.includes("UPDATE")) {
          return { rowCount: 1 };
        }
        return { rowCount: 0, rows: [] };
      }
    };

    const result = await recordUserActivity(
      pool,
      "11111111-1111-4111-8111-111111111111",
      { now }
    );
    assert.equal(result.updated, false);
  });

  it("terminateIdleSessionIfDue marks INTERRUPTED with IDLE_TIMEOUT", async () => {
    let capturedParams = [];
    const pool = {
      query: async (_sql, params) => {
        capturedParams = params;
        return { rowCount: 1 };
      }
    };

    const now = new Date("2026-06-01T10:20:00.000Z");
    const result = await terminateIdleSessionIfDue(
      pool,
      "11111111-1111-4111-8111-111111111111",
      { now }
    );

    assert.equal(result.terminated, true);
    assert.equal(capturedParams[1], SESSION_STATUS.INTERRUPTED);
    assert.equal(capturedParams[2], "IDLE_TIMEOUT");
  });

  it("markInterruptedSessions uses last_user_activity_at and 15-minute default", async () => {
    let capturedSql = "";
    let capturedParams = [];

    const pool = {
      query: async (sql, params) => {
        capturedSql = String(sql);
        capturedParams = params;
        return { rowCount: 1 };
      }
    };

    await markInterruptedSessions(pool, { now: new Date("2026-06-01T12:00:00.000Z") });
    assert.match(capturedSql, /last_user_activity_at/i);
    assert.equal(capturedParams[2], "IDLE_TIMEOUT");

    const cutoff = new Date(capturedParams[0]);
    const expectedCutoff = new Date("2026-06-01T12:00:00.000Z").getTime()
      - EMPLOYEE_IDLE_TIMEOUT_MS;
    assert.equal(cutoff.getTime(), expectedCutoff);
  });

  it("assertEmployeeSessionActive fails when session is no longer ACTIVE", async () => {
    const pool = {
      query: async (sql) => {
        const text = String(sql);
        if (text.includes("SELECT status") && text.includes("app_user_session")) {
          return { rows: [{ status: SESSION_STATUS.INTERRUPTED }] };
        }
        return { rowCount: 0, rows: [] };
      }
    };

    const result = await assertEmployeeSessionActive(pool, {
      session_id: "11111111-1111-4111-8111-111111111111"
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "SESSION_INVALID");
  });

  it("exposes 13-minute warning lead constant", () => {
    assert.equal(EMPLOYEE_IDLE_WARNING_LEAD_MS, 2 * 60 * 1000);
    assert.equal(EMPLOYEE_IDLE_TIMEOUT_MS - EMPLOYEE_IDLE_WARNING_LEAD_MS, 13 * 60 * 1000);
  });

  it("completeIdleTimeoutTermination is idempotent for IDLE_TIMEOUT sessions", async () => {
    const sessionId = "11111111-1111-4111-8111-111111111111";
    let status = SESSION_STATUS.INTERRUPTED;
    const pool = {
      query: async (sql) => {
        const text = String(sql);
        if (text.includes("IDLE_TIMEOUT") && text.includes("UPDATE")) {
          return { rowCount: 0 };
        }
        if (text.includes("SELECT status, termination_reason")) {
          return {
            rows: [{ status, termination_reason: "IDLE_TIMEOUT" }]
          };
        }
        return { rowCount: 0, rows: [] };
      }
    };

    const outcome = await completeIdleTimeoutTermination(pool, sessionId);
    assert.equal(outcome.ok, true);
    assert.equal(outcome.alreadyTerminated, true);
  });

  it("completeIdleTimeoutTermination rejects ACTIVE sessions that are not yet idle", async () => {
    const pool = {
      query: async (sql) => {
        const text = String(sql);
        if (text.includes("IDLE_TIMEOUT") && text.includes("UPDATE")) {
          return { rowCount: 0 };
        }
        if (text.includes("SELECT status, termination_reason")) {
          return {
            rows: [{ status: SESSION_STATUS.ACTIVE, termination_reason: null }]
          };
        }
        return { rowCount: 0, rows: [] };
      }
    };

    const outcome = await completeIdleTimeoutTermination(
      pool,
      "11111111-1111-4111-8111-111111111111"
    );
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, "NOT_DUE");
  });

  it("confirmLogout records USER_LOGOUT for explicit logout", async () => {
    let capturedParams = [];
    const pool = {
      query: async (_sql, params) => {
        capturedParams = params;
        return { rowCount: 1 };
      }
    };

    await confirmLogout(pool, "11111111-1111-4111-8111-111111111111", {
      reason: "USER_LOGOUT"
    });
    assert.equal(capturedParams[2], "USER_LOGOUT");
    assert.equal(capturedParams[1], SESSION_STATUS.LOGGED_OUT);
  });

  it("throttles rapid activity writes but allows spaced writes", () => {
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const t0 = 1_700_000_000_000;
    assert.equal(
      assertEmployeeActivityWriteAllowed(sessionId, { nowMs: t0 }).allowed,
      true
    );
    assert.equal(
      assertEmployeeActivityWriteAllowed(sessionId, {
        nowMs: t0 + EMPLOYEE_ACTIVITY_MIN_INTERVAL_MS - 1
      }).allowed,
      false
    );
    assert.equal(
      assertEmployeeActivityWriteAllowed(sessionId, {
        nowMs: t0 + EMPLOYEE_ACTIVITY_MIN_INTERVAL_MS
      }).allowed,
      true
    );
  });

  it("recordUserActivityThrottled returns throttled without DB write", async () => {
    const sessionId = "11111111-1111-4111-8111-111111111111";
    assertEmployeeActivityWriteAllowed(sessionId, { nowMs: 1000 });

    const pool = {
      query: async () => {
        throw new Error("Should not query when throttled");
      }
    };

    const result = await recordUserActivityThrottled(pool, sessionId, {
      now: new Date(1500)
    });
    assert.equal(result.throttled, true);
    assert.equal(result.updated, false);
  });

  it("migration 067 backfills genuine activity from login_at only", () => {
    const sql = fs.readFileSync(
      path.join(__dirname, "..", "migrations", "067_employee_idle_user_activity.sql"),
      "utf8"
    );
    assert.match(sql, /SET last_user_activity_at = login_at/);
    assert.doesNotMatch(sql, /SET last_user_activity_at = COALESCE\(last_seen_at/);
  });
});
