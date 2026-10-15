const os = require("os");

const { ADVISORY_LOCK_KEY } = require("./migrationConstants");
const {
  fileChecksum,
  readMigrationSql,
  sqlManagesOwnTransaction
} = require("./migrationFiles");
const {
  recordMigrationApplied,
  verifyLedgerRow
} = require("./migrationLedger");
const {
  MigrationConsistencyError,
  RECOVERY_LEDGER_ORPHAN,
  RECOVERY_ORPHAN_UNRECORDED
} = require("./migrationErrors");
const { recordOrphanFailure, resolveOrphan } = require("./migrationOrphans");
const {
  recordRecoveryBlock,
  REASON_ORPHAN_UNRECORDED,
  clearRecoveryBlock
} = require("./migrationRecoveryBlocks");

async function tryAcquireAdvisoryLock(client) {
  const result = await client.query(
    "SELECT pg_try_advisory_lock($1) AS acquired",
    [ADVISORY_LOCK_KEY]
  );

  return Boolean(result.rows[0]?.acquired);
}

async function releaseAdvisoryLock(client) {
  const result = await client.query("SELECT pg_advisory_unlock($1) AS released", [
    ADVISORY_LOCK_KEY
  ]);

  return Boolean(result.rows[0]?.released);
}

async function withAdvisoryLock(pool, fn) {
  const client = await pool.connect();
  let lockHeld = false;
  let destroyClient = false;

  try {
    const acquired = await tryAcquireAdvisoryLock(client);

    if (!acquired) {
      throw new Error(
        "Another migration process holds the advisory lock. Try again later."
      );
    }

    lockHeld = true;
    return await fn(client);
  } finally {
    if (lockHeld) {
      try {
        const released = await releaseAdvisoryLock(client);

        if (!released) {
          destroyClient = true;
        }
      } catch {
        destroyClient = true;
      }
    }

    if (destroyClient) {
      await client.end().catch(() => {});
    } else {
      client.release();
    }
  }
}

async function recordLedgerForMigration(client, payload) {
  await client.query("BEGIN");
  try {
    await recordMigrationApplied(client, payload);
    await verifyLedgerRow(client, payload.filename, payload.checksum);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function applySingleMigration(client, options) {
  const { migrationsDir, filename, appliedBy } = options;
  const checksum = fileChecksum(migrationsDir, filename);
  const sql = readMigrationSql(migrationsDir, filename);
  const started = Date.now();
  const actor = appliedBy || os.userInfo().username;
  const selfManaged = sqlManagesOwnTransaction(sql);
  const trimmedSql = String(sql).trim();

  if (!selfManaged) {
    await client.query("BEGIN");
    try {
      await client.query(trimmedSql);
      await recordMigrationApplied(client, {
        filename,
        checksum,
        appliedBy: actor,
        durationMs: null
      });
      await verifyLedgerRow(client, filename, checksum);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  } else {
    try {
      await client.query(trimmedSql);
    } catch (error) {
      throw new MigrationConsistencyError(
        "MIGRATION_SQL_FAILED",
        `Migration SQL failed for ${filename}: ${error.message}`,
        { filename }
      );
    }

    try {
      await recordLedgerForMigration(client, {
        filename,
        checksum,
        appliedBy: actor,
        durationMs: null
      });
    } catch (error) {
      const orphanResult = await recordOrphanFailure(client, {
        filename,
        checksum,
        detectedBy: actor,
        causeDetail: error.message
      });

      if (!orphanResult.recorded) {
        let recoveryBlockRecorded = false;
        let recoveryBlockError = null;

        try {
          await recordRecoveryBlock(client, {
            filename,
            checksum,
            reasonCode: REASON_ORPHAN_UNRECORDED,
            detail: `Orphan persistence failed: ${orphanResult.reason || "unknown"}. Ledger error: ${error.message}`,
            blockedBy: actor
          });
          recoveryBlockRecorded = true;
        } catch (blockError) {
          recoveryBlockError = blockError.message;
        }

        const persistenceSummary = [
          `orphanRecorded=false (${orphanResult.reason || "unknown"})`,
          `recoveryBlockRecorded=${recoveryBlockRecorded}`,
          recoveryBlockError ? `recoveryBlockError=${recoveryBlockError}` : null
        ]
          .filter(Boolean)
          .join("; ");

        throw new MigrationConsistencyError(
          "MIGRATION_ORPHAN_UNRECORDED",
          `Migration SQL applied for ${filename}, but orphan metadata could not be recorded. Persistence: ${persistenceSummary}. ${RECOVERY_ORPHAN_UNRECORDED}`,
          {
            filename,
            cause: error.message,
            orphanRecorded: false,
            recoveryBlockRecorded,
            recoveryBlockError,
            orphanFailureReason: orphanResult.reason || null
          }
        );
      }

      throw new MigrationConsistencyError(
        "MIGRATION_LEDGER_ORPHAN",
        `Migration SQL applied for ${filename}, but ledger recording failed. ${RECOVERY_LEDGER_ORPHAN}`,
        { filename, cause: error.message, orphanRecorded: true }
      );
    }
  }

  const durationMs = Date.now() - started;
  await verifyLedgerRow(client, filename, checksum);
  await resolveOrphan(client, filename, actor);
  await clearRecoveryBlock(client, filename);

  return {
    filename,
    checksum,
    durationMs,
    wrapped: !selfManaged,
    atomicWithLedger: !selfManaged
  };
}

async function applyPendingMigrations(pool, options) {
  const { migrationsDir, pendingFilenames, appliedBy, onApplied } = options;

  const applied = [];

  await withAdvisoryLock(pool, async (client) => {
    for (const filename of pendingFilenames) {
      const result = await applySingleMigration(client, {
        migrationsDir,
        filename,
        appliedBy
      });
      applied.push(result);

      if (onApplied) {
        onApplied(result);
      }
    }
  });

  return applied;
}

module.exports = {
  tryAcquireAdvisoryLock,
  releaseAdvisoryLock,
  withAdvisoryLock,
  applySingleMigration,
  applyPendingMigrations
};
