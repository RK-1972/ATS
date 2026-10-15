const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("node:child_process");
const { Pool } = require("pg");

const { DEFAULT_MIGRATIONS_DIR, MIGRATIONS_DIR_ENV } = require("./migrationConstants");
const {
  resolveIntegrationTestConfig,
  buildAdminPostgresConfig,
  assertSafeDropTarget,
  assertDestroyConfirmationPresent,
  toDbEnv
} = require("./migrationIntegrationGuards");

const BACKEND_ROOT = path.join(__dirname, "..", "..");

function prerequisiteMessage(error) {
  return [
    "PostgreSQL integration tests require a local disposable database.",
    "Prerequisites:",
    "  1. Install and start PostgreSQL (or Docker: docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:16)",
    `  2. export TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/optalynx_mig_test`,
    `  3. export OPTALYNX_MIG_TEST_DESTROY_CONFIRM=I_AUTHORIZE_DISPOSABLE_MIGRATION_TEST_DB`,
    "  4. npm run migrate:test:integration",
    "",
    `Probe failed: ${error.message}`
  ].join("\n");
}

async function probePostgresAvailability() {
  try {
    const target = resolveIntegrationTestConfig();
    const admin = buildAdminPostgresConfig(target);
    const pool = new Pool(admin);

    try {
      await pool.query("SELECT 1");
      return { available: true, config: target };
    } finally {
      await pool.end().catch(() => {});
    }
  } catch (error) {
    return { available: false, error };
  }
}

async function recreateTestDatabase() {
  assertDestroyConfirmationPresent();
  const target = resolveIntegrationTestConfig();
  assertSafeDropTarget(target.database);

  const admin = buildAdminPostgresConfig(target);
  const pool = new Pool(admin);

  try {
    await pool.query(
      `SELECT pg_terminate_backend(pid)
       FROM pg_stat_activity
       WHERE datname = $1
         AND pid <> pg_backend_pid()`,
      [target.database]
    );
    await pool.query(`DROP DATABASE IF EXISTS ${quoteIdent(target.database)}`);
    await pool.query(`CREATE DATABASE ${quoteIdent(target.database)}`);
  } finally {
    await pool.end().catch(() => {});
  }

  return target;
}

/**
 * Ends the shared test pool (if any), drops/recreates the disposable database, and returns a new pool.
 * Call this instead of recreateTestDatabase() while a suite pool is still connected — otherwise
 * pg_terminate_backend in recreateTestDatabase races open clients and fails tests asynchronously.
 */
async function recreateTestDatabaseWithFreshPool(existingPool, config = resolveIntegrationTestConfig()) {
  if (existingPool) {
    await existingPool.end();
  }

  await recreateTestDatabase();
  return createTestPool(config);
}

async function destroyTestDatabase() {
  const target = resolveIntegrationTestConfig();
  assertSafeDropTarget(target.database);

  const admin = buildAdminPostgresConfig(target);
  const pool = new Pool(admin);

  try {
    await pool.query(
      `SELECT pg_terminate_backend(pid)
       FROM pg_stat_activity
       WHERE datname = $1
         AND pid <> pg_backend_pid()`,
      [target.database]
    );
    await pool.query(`DROP DATABASE IF EXISTS ${quoteIdent(target.database)}`);
  } finally {
    await pool.end().catch(() => {});
  }

  return { dropped: target.database };
}

function quoteIdent(name) {
  if (!/^[a-zA-Z0-9_]+$/.test(name)) {
    throw new Error(`Unsafe database identifier: ${name}`);
  }

  return `"${name}"`;
}

function createTestPool(config = resolveIntegrationTestConfig()) {
  return new Pool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database
  });
}

function prepareFixtureMigrationsDir(extraFiles = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "optalynx-mig-int-"));
  const ledgerFile = "000_schema_migration_ledger.sql";
  fs.copyFileSync(
    path.join(DEFAULT_MIGRATIONS_DIR, ledgerFile),
    path.join(tempDir, ledgerFile)
  );

  for (const [filename, sql] of Object.entries(extraFiles)) {
    fs.writeFileSync(path.join(tempDir, filename), sql, "utf8");
  }

  return tempDir;
}

function removeFixtureDir(dir) {
  if (dir && fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function spawnMigrateCli(args, config, extraEnv = {}) {
  const env = toDbEnv(config, extraEnv);
  delete env.TEST_DATABASE_URL;

  return spawnSync(process.execPath, ["scripts/migrateCli.js", ...args], {
    cwd: BACKEND_ROOT,
    encoding: "utf8",
    env
  });
}

function buildBaselineAdoptCliEnv(fixtureDir, filename, extraEnv = {}) {
  const {
    BASELINE_ADOPT_CONFIRM_ENV,
    buildBaselineAdoptConfirmValue
  } = require("./migrationConstants");

  return {
    [MIGRATIONS_DIR_ENV]: fixtureDir,
    [BASELINE_ADOPT_CONFIRM_ENV]: buildBaselineAdoptConfirmValue(filename),
    ...extraEnv
  };
}

async function queryBaselineAdoptSideEffects(pool, filename) {
  const ledger = await pool.query(
    "SELECT filename, checksum_sha256 FROM schema_migrations WHERE filename = $1",
    [filename]
  );
  const orphans = await pool.query(
    `SELECT filename, resolved_at
     FROM schema_migration_orphans
     WHERE filename = $1`,
    [filename]
  );
  const recovery = await pool.query(
    `SELECT filename, reason_code
     FROM schema_migration_recovery_blocks
     WHERE filename = $1`,
    [filename]
  );
  const markerColumn = await pool.query(
    `SELECT 1
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'mig_baseline_adopt'
       AND column_name = 'sql_executed_marker'`
  );

  return {
    ledgerRows: ledger.rows,
    orphanRows: orphans.rows,
    recoveryRows: recovery.rows,
    migrationSqlMarkerPresent: markerColumn.rowCount > 0
  };
}

function parseCliJson(result) {
  const text = `${result.stdout || ""}${result.stderr || ""}`.trim();
  if (!text) {
    return null;
  }

  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== "{") {
      continue;
    }
    try {
      return JSON.parse(text.slice(start));
    } catch {
      // dotenv tips and other log text can contain non-JSON `{ ... }` before CLI output
    }
  }

  return null;
}

module.exports = {
  MIGRATIONS_DIR_ENV,
  prerequisiteMessage,
  probePostgresAvailability,
  recreateTestDatabase,
  recreateTestDatabaseWithFreshPool,
  destroyTestDatabase,
  createTestPool,
  prepareFixtureMigrationsDir,
  removeFixtureDir,
  spawnMigrateCli,
  buildBaselineAdoptCliEnv,
  queryBaselineAdoptSideEffects,
  parseCliJson,
  quoteIdent
};
