/**
 * Session takeover — PostgreSQL integration.
 *
 * Target DB (session-takeover suite only):
 *   SESSION_TAKEOVER_TEST_DATABASE_URL=postgresql://...@127.0.0.1:5432/ats_dev
 * or OPTALYNX_SESSION_TAKEOVER_ALLOW_ATS_DEV=1 with DB_* → local ats_dev.
 *
 * Uses fixture employee STO-INT-V1 only; does not delete other users' sessions.
 */
const assert = require("node:assert/strict");
const { describe, it, before, after } = require("node:test");
const jwt = require("jsonwebtoken");

const { isIntegrationPgRequired } = require("./lib/migrationIntegrationGuards");
const {
  TAKEOVER_STATUS,
  resolveLoginAfterPasswordVerified,
  decideTakeover,
  pollTakeoverStatus,
  completeTakeoverLogin
} = require("../services/sessionTakeoverService");
const { assertEmployeeSessionActive } = require("../middleware/employeeSessionAuth");
const { SESSION_STATUS } = require("../services/applicationSessionService");
const {
  isSessionTakeoverIntegrationConfigured,
  probeSessionTakeoverPostgres,
  createSessionTakeoverPool,
  assertSessionSchemaReady,
  assertTakeoverSchemaReady,
  applyMigration066IfMissing,
  provisionFixtureUser,
  insertActiveSession,
  cleanupFixtureArtifacts,
  mockReq,
  integrationReq,
  crypto,
  FIXTURE_EMPLOYEE_CODE
} = require("./lib/sessionTakeoverIntegrationFixtures");

describe("session takeover (PostgreSQL integration)", { concurrency: 1 }, () => {
  let pool;
  let enabled = false;
  let skipReason = null;
  let databaseLabel = null;
  let fixtureUser;

  before(async () => {
    if (!isSessionTakeoverIntegrationConfigured()) {
      skipReason =
        "SESSION_TAKEOVER_TEST_DATABASE_URL or OPTALYNX_SESSION_TAKEOVER_ALLOW_ATS_DEV=1 with local ats_dev is required";
      if (isIntegrationPgRequired()) {
        throw new Error(skipReason);
      }
      return;
    }

    const probe = await probeSessionTakeoverPostgres();
    if (!probe.available) {
      skipReason = probe.error?.message || "PostgreSQL probe failed";
      if (isIntegrationPgRequired()) {
        throw new Error(skipReason);
      }
      return;
    }

    databaseLabel = `${probe.config.database}@${probe.config.host}`;
    pool = createSessionTakeoverPool();
    const baseSchema = await assertSessionSchemaReady(pool);
    if (!baseSchema.ok) {
      skipReason = baseSchema.reason;
      await pool.end().catch(() => {});
      pool = null;
      return;
    }

    await applyMigration066IfMissing(pool);
    const takeoverSchema = await assertTakeoverSchemaReady(pool);
    if (!takeoverSchema.ok) {
      skipReason = takeoverSchema.reason;
      await pool.end().catch(() => {});
      pool = null;
      return;
    }

    fixtureUser = await provisionFixtureUser(pool);
    enabled = true;
  });

  after(async () => {
    if (pool && fixtureUser) {
      await cleanupFixtureArtifacts(pool, fixtureUser.employee_code);
      await pool.end().catch(() => {});
    }
  });

  function skipIfDisabled(t) {
    if (!enabled) {
      t.skip(skipReason || "Integration prerequisites not satisfied");
      return true;
    }
    return false;
  }

  it("reports integration database identity when enabled", async (t) => {
    if (skipIfDisabled(t)) {
      return;
    }
    assert.equal(fixtureUser.employee_code, FIXTURE_EMPLOYEE_CODE);
    assert.ok(databaseLabel);
  });

  it("creates pending takeover without issuing JWT session", async (t) => {
    if (skipIfDisabled(t)) {
      return;
    }

    const incumbentSessionId = crypto.randomUUID();
    await cleanupFixtureArtifacts(pool, fixtureUser.employee_code);
    await insertActiveSession(pool, {
      sessionId: incumbentSessionId,
      user: fixtureUser
    });

    const resolution = await resolveLoginAfterPasswordVerified(
      pool,
      fixtureUser,
      integrationReq()
    );

    assert.equal(resolution.outcome, "TAKEOVER_PENDING");
    assert.ok(resolution.pollToken);

    const sessions = await pool.query(
      `SELECT status FROM app_user_session WHERE employee_code = $1 AND status = $2`,
      [fixtureUser.employee_code, SESSION_STATUS.ACTIVE]
    );
    assert.equal(sessions.rowCount, 1);
  });

  it("approval revokes incumbent and complete issues new ACTIVE session", async (t) => {
    if (skipIfDisabled(t)) {
      return;
    }

    process.env.JWT_SECRET = process.env.JWT_SECRET || "integration-test-secret";

    const incumbentSessionId = crypto.randomUUID();
    await cleanupFixtureArtifacts(pool, fixtureUser.employee_code);
    await insertActiveSession(pool, {
      sessionId: incumbentSessionId,
      user: fixtureUser
    });

    const resolution = await resolveLoginAfterPasswordVerified(
      pool,
      fixtureUser,
      integrationReq()
    );
    assert.equal(resolution.outcome, "TAKEOVER_PENDING");

    const pending = await pool.query(
      `SELECT request_id FROM app_session_takeover_request
       WHERE employee_code = $1 AND status = $2`,
      [fixtureUser.employee_code, TAKEOVER_STATUS.PENDING]
    );
    const requestId = pending.rows[0].request_id;

    const decision = await decideTakeover(
      pool,
      requestId,
      "accept",
      mockReq(fixtureUser, incumbentSessionId)
    );
    assert.equal(decision.status, TAKEOVER_STATUS.APPROVED);

    const revoked = await pool.query(
      `SELECT status FROM app_user_session WHERE session_id = $1::uuid`,
      [incumbentSessionId]
    );
    assert.equal(revoked.rows[0].status, SESSION_STATUS.REVOKED);

    const poll = await pollTakeoverStatus(pool, resolution.pollToken);
    assert.equal(poll.status, TAKEOVER_STATUS.APPROVED);
    assert.equal(poll.can_complete, true);

    const completed = await completeTakeoverLogin(
      pool,
      resolution.pollToken,
      fixtureUser,
      integrationReq({ "user-agent": "session-takeover-int:complete" })
    );
    assert.ok(completed.body?.token);

    const oldJwt = jwt.sign(
      {
        user_id: fixtureUser.user_id,
        employee_code: fixtureUser.employee_code,
        email_id: fixtureUser.email_id,
        role_name: fixtureUser.role_name,
        session_id: incumbentSessionId
      },
      process.env.JWT_SECRET,
      { expiresIn: "1h" }
    );
    const verifiedOld = jwt.verify(oldJwt, process.env.JWT_SECRET);
    const oldSessionCheck = await assertEmployeeSessionActive(pool, verifiedOld);
    assert.equal(oldSessionCheck.ok, false);

    const payload = jwt.verify(completed.body.token, process.env.JWT_SECRET);
    const newSessionCheck = await assertEmployeeSessionActive(pool, payload);
    assert.equal(newSessionCheck.ok, true);
  });

  it("blocks fresh login while APPROVED completion is pending", async (t) => {
    if (skipIfDisabled(t)) {
      return;
    }

    const incumbentSessionId = crypto.randomUUID();
    await cleanupFixtureArtifacts(pool, fixtureUser.employee_code);
    await insertActiveSession(pool, { sessionId: incumbentSessionId, user: fixtureUser });

    await resolveLoginAfterPasswordVerified(pool, fixtureUser, integrationReq());
    const pending = await pool.query(
      `SELECT request_id FROM app_session_takeover_request
       WHERE employee_code = $1 AND status = $2`,
      [fixtureUser.employee_code, TAKEOVER_STATUS.PENDING]
    );

    await decideTakeover(
      pool,
      pending.rows[0].request_id,
      "accept",
      mockReq(fixtureUser, incumbentSessionId)
    );

    const second = await resolveLoginAfterPasswordVerified(
      pool,
      fixtureUser,
      integrationReq({ "user-agent": "session-takeover-int:bypass" })
    );
    assert.equal(second.outcome, "TAKEOVER_COMPLETE_REQUIRED");
  });

  it("denial keeps incumbent session ACTIVE", async (t) => {
    if (skipIfDisabled(t)) {
      return;
    }

    const incumbentSessionId = crypto.randomUUID();
    await cleanupFixtureArtifacts(pool, fixtureUser.employee_code);
    await insertActiveSession(pool, { sessionId: incumbentSessionId, user: fixtureUser });

    const resolution = await resolveLoginAfterPasswordVerified(
      pool,
      fixtureUser,
      integrationReq()
    );
    const pending = await pool.query(
      `SELECT request_id FROM app_session_takeover_request
       WHERE employee_code = $1 AND status = $2`,
      [fixtureUser.employee_code, TAKEOVER_STATUS.PENDING]
    );

    await decideTakeover(
      pool,
      pending.rows[0].request_id,
      "deny",
      mockReq(fixtureUser, incumbentSessionId)
    );

    const incumbent = await pool.query(
      `SELECT status FROM app_user_session WHERE session_id = $1::uuid`,
      [incumbentSessionId]
    );
    assert.equal(incumbent.rows[0].status, SESSION_STATUS.ACTIVE);

    const poll = await pollTakeoverStatus(pool, resolution.pollToken);
    assert.equal(poll.status, TAKEOVER_STATUS.DENIED);
  });
});
