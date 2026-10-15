const os = require("os");

const {
  recordMigrationApplied,
  verifyLedgerRow
} = require("./migrationLedger");
const { resolveOrphan } = require("./migrationOrphans");
const { clearRecoveryBlock } = require("./migrationRecoveryBlocks");
const { assertLedgerRecordPreconditions } = require("./migrationLedgerRecordGuards");

async function repairLedgerForFilename(pool, migrationsDir, filename, appliedBy) {
  const trimmed = String(filename || "").trim();
  const { checksum } = await assertLedgerRecordPreconditions(
    pool,
    migrationsDir,
    trimmed,
    { requireSuspectedOrphan: true }
  );

  const actor = appliedBy || os.userInfo().username;

  await pool.query("BEGIN");

  try {
    await recordMigrationApplied(pool, {
      filename: trimmed,
      checksum,
      appliedBy: actor,
      durationMs: null
    });

    await verifyLedgerRow(pool, trimmed, checksum);
    await resolveOrphan(pool, trimmed, actor);
    await clearRecoveryBlock(pool, trimmed);
    await pool.query("COMMIT");
  } catch (error) {
    await pool.query("ROLLBACK");

    throw new Error(`repair-ledger failed for ${trimmed}: ${error.message}`);
  }

  return {
    filename: trimmed,
    checksum,
    repairedBy: actor,
    migrationSqlExecuted: false
  };
}

module.exports = {
  repairLedgerForFilename
};
