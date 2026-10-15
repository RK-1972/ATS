/**
 * Legacy migration runner (disabled Phase 1.1).
 * Use: OPTALYNX_DB_TARGET=local npm run migrate:up
 * See docs/database-migrations-runbook.md
 */
const { refuseLegacySchemaMigration } = require("./lib/legacyMigrationGuard");

refuseLegacySchemaMigration("scripts/runMigrations.js", {
  migrationFile: "migrations/*.sql (full replay including 000_schema_migration_ledger.sql)"
});
