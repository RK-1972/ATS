const assert = require("node:assert/strict");
const { describe, it, beforeEach, afterEach } = require("node:test");

const {
  resolveClientIp,
  parseForwardedFor,
  isTrustProxyEnabled
} = require("../utils/clientIpResolver");
const {
  computeDurationSeconds,
  confirmLogout,
  mapSessionRow,
  recordLogin,
  revokeActiveSessionsForEmployee,
  onEmployeeAccountDeactivated,
  expireStaleActiveSessions,
  refreshStaleSessionStates,
  refreshStaleSessionStatesThrottled,
  refreshStaleSessionStatesForHeartbeat,
  resetSessionMaintenanceThrottleForTests,
  reconcileSupersededActiveSessions,
  SESSION_STATUS
} = require("../services/applicationSessionService");
const applicationAuditReadService = require("../services/applicationAuditReadService");
const {
  validateEvent,
  sanitizeScreenKey
} = require("../services/applicationScreenActivityService");
const {
  assertCanAccessApplicationAuditWorkspace
} = require("../services/applicationAuditCapabilityAuth");

describe("clientIpResolver", () => {
  const originalTrust = process.env.TRUST_PROXY;

  afterEach(() => {
    process.env.TRUST_PROXY = originalTrust;
  });

  it("uses first X-Forwarded-For hop when trust proxy is enabled", () => {
    process.env.TRUST_PROXY = "true";
    const ip = resolveClientIp({
      headers: { "x-forwarded-for": "203.0.113.10, 10.0.0.1" },
      ip: "127.0.0.1"
    });
    assert.equal(ip, "203.0.113.10");
  });

  it("ignores forwarded headers when trust proxy is disabled", () => {
    process.env.TRUST_PROXY = "false";
    const ip = resolveClientIp({
      headers: { "x-forwarded-for": "203.0.113.10" },
      ip: "127.0.0.1"
    });
    assert.equal(ip, "127.0.0.1");
  });

  it("parses forwarded-for chain", () => {
    assert.equal(parseForwardedFor("a, b, c"), "a");
  });

  it("normalizes IPv6 loopback to IPv4 loopback for audit readability", () => {
    const { normalizeIp } = require("../utils/clientIpResolver");
    assert.equal(normalizeIp("::1"), "127.0.0.1");
    assert.equal(resolveClientIp({ ip: "::1" }), "127.0.0.1");
  });
});

describe("applicationSessionService", () => {
  beforeEach(() => {
    resetSessionMaintenanceThrottleForTests();
  });

  it("computes duration for confirmed logout", () => {
    const duration = computeDurationSeconds({
      login_at: "2026-01-01T10:00:00.000Z",
      logout_at: "2026-01-01T11:30:00.000Z",
      status: SESSION_STATUS.LOGGED_OUT
    });
    assert.equal(duration, 5400);
  });

  it("computes elapsed duration for ACTIVE sessions from last_seen_at", () => {
    const duration = computeDurationSeconds({
      login_at: "2026-01-01T10:00:00.000Z",
      logout_at: null,
      last_seen_at: "2026-01-01T10:05:30.000Z",
      status: SESSION_STATUS.ACTIVE
    });
    assert.equal(duration, 330);
  });

  it("maps joined full_name onto session list rows", () => {
    const mapped = mapSessionRow({
      session_id: "11111111-1111-4111-8111-111111111111",
      employee_code: "EMP-1",
      full_name: "Nishchith Hegde",
      user_id: 1,
      email_id: "user@example.com",
      login_at: "2026-01-01T10:00:00.000Z",
      logout_at: "2026-01-01T11:00:00.000Z",
      last_seen_at: "2026-01-01T11:00:00.000Z",
      source_ip: "::1",
      status: SESSION_STATUS.LOGGED_OUT,
      termination_reason: "USER_LOGOUT"
    });

    assert.equal(mapped.full_name, "Nishchith Hegde");
    assert.equal(mapped.source_ip, "127.0.0.1");
    assert.equal(mapped.duration_seconds, 3600);
  });

  it("does not invent duration for expired sessions without logout_at", () => {
    const duration = computeDurationSeconds({
      login_at: "2026-01-01T10:00:00.000Z",
      logout_at: null,
      last_seen_at: "2026-01-01T10:15:00.000Z",
      status: SESSION_STATUS.EXPIRED
    });
    assert.equal(duration, 900);
  });

  it("records independent sessions per login", async () => {
    const inserts = [];
    const pool = {
      query: async (sql, params) => {
        if (String(sql).includes("INSERT INTO app_user_session")) {
          inserts.push(params);
        }
        return { rows: [], rowCount: 0 };
      }
    };

    await recordLogin(pool, {
      sessionId: "11111111-1111-4111-8111-111111111111",
      user: { employee_code: "EMP-1", user_id: 1, email_id: "a@example.com" },
      req: { ip: "10.1.1.5", headers: {} }
    });
    await recordLogin(pool, {
      sessionId: "22222222-2222-4222-8222-222222222222",
      user: { employee_code: "EMP-1", user_id: 1, email_id: "a@example.com" },
      req: { ip: "10.1.1.9", headers: {} }
    });

    assert.equal(inserts.length, 2);
    assert.notEqual(inserts[0][0], inserts[1][0]);
  });

  it("marks explicit logout without setting logout on unrelated sessions", async () => {
    const pool = {
      query: async (sql, params) => ({
        rowCount: sql.includes("UPDATE") ? 1 : 0,
        rows: []
      })
    };

    const result = await confirmLogout(pool, "11111111-1111-4111-8111-111111111111");
    assert.equal(result.updated, true);
  });

  it("treats repeated logout as a no-op when session is no longer ACTIVE", async () => {
    const pool = {
      query: async () => ({ rowCount: 0, rows: [] })
    };

    const first = await confirmLogout(pool, "11111111-1111-4111-8111-111111111111");
    const second = await confirmLogout(pool, "11111111-1111-4111-8111-111111111111");
    assert.equal(first.updated, false);
    assert.equal(second.updated, false);
  });

  it("revokes only ACTIVE sessions and does not set logout_at", async () => {
    let capturedSql = "";
    let capturedParams = [];

    const pool = {
      query: async (sql, params) => {
        capturedSql = sql;
        capturedParams = params;
        return { rowCount: 2 };
      }
    };

    const result = await revokeActiveSessionsForEmployee(pool, "EMP-9", {
      reason: "ACCOUNT_DEACTIVATED"
    });

    assert.equal(result.updated, 2);
    assert.equal(capturedParams[1], SESSION_STATUS.REVOKED);
    assert.equal(capturedParams[3], SESSION_STATUS.ACTIVE);
    assert.doesNotMatch(capturedSql, /logout_at/i);
  });

  it("expireStaleActiveSessions marks EXPIRED without logout_at", async () => {
    let capturedSql = "";
    let capturedParams = [];

    const pool = {
      query: async (sql, params) => {
        capturedSql = sql;
        capturedParams = params;
        return { rowCount: 1 };
      }
    };

    await expireStaleActiveSessions(pool, { now: new Date("2026-06-01T12:00:00.000Z") });
    assert.match(capturedSql, /status = \$2/);
    assert.doesNotMatch(capturedSql, /logout_at/i);
    assert.equal(capturedParams[2], "JWT_EXPIRED");
    assert.equal(capturedParams[3], SESSION_STATUS.ACTIVE);
  });

  it("onEmployeeAccountDeactivated does not throw when session store is unavailable", async () => {
    const pool = {
      query: async () => {
        throw new Error("relation app_user_session does not exist");
      }
    };

    const result = await onEmployeeAccountDeactivated(pool, "EMP-1");
    assert.equal(result.updated, 0);
    assert.equal(result.failed, true);
  });

  it("refreshStaleSessionStates runs expiry, supersede, then interruption", async () => {
    const phases = [];

    const pool = {
      query: async (sql, params) => {
        const text = String(sql);
        if (text.includes("login_at < $1") && params[2] === "JWT_EXPIRED") {
          phases.push("expire");
        } else if (text.includes("newer.login_at > s.login_at")) {
          phases.push("supersede");
        } else if (params[2] === "IDLE_TIMEOUT") {
          phases.push("interrupt");
        }
        return { rowCount: 1 };
      }
    };

    const result = await refreshStaleSessionStates(pool, {
      now: new Date("2026-06-01T12:00:00.000Z")
    });

    assert.deepEqual(phases, ["expire", "supersede", "interrupt"]);
    assert.equal(result.expired, 1);
    assert.equal(result.superseded, 1);
    assert.equal(result.interrupted, 1);
  });

  it("reconcileSupersededActiveSessions does not set logout_at", async () => {
    let capturedSql = "";
    let capturedParams = [];

    const pool = {
      query: async (sql, params) => {
        capturedSql = String(sql);
        capturedParams = params;
        return { rowCount: 2 };
      }
    };

    const result = await reconcileSupersededActiveSessions(pool, {
      employeeCode: "EMP-1",
      keepSessionId: "11111111-1111-4111-8111-111111111111"
    });

    assert.equal(result.updated, 2);
    assert.doesNotMatch(capturedSql, /logout_at/i);
    assert.equal(capturedParams[1], "SUPERSEDED");
  });

  it("refreshStaleSessionStatesThrottled skips sweeps inside the throttle window", async () => {
    let queryCount = 0;
    const pool = {
      query: async () => {
        queryCount += 1;
        return { rowCount: 0 };
      }
    };

    const t0 = new Date("2026-06-01T12:00:00.000Z");
    const first = await refreshStaleSessionStatesThrottled(pool, {
      now: t0,
      throttleMs: 5 * 60 * 1000
    });
    const second = await refreshStaleSessionStatesThrottled(pool, {
      now: new Date(t0.getTime() + 60 * 1000),
      throttleMs: 5 * 60 * 1000
    });
    const third = await refreshStaleSessionStatesThrottled(pool, {
      now: new Date(t0.getTime() + 5 * 60 * 1000),
      throttleMs: 5 * 60 * 1000
    });

    assert.equal(first.skipped, false);
    assert.equal(second.skipped, true);
    assert.equal(second.reason, "throttled");
    assert.equal(third.skipped, false);
    assert.equal(queryCount, 6);
  });

  it("refreshStaleSessionStatesForHeartbeat swallows maintenance errors and allows retry", async () => {
    let attempts = 0;
    const pool = {
      query: async () => {
        attempts += 1;
        throw new Error("maintenance unavailable");
      }
    };

    const failed = await refreshStaleSessionStatesForHeartbeat(pool, {
      now: new Date("2026-06-01T12:00:00.000Z"),
      throttleMs: 1000
    });
    assert.equal(failed.failed, true);
    assert.equal(attempts, 1);

    const retried = await refreshStaleSessionStatesForHeartbeat(pool, {
      now: new Date("2026-06-01T12:00:01.000Z"),
      throttleMs: 1000
    });
    assert.equal(retried.failed, true);
    assert.equal(attempts, 2);
  });
});

describe("applicationAuditReadService smart search", () => {
  const { resolveSmartSearchTerm } = applicationAuditReadService;

  it("normalizes search term from supported query aliases", () => {
    assert.equal(resolveSmartSearchTerm({ search: "  OPT1007 " }), "OPT1007");
    assert.equal(resolveSmartSearchTerm({ employee_code: "IGS0592" }), "IGS0592");
    assert.equal(resolveSmartSearchTerm({}), null);
  });

  it("listSessions applies multi-field smart search server-side", async () => {
    resetSessionMaintenanceThrottleForTests();

    let listSql = "";

    const pool = {
      query: async (sql) => {
        const text = String(sql);
        if (text.includes("newer.login_at > s.login_at")) {
          return { rowCount: 0 };
        }
        if (text.includes("JWT_EXPIRED")) {
          return { rowCount: 0 };
        }
        if (text.includes("IDLE_TIMEOUT")) {
          return { rowCount: 0 };
        }
        if (text.includes("COUNT(*)")) {
          return { rows: [{ total_count: 1 }] };
        }
        if (text.includes("FROM app_user_session s") && text.includes("user_mstr")) {
          listSql = text;
        }
        return { rows: [] };
      }
    };

    await applicationAuditReadService.listSessions(pool, { search: "nishchith" });

    assert.match(listSql, /full_name/i);
    assert.match(listSql, /email_id/i);
    assert.match(listSql, /session_id::text/i);
  });
});

describe("applicationAuditReadService.listSessions", () => {
  beforeEach(() => {
    resetSessionMaintenanceThrottleForTests();
  });

  it("refreshes stale session states before listing sessions", async () => {
    const operations = [];

    const pool = {
      query: async (sql, params) => {
        const text = String(sql);
        if (params?.[2] === "JWT_EXPIRED") {
          operations.push("expire");
          return { rowCount: 0 };
        }
        if (text.includes("newer.login_at > s.login_at")) {
          operations.push("supersede");
          return { rowCount: 0 };
        }
        if (params?.[2] === "IDLE_TIMEOUT") {
          operations.push("interrupt");
          return { rowCount: 0 };
        }
        if (text.includes("COUNT(*)")) {
          operations.push("count");
          return { rows: [{ total_count: 0 }] };
        }
        if (text.includes("FROM app_user_session s") && text.includes("user_mstr")) {
          operations.push("list");
        }
        return { rows: [] };
      }
    };

    await applicationAuditReadService.listSessions(pool, {});

    assert.deepEqual(operations, ["expire", "supersede", "interrupt", "count", "list"]);
  });
});

describe("applicationScreenActivityService", () => {
  it("rejects screen keys with query strings", () => {
    assert.equal(sanitizeScreenKey("offers?x=1"), null);
  });

  it("accepts valid screen activity events", () => {
    const row = validateEvent(
      {
        screen_key: "offers.pending-approvals",
        route_template: "/offers/pending-approvals",
        entered_at: "2026-01-01T10:00:00.000Z",
        exited_at: "2026-01-01T10:05:00.000Z"
      },
      "EMP-1"
    );
    assert.equal(row.employee_code, "EMP-1");
    assert.equal(row.duration_seconds, 300);
  });
});

describe("applicationAuditCapabilityAuth", () => {
  it("denies without showApplicationAuditWorkspace assignment", async () => {
    const pool = {
      query: async () => ({ rows: [] })
    };

    await assert.rejects(
      () =>
        assertCanAccessApplicationAuditWorkspace(pool, {
          user: { employee_code: "EMP-X", role_name: "Recruiter" }
        }),
      (error) => error.status === 403
    );
  });

  it("allows active APPLICATION_AUDIT_OBSERVER assignment via workspace flag", async () => {
    const pool = {
      query: async (sql) => {
        if (String(sql).includes("employee_work_assignment ewa")) {
          return {
            rows: [
              {
                assignment_code: "APPLICATION_AUDIT_OBSERVER",
                is_active: true,
                master_is_active: true,
                workspace_flag: "showApplicationAuditWorkspace"
              }
            ]
          };
        }
        return { rows: [] };
      }
    };

    await assertCanAccessApplicationAuditWorkspace(pool, {
      user: { employee_code: "AUD-1", role_name: "Recruiter" }
    });
  });
});
