const path = require("path");

const REPLACEMENT = "npm run migrate:up";
const RUNBOOK = "docs/database-migrations-runbook.md";

function formatEntrypoint(entrypoint) {
  if (!entrypoint) {
    return "legacy schema migration runner";
  }

  return path.basename(String(entrypoint));
}

/**
 * Blocks legacy full-replay / one-off SQL runners that bypass the ledger and target guards.
 */
function refuseLegacySchemaMigration(entrypoint, options = {}) {
  const label = formatEntrypoint(entrypoint);
  const migrationFile = options.migrationFile
    ? `\n  migration file: ${options.migrationFile}`
    : "";

  console.error(
    [
      "",
      "Legacy schema migration blocked.",
      `  entrypoint: ${label}${migrationFile}`,
      "",
      "This command replays SQL outside the Migration Manager ledger and target guards.",
      `Use instead: OPTALYNX_DB_TARGET=local ${REPLACEMENT}`,
      "For Neon production: set OPTALYNX_MIGRATE_CONFIRM=I_UNDERSTAND_PRODUCTION",
      `See ${RUNBOOK}`,
      ""
    ].join("\n")
  );

  process.exit(1);
}

module.exports = {
  refuseLegacySchemaMigration,
  REPLACEMENT,
  RUNBOOK
};
