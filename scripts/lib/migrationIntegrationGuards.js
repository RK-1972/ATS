const { URL } = require("url");

const CONFIRM_ENV = "OPTALYNX_MIG_TEST_DESTROY_CONFIRM";
const CONFIRM_VALUE = "I_AUTHORIZE_DISPOSABLE_MIGRATION_TEST_DB";
const TEST_DATABASE_URL_ENV = "TEST_DATABASE_URL";
const REQUIRE_PG_ENV = "OPTALYNX_MIG_INTEGRATION_REQUIRE_PG";
const REQUIRE_PG_VALUE = "1";

const DEFAULT_ALLOWED_DB_NAME = "optalynx_mig_test";
const ALLOWED_DATABASE_PATTERN = /^optalynx_mig_test(_[a-z0-9_]+)?$/i;

const FORBIDDEN_DATABASE_NAMES = new Set([
  "ats_dev",
  "neondb",
  "postgres",
  "template0",
  "template1"
]);

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

const FORBIDDEN_HOST_FRAGMENTS = [
  "neon.tech",
  "render.com",
  "amazonaws.com",
  "azure.com",
  "digitalocean.com"
];

function isTestDatabaseUrlConfigured() {
  const raw = process.env[TEST_DATABASE_URL_ENV];
  return !!(raw && String(raw).trim());
}

function isIntegrationPgRequired() {
  return String(process.env[REQUIRE_PG_ENV] || "").trim() === REQUIRE_PG_VALUE;
}

function sanitizeProbeErrorMessage(message) {
  let text = String(message || "PostgreSQL availability probe failed").trim();
  text = text.replace(/postgres(ql)?:\/\/[^\s'"]+/gi, "[connection URL redacted]");
  return text;
}

function assertIntegrationPgProbeSucceeded(probe) {
  if (probe?.available) {
    return;
  }

  if (!isTestDatabaseUrlConfigured()) {
    return;
  }

  if (!isIntegrationPgRequired()) {
    return;
  }

  const detail = sanitizeProbeErrorMessage(probe?.error?.message);
  throw new Error(
    `PostgreSQL integration is required (${REQUIRE_PG_ENV}=${REQUIRE_PG_VALUE} and ${TEST_DATABASE_URL_ENV} is set) but the availability probe failed: ${detail}`
  );
}

function getRequiredTestDatabaseUrl() {
  const raw = process.env[TEST_DATABASE_URL_ENV];

  if (!raw || !String(raw).trim()) {
    throw new Error(
      `${TEST_DATABASE_URL_ENV} is required for integration tests (do not use .env fallback).`
    );
  }

  return String(raw).trim();
}

function parsePostgresUrl(connectionString) {
  let parsed;

  try {
    parsed = new URL(connectionString);
  } catch (error) {
    throw new Error(`Invalid ${TEST_DATABASE_URL_ENV}: ${error.message}`);
  }

  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error(
      `${TEST_DATABASE_URL_ENV} must use postgres:// or postgresql:// scheme.`
    );
  }

  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));

  if (!database) {
    throw new Error(`${TEST_DATABASE_URL_ENV} must include a database name.`);
  }

  return {
    host: parsed.hostname,
    port: Number(parsed.port || 5432),
    user: decodeURIComponent(parsed.username || ""),
    password: decodeURIComponent(parsed.password || ""),
    database
  };
}

function assertDestroyConfirmationPresent() {
  const confirm = String(process.env[CONFIRM_ENV] || "").trim();

  if (confirm !== CONFIRM_VALUE) {
    throw new Error(
      `Refusing destructive integration test operation: set ${CONFIRM_ENV}=${CONFIRM_VALUE}.`
    );
  }
}

function assertSafeHost(host) {
  const normalized = String(host || "").trim().toLowerCase();

  if (!LOCAL_HOSTS.has(normalized)) {
    throw new Error(
      `Refusing integration test against non-local host "${host}". Use local PostgreSQL or Docker on localhost.`
    );
  }

  for (const fragment of FORBIDDEN_HOST_FRAGMENTS) {
    if (normalized.includes(fragment)) {
      throw new Error(
        `Refusing integration test against forbidden host pattern "${fragment}".`
      );
    }
  }
}

function assertSafeDatabaseName(databaseName, { allowAdminPostgres = false } = {}) {
  const name = String(databaseName || "").trim();

  if (!name) {
    throw new Error("Database name is required for safety validation.");
  }

  const lower = name.toLowerCase();

  if (FORBIDDEN_DATABASE_NAMES.has(lower) && !(allowAdminPostgres && lower === "postgres")) {
    throw new Error(
      `Refusing integration test operation on forbidden database name "${name}".`
    );
  }

  if (lower === "postgres") {
    if (allowAdminPostgres) {
      return;
    }

    throw new Error(
      "postgres database cannot be used as the integration test target."
    );
  }

  if (!ALLOWED_DATABASE_PATTERN.test(name)) {
    throw new Error(
      `Refusing integration test operation: database "${name}" is not an allowed disposable name (expected ${DEFAULT_ALLOWED_DB_NAME} or ${DEFAULT_ALLOWED_DB_NAME}_<suffix>).`
    );
  }
}

function assertSafeTestTarget(config) {
  assertSafeHost(config.host);
  assertSafeDatabaseName(config.database);
}

function assertSafeDropTarget(databaseName) {
  assertDestroyConfirmationPresent();
  assertSafeDatabaseName(databaseName, { allowAdminPostgres: false });
}

function resolveIntegrationTestConfig() {
  const connectionString = getRequiredTestDatabaseUrl();
  const config = parsePostgresUrl(connectionString);
  assertSafeTestTarget(config);
  return config;
}

function buildAdminPostgresConfig(targetConfig) {
  assertSafeHost(targetConfig.host);

  return {
    host: targetConfig.host,
    port: targetConfig.port,
    user: targetConfig.user,
    password: targetConfig.password,
    database: "postgres"
  };
}

function toDbEnv(config, extra = {}) {
  const localAllowlist = String(
    extra.OPTALYNX_LOCAL_DB_NAMES || config.database
  );

  return {
    ...extra,
    DB_HOST: config.host,
    DB_PORT: String(config.port),
    DB_USER: config.user,
    DB_PASSWORD: config.password,
    DB_NAME: config.database,
    OPTALYNX_LOCAL_DB_NAMES: localAllowlist,
    NODE_ENV: "test",
    RENDER: "",
    OPTALYNX_DB_TARGET: "local"
  };
}

module.exports = {
  CONFIRM_ENV,
  CONFIRM_VALUE,
  TEST_DATABASE_URL_ENV,
  REQUIRE_PG_ENV,
  REQUIRE_PG_VALUE,
  isTestDatabaseUrlConfigured,
  isIntegrationPgRequired,
  sanitizeProbeErrorMessage,
  assertIntegrationPgProbeSucceeded,
  DEFAULT_ALLOWED_DB_NAME,
  ALLOWED_DATABASE_PATTERN,
  getRequiredTestDatabaseUrl,
  parsePostgresUrl,
  assertDestroyConfirmationPresent,
  assertSafeHost,
  assertSafeDatabaseName,
  assertSafeTestTarget,
  assertSafeDropTarget,
  resolveIntegrationTestConfig,
  buildAdminPostgresConfig,
  toDbEnv
};
