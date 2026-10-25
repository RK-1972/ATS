const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");

const {
  parsePostgresUrl,
  assertSafeHost,
  ALLOWED_DATABASE_PATTERN
} = require("./migrationIntegrationGuards");

const SESSION_TAKEOVER_TEST_DATABASE_URL_ENV = "SESSION_TAKEOVER_TEST_DATABASE_URL";
const ALLOW_ATS_DEV_ENV = "OPTALYNX_SESSION_TAKEOVER_ALLOW_ATS_DEV";
const ALLOW_ATS_DEV_VALUE = "1";

const FIXTURE_EMPLOYEE_CODE = "STO-INT-V1";
const FIXTURE_EMAIL = "session.takeover.int@optalynx.local";
const FIXTURE_FULL_NAME = "Session Takeover Integration";
const FIXTURE_PASSWORD = "SessionTakeoverInt1!";
const FIXTURE_UA_PREFIX = "session-takeover-int:";

const LOCAL_ATS_DEV_NAME = "ats_dev";

function isSessionTakeoverIntegrationConfigured() {
  return Boolean(resolveSessionTakeoverDatabaseUrl({ throwOnMissing: false }));
}

function resolveSessionTakeoverDatabaseUrl({ throwOnMissing = true } = {}) {
  const explicit = String(process.env[SESSION_TAKEOVER_TEST_DATABASE_URL_ENV] || "").trim();
  if (explicit) {
    return explicit;
  }

  if (String(process.env[ALLOW_ATS_DEV_ENV] || "").trim() !== ALLOW_ATS_DEV_VALUE) {
    if (throwOnMissing) {
      throw new Error(
        `${SESSION_TAKEOVER_TEST_DATABASE_URL_ENV} is not set. For local ats_dev, set ${ALLOW_ATS_DEV_ENV}=${ALLOW_ATS_DEV_VALUE} and DB_* in the environment (or set ${SESSION_TAKEOVER_TEST_DATABASE_URL_ENV} explicitly).`
      );
    }
    return null;
  }

  try {
    require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });
  } catch (_error) {
    // optional
  }

  const host = String(process.env.DB_HOST || "127.0.0.1").trim();
  const port = String(process.env.DB_PORT || "5432").trim();
  const user = String(process.env.DB_USER || "").trim();
  const password = String(process.env.DB_PASSWORD || "");
  const database = String(process.env.DB_NAME || "").trim();

  if (!user || !database) {
    if (throwOnMissing) {
      throw new Error(
        `${ALLOW_ATS_DEV_ENV} is set but DB_USER/DB_NAME are missing from the environment.`
      );
    }
    return null;
  }

  if (database.toLowerCase() !== LOCAL_ATS_DEV_NAME) {
    if (throwOnMissing) {
      throw new Error(
        `${ALLOW_ATS_DEV_ENV} only permits DB_NAME=${LOCAL_ATS_DEV_NAME}; got "${database}".`
      );
    }
    return null;
  }

  const encodedUser = encodeURIComponent(user);
  const encodedPassword = encodeURIComponent(password);
  return `postgresql://${encodedUser}:${encodedPassword}@${host}:${port}/${database}`;
}

/**
 * Session-takeover integration target only — does not change global migration guards.
 */
function assertSessionTakeoverIntegrationTarget(config) {
  assertSafeHost(config.host);
  const name = String(config.database || "").trim();
  const lower = name.toLowerCase();

  if (ALLOWED_DATABASE_PATTERN.test(name)) {
    return;
  }

  if (
    lower === LOCAL_ATS_DEV_NAME
    && String(process.env[ALLOW_ATS_DEV_ENV] || "").trim() === ALLOW_ATS_DEV_VALUE
  ) {
    return;
  }

  throw new Error(
    `Refusing session takeover integration on database "${name}". Use optalynx_mig_test* or local ats_dev with ${ALLOW_ATS_DEV_ENV}=${ALLOW_ATS_DEV_VALUE}.`
  );
}

async function tableExists(pool, tableName) {
  const result = await pool.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = $1
     ) AS exists`,
    [tableName]
  );
  return Boolean(result.rows[0]?.exists);
}

function createSessionTakeoverPool() {
  const connectionString = resolveSessionTakeoverDatabaseUrl();
  const config = parsePostgresUrl(connectionString);
  assertSessionTakeoverIntegrationTarget(config);
  return new Pool({ connectionString });
}

async function probeSessionTakeoverPostgres() {
  try {
    const connectionString = resolveSessionTakeoverDatabaseUrl();
    const config = parsePostgresUrl(connectionString);
    assertSessionTakeoverIntegrationTarget(config);
    const pool = new Pool({ connectionString });
    try {
      await pool.query("SELECT 1");
      return { available: true, config };
    } finally {
      await pool.end().catch(() => {});
    }
  } catch (error) {
    return { available: false, error };
  }
}

async function assertSessionSchemaReady(pool) {
  for (const table of ["app_user_session", "user_mstr"]) {
    if (!(await tableExists(pool, table))) {
      return {
        ok: false,
        reason: `Missing required table "${table}" for session takeover integration tests.`
      };
    }
  }
  return { ok: true };
}

async function assertTakeoverSchemaReady(pool) {
  if (!(await tableExists(pool, "app_session_takeover_request"))) {
    return {
      ok: false,
      reason:
        "app_session_takeover_request is missing. Apply migration 066 locally before running integration tests."
    };
  }
  if (!(await tableExists(pool, "app_session_takeover_event"))) {
    return {
      ok: false,
      reason: "app_session_takeover_event is missing (migration 066 incomplete)."
    };
  }
  return { ok: true };
}

async function applyMigration067IfMissing(pool) {
  const connectionString = String(pool?.options?.connectionString || "").trim();
  assertSessionTakeoverIntegrationTarget(parsePostgresUrl(connectionString));

  const column = await pool.query(
    `SELECT 1
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'app_user_session'
       AND column_name = 'last_user_activity_at'
     LIMIT 1`
  );

  if (column.rowCount) {
    return { applied: false };
  }

  const migrationPath = path.join(
    __dirname,
    "..",
    "..",
    "migrations",
    "067_employee_idle_user_activity.sql"
  );
  await pool.query(fs.readFileSync(migrationPath, "utf8"));
  return { applied: true };
}

async function applyMigration066IfMissing(pool) {
  const connectionString = String(pool?.options?.connectionString || "").trim();
  assertSessionTakeoverIntegrationTarget(parsePostgresUrl(connectionString));

  if (await tableExists(pool, "app_session_takeover_request")) {
    const schema = await assertTakeoverSchemaReady(pool);
    if (!schema.ok) {
      throw new Error(schema.reason);
    }
    return { applied: false };
  }

  const migrationPath = path.join(
    __dirname,
    "..",
    "..",
    "migrations",
    "066_session_takeover_approval.sql"
  );
  await pool.query(fs.readFileSync(migrationPath, "utf8"));

  const schema = await assertTakeoverSchemaReady(pool);
  if (!schema.ok) {
    throw new Error(schema.reason);
  }
  return { applied: true };
}

async function provisionFixtureUser(pool) {
  const existing = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name, full_name, password_hash, is_active
     FROM user_mstr
     WHERE employee_code = $1`,
    [FIXTURE_EMPLOYEE_CODE]
  );

  if (existing.rows.length) {
    const row = existing.rows[0];
    if (row.is_active !== true) {
      await pool.query(
        `UPDATE user_mstr SET is_active = TRUE WHERE employee_code = $1`,
        [FIXTURE_EMPLOYEE_CODE]
      );
      row.is_active = true;
    }
    return row;
  }

  const passwordHash = await bcrypt.hash(FIXTURE_PASSWORD, 10);
  const inserted = await pool.query(
    `INSERT INTO user_mstr (
       employee_code, full_name, email_id, password_hash, role_name, is_active
     ) VALUES ($1, $2, $3, $4, 'Recruiter', TRUE)
     RETURNING user_id, employee_code, email_id, role_name, full_name, password_hash, is_active`,
    [FIXTURE_EMPLOYEE_CODE, FIXTURE_FULL_NAME, FIXTURE_EMAIL, passwordHash]
  );
  return inserted.rows[0];
}

async function insertActiveSession(pool, { sessionId, user, label = "fixture" }) {
  await pool.query(
    `INSERT INTO app_user_session (
       session_id, employee_code, user_id, email_id,
       login_at, last_seen_at, last_user_activity_at,
       source_ip, status, user_agent_summary
     ) VALUES ($1,$2,$3,$4,NOW(),NOW(),NOW(),$5::inet,$6,$7)
     ON CONFLICT (session_id) DO UPDATE
       SET status = EXCLUDED.status,
           login_at = NOW(),
           last_seen_at = NOW(),
           last_user_activity_at = NOW(),
           user_agent_summary = EXCLUDED.user_agent_summary`,
    [
      sessionId,
      user.employee_code,
      user.user_id,
      user.email_id,
      "127.0.0.1",
      "ACTIVE",
      `${FIXTURE_UA_PREFIX}${label}`
    ]
  );
}

async function cleanupFixtureTakeoverRows(pool, employeeCode) {
  await pool.query(
    `DELETE FROM app_session_takeover_event
     WHERE employee_code = $1`,
    [employeeCode]
  );
  await pool.query(
    `DELETE FROM app_session_takeover_request
     WHERE employee_code = $1`,
    [employeeCode]
  );
}

/**
 * Removes only integration-tagged sessions for the fixture employee (never other users).
 */
async function cleanupFixtureSessions(pool, employeeCode) {
  await pool.query(
    `DELETE FROM app_user_session
     WHERE employee_code = $1
       AND (
         user_agent_summary LIKE $2
         OR user_agent_summary = 'integration'
         OR user_agent_summary LIKE 'integration-%'
       )`,
    [employeeCode, `${FIXTURE_UA_PREFIX}%`]
  );
}

async function cleanupFixtureArtifacts(pool, employeeCode) {
  await cleanupFixtureTakeoverRows(pool, employeeCode);
  await cleanupFixtureSessions(pool, employeeCode);
}

function mockReq(user, sessionId) {
  return {
    user: {
      user_id: user.user_id,
      employee_code: user.employee_code,
      email_id: user.email_id,
      role_name: user.role_name,
      session_id: sessionId
    },
    headers: { "user-agent": `${FIXTURE_UA_PREFIX}decision` },
    ip: "127.0.0.1"
  };
}

function integrationReq(extraHeaders = {}) {
  return {
    headers: {
      "user-agent": `${FIXTURE_UA_PREFIX}login`,
      ...extraHeaders
    },
    ip: "127.0.0.1"
  };
}

module.exports = {
  SESSION_TAKEOVER_TEST_DATABASE_URL_ENV,
  ALLOW_ATS_DEV_ENV,
  ALLOW_ATS_DEV_VALUE,
  FIXTURE_EMPLOYEE_CODE,
  FIXTURE_UA_PREFIX,
  tableExists,
  isSessionTakeoverIntegrationConfigured,
  resolveSessionTakeoverDatabaseUrl,
  createSessionTakeoverPool,
  probeSessionTakeoverPostgres,
  assertSessionSchemaReady,
  assertTakeoverSchemaReady,
  applyMigration066IfMissing,
  applyMigration067IfMissing,
  provisionFixtureUser,
  insertActiveSession,
  cleanupFixtureTakeoverRows,
  cleanupFixtureSessions,
  cleanupFixtureArtifacts,
  mockReq,
  integrationReq,
  crypto
};
