const fs = require("fs");
const path = require("path");

const ADVISORY_LOCK_KEY = 913782451;

const MIGRATIONS_DIR_ENV = "OPTALYNX_MIGRATIONS_DIR";

const LEDGER_TABLE = "schema_migrations";

const LEDGER_MIGRATION_FILENAME = "000_schema_migration_ledger.sql";

const CONFIRM_PRODUCTION_VALUE = "I_UNDERSTAND_PRODUCTION";

const TARGET_ENV = "OPTALYNX_DB_TARGET";

const CONFIRM_ENV = "OPTALYNX_MIGRATE_CONFIRM";

const ALLOW_RETRY_CONFIRM_VALUE = "I_CONFIRM_MIGRATION_RETRY";

const ALLOW_RETRY_CONFIRM_ENV = "OPTALYNX_MIGRATE_ALLOW_RETRY_CONFIRM";

const BASELINE_ADOPT_CONFIRM_ENV = "OPTALYNX_BASELINE_ADOPT_CONFIRM";

function buildBaselineAdoptConfirmValue(filename) {
  const trimmed = String(filename || "").trim();

  if (!trimmed) {
    throw new Error("baseline-adopt confirmation requires a migration filename.");
  }

  return `I_ADOPT_LEDGER_RECORD_FOR_${trimmed}`;
}

const DEFAULT_MIGRATIONS_DIR = path.join(__dirname, "..", "..", "migrations");

const DEFAULT_BASELINE_MANIFEST = path.join(
  __dirname,
  "..",
  "migration-baseline-manifest.json"
);

function resolveMigrationsDir(env = process.env) {
  const override = String(env[MIGRATIONS_DIR_ENV] || "").trim();

  if (!override) {
    return DEFAULT_MIGRATIONS_DIR;
  }

  const resolved = path.isAbsolute(override)
    ? override
    : path.resolve(process.cwd(), override);

  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`${MIGRATIONS_DIR_ENV} is not a directory: ${resolved}`);
  }

  return resolved;
}

module.exports = {
  ADVISORY_LOCK_KEY,
  LEDGER_TABLE,
  LEDGER_MIGRATION_FILENAME,
  CONFIRM_PRODUCTION_VALUE,
  TARGET_ENV,
  CONFIRM_ENV,
  ALLOW_RETRY_CONFIRM_VALUE,
  ALLOW_RETRY_CONFIRM_ENV,
  BASELINE_ADOPT_CONFIRM_ENV,
  buildBaselineAdoptConfirmValue,
  DEFAULT_MIGRATIONS_DIR,
  DEFAULT_BASELINE_MANIFEST,
  MIGRATIONS_DIR_ENV,
  resolveMigrationsDir
};
