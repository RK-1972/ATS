const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const { SESSION_STATUS } = require("../services/applicationSessionService");
const {
  TAKEOVER_STATUS,
  hashPollToken,
  resolveLoginAfterPasswordVerified,
  decideTakeover,
  pollTakeoverStatus,
  completeTakeoverLogin,
  cancelPendingForSession
} = require("../services/sessionTakeoverService");
const { assertEmployeeSessionActive } = require("../middleware/employeeSessionAuth");

function createMockPool(handlers = []) {
  const calls = [];
  const query = async (sql, params) => {
    calls.push({ sql: String(sql), params });
    for (const handler of handlers) {
      const result = handler(sql, params, calls);
      if (result !== undefined) {
        return result;
      }
    }
    return { rows: [], rowCount: 0 };
  };
  const connect = async () => {
    const client = {
      query: async (sql, params) => query(sql, params),
      release: () => {}
    };
    return client;
  };
  return { query, connect, calls };
}

describe("session takeover service", () => {
  it("hashes poll tokens deterministically without storing raw secrets", () => {
    const a = hashPollToken("secret-token");
    const b = hashPollToken("secret-token");
    assert.equal(a, b);
    assert.equal(a.length, 64);
    assert.notEqual(a, "secret-token");
  });

  it("issues session when no active session exists", async () => {
    const pool = createMockPool([
      (sql) => {
        if (sql.includes("FROM app_user_session") && sql.includes("ACTIVE")) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("INSERT INTO app_user_session")) {
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes("getEmployeeWorkAssignments") || sql.includes("work_assignment")) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("resolveWorkspace") || sql.includes("workspace")) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("hiring_manager")) {
          return { rows: [], rowCount: 0 };
        }
      }
    ]);

    process.env.JWT_SECRET = "test-secret-for-session-takeover";

    const user = {
      user_id: 1,
      employee_code: "EMP-1",
      email_id: "user@example.com",
      role_name: "Recruiter",
      secondary_role: null,
      full_name: "Test User"
    };

    const result = await resolveLoginAfterPasswordVerified(pool, user, {
      headers: { "user-agent": "jest" },
      ip: "127.0.0.1"
    });

    assert.equal(result.outcome, "SESSION_ISSUED");
    assert.ok(result.body?.token);
    assert.ok(result.body?.user);
  });

  it("blocks direct login when an APPROVED completion is pending", async () => {
    const pool = createMockPool([
      (sql, params) => {
        const text = String(sql);
        if (text.includes("expires_at <=")) {
          return { rows: [], rowCount: 0 };
        }
        if (text.includes("UPDATE app_session_takeover_request r")) {
          return { rows: [], rowCount: 0 };
        }
        if (
          text.includes("FROM app_session_takeover_request")
          && text.includes("employee_code = $1")
          && params?.[1] === "APPROVED"
        ) {
          return {
            rows: [{ request_id: "99999999-9999-4999-8999-999999999999" }],
            rowCount: 1
          };
        }
      }
    ]);

    const user = { employee_code: "EMP-1", user_id: 1, email_id: "a@b.com", role_name: "Admin" };
    const result = await resolveLoginAfterPasswordVerified(pool, user, {
      headers: {},
      ip: "127.0.0.1"
    });
    assert.equal(result.outcome, "TAKEOVER_COMPLETE_REQUIRED");
  });

  it("creates pending takeover when an ACTIVE session exists", async () => {
    const incumbentSessionId = "22222222-2222-4222-8222-222222222222";
    const pool = createMockPool([
      (sql) => {
        const text = String(sql);
        if (
          text.includes("FROM app_user_session")
          && text.includes("ORDER BY login_at DESC")
        ) {
          return {
            rows: [
              {
                session_id: incumbentSessionId,
                employee_code: "EMP-1",
                status: SESSION_STATUS.ACTIVE
              }
            ],
            rowCount: 1
          };
        }
        if (text.includes("expires_at <=")) {
          return { rows: [], rowCount: 0 };
        }
        if (text.includes("UPDATE app_user_session")) {
          return { rows: [], rowCount: 0 };
        }
        if (text.includes("INSERT INTO app_session_takeover_request")) {
          return { rows: [], rowCount: 1 };
        }
        if (text.includes("INSERT INTO app_session_takeover_event")) {
          return { rows: [], rowCount: 1 };
        }
        if (text.includes("UPDATE app_session_takeover_request")) {
          return { rows: [], rowCount: 0 };
        }
        if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") {
          return { rows: [], rowCount: 0 };
        }
      }
    ]);

    const user = {
      user_id: 1,
      employee_code: "EMP-1",
      email_id: "user@example.com",
      role_name: "Recruiter"
    };

    const result = await resolveLoginAfterPasswordVerified(pool, user, {
      headers: { "user-agent": "jest" },
      ip: "127.0.0.1"
    });

    assert.equal(result.outcome, "TAKEOVER_PENDING");
    assert.ok(result.pollToken);
    assert.ok(result.expiresAt);
  });

  it("rejects decisions from a session that is not the incumbent", async () => {
    const requestId = "33333333-3333-4333-8333-333333333333";
    const pool = createMockPool([
      (sql) => {
        if (sql.includes("FOR UPDATE") && sql.includes("app_session_takeover_request")) {
          return {
            rows: [
              {
                request_id: requestId,
                employee_code: "EMP-1",
                incumbent_session_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                status: TAKEOVER_STATUS.PENDING,
                expires_at: new Date(Date.now() + 60000).toISOString()
              }
            ],
            rowCount: 1
          };
        }
      }
    ]);

    await assert.rejects(
      () =>
        decideTakeover(pool, requestId, "accept", {
          user: { session_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }
        }),
      (error) => error.status === 403
    );
  });

  it("reports denied status to poll consumer without issuing JWT", async () => {
    const pollToken = "poll-token-denied";
    const pool = createMockPool([
      (sql, params) => {
        if (sql.includes("FROM app_session_takeover_request") && sql.includes("poll_token_hash")) {
          return {
            rows: [
              {
                request_id: "44444444-4444-4444-8444-444444444444",
                status: TAKEOVER_STATUS.DENIED,
                employee_code: "EMP-1",
                incumbent_session_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
              }
            ],
            rowCount: 1
          };
        }
        if (sql.includes("expires_at <=")) {
          return { rows: [], rowCount: 0 };
        }
      }
    ]);

    const status = await pollTakeoverStatus(pool, pollToken);
    assert.equal(status.status, TAKEOVER_STATUS.DENIED);
    assert.equal(status.can_complete, false);
  });

  it("cancels pending requests when incumbent session ends", async () => {
    const pool = createMockPool([
      (sql) => {
        if (sql.includes("FOR UPDATE") && sql.includes("incumbent_session_id")) {
          return {
            rows: [
              {
                request_id: "55555555-5555-4555-8555-555555555555",
                employee_code: "EMP-1"
              }
            ],
            rowCount: 1
          };
        }
        if (sql.includes("UPDATE app_session_takeover_request")) {
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes("INSERT INTO app_session_takeover_event")) {
          return { rows: [], rowCount: 1 };
        }
      }
    ]);

    const result = await cancelPendingForSession(pool, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", {
      reason: "SESSION_ENDED"
    });
    assert.equal(result.updated, 1);
  });
});

describe("employee session auth middleware", () => {
  it("fails closed when session_id is missing on JWT", async () => {
    const pool = createMockPool([]);
    const result = await assertEmployeeSessionActive(pool, {
      employee_code: "EMP-1",
      user_id: 1
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "SESSION_INVALID");
  });

  it("fails closed when session row is not ACTIVE", async () => {
    const pool = createMockPool([
      (sql) => {
        if (sql.includes("FROM app_user_session") && sql.includes("session_id")) {
          return { rows: [{ status: SESSION_STATUS.REVOKED }], rowCount: 1 };
        }
      }
    ]);

    const result = await assertEmployeeSessionActive(pool, {
      session_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      employee_code: "EMP-1"
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
  });

  it("allows ACTIVE session rows", async () => {
    const pool = createMockPool([
      (sql) => {
        if (sql.includes("FROM app_user_session") && sql.includes("session_id")) {
          return { rows: [{ status: SESSION_STATUS.ACTIVE }], rowCount: 1 };
        }
      }
    ]);

    const result = await assertEmployeeSessionActive(pool, {
      session_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      employee_code: "EMP-1"
    });
    assert.equal(result.ok, true);
  });
});
