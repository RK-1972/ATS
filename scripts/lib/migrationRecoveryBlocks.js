const ORPHAN_TABLE = "schema_migration_orphans";
const RECOVERY_BLOCK_TABLE = "schema_migration_recovery_blocks";

const REASON_ORPHAN_UNRECORDED = "MIGRATION_ORPHAN_UNRECORDED";
const REASON_LEDGER_ORPHAN = "MIGRATION_LEDGER_ORPHAN";

const ENSURE_RECOVERY_INFRASTRUCTURE_SQL = `
CREATE TABLE IF NOT EXISTS ${ORPHAN_TABLE} (
  filename VARCHAR(255) PRIMARY KEY,
  checksum_sha256 CHAR(64) NOT NULL,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  detected_by VARCHAR(255),
  cause_code VARCHAR(64) NOT NULL DEFAULT 'MIGRATION_LEDGER_ORPHAN',
  cause_detail TEXT,
  resolved_at TIMESTAMPTZ,
  resolved_by VARCHAR(255)
);

CREATE TABLE IF NOT EXISTS ${RECOVERY_BLOCK_TABLE} (
  filename VARCHAR(255) PRIMARY KEY,
  checksum_sha256 CHAR(64) NOT NULL,
  reason_code VARCHAR(64) NOT NULL,
  detail TEXT,
  blocked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  blocked_by VARCHAR(255)
);
`;

async function orphansTableExists(queryable) {
  const result = await queryable.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = $1
     ) AS exists`,
    [ORPHAN_TABLE]
  );

  return Boolean(result.rows[0]?.exists);
}

async function evaluateRecoveryPersistenceCapability(queryable, ledgerTablePresent) {
  if (!ledgerTablePresent) {
    return { capable: true, missingTables: [] };
  }

  const missing = [];

  if (!(await orphansTableExists(queryable))) {
    missing.push(ORPHAN_TABLE);
  }

  if (!(await recoveryBlockTableExists(queryable))) {
    missing.push(RECOVERY_BLOCK_TABLE);
  }

  return {
    capable: missing.length === 0,
    missingTables: missing
  };
}

function assertRecoveryPersistenceForMutate(enriched) {
  if (enriched.recoveryPersistenceCapable !== false) {
    return;
  }

  const missing = (enriched.missingRecoveryTables || []).join(", ");

  throw new Error(
    `migrate:up refused: recovery persistence tables are missing (${missing}). ` +
      "Durable orphan/recovery state cannot be recorded. Apply missing DDL from " +
      "000_schema_migration_ledger.sql or perform manual DBA review before mutating migrations."
  );
}

async function recoveryBlockTableExists(queryable) {
  const result = await queryable.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = $1
     ) AS exists`,
    [RECOVERY_BLOCK_TABLE]
  );

  return Boolean(result.rows[0]?.exists);
}

async function ensureRecoveryInfrastructure(queryable) {
  await queryable.query(ENSURE_RECOVERY_INFRASTRUCTURE_SQL);
}

async function fetchRecoveryBlocks(queryable) {
  const exists = await recoveryBlockTableExists(queryable);

  if (!exists) {
    return { tableExists: false, rows: [] };
  }

  const result = await queryable.query(
    `SELECT filename, checksum_sha256, reason_code, detail, blocked_at, blocked_by
     FROM ${RECOVERY_BLOCK_TABLE}
     ORDER BY filename`
  );

  return { tableExists: true, rows: result.rows };
}

async function recordRecoveryBlock(queryable, payload) {
  const { filename, checksum, reasonCode, detail, blockedBy } = payload;

  await ensureRecoveryInfrastructure(queryable);

  await queryable.query(
    `INSERT INTO ${RECOVERY_BLOCK_TABLE} (
       filename,
       checksum_sha256,
       reason_code,
       detail,
       blocked_by
     ) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (filename) DO UPDATE
     SET checksum_sha256 = EXCLUDED.checksum_sha256,
         reason_code = EXCLUDED.reason_code,
         detail = EXCLUDED.detail,
         blocked_at = NOW(),
         blocked_by = EXCLUDED.blocked_by`,
    [filename, checksum, reasonCode, detail || null, blockedBy || null]
  );

  return { recorded: true };
}

async function clearRecoveryBlock(queryable, filename) {
  const exists = await recoveryBlockTableExists(queryable);

  if (!exists) {
    return { cleared: false };
  }

  const result = await queryable.query(
    `DELETE FROM ${RECOVERY_BLOCK_TABLE} WHERE filename = $1`,
    [filename]
  );

  return { cleared: result.rowCount > 0 };
}

module.exports = {
  RECOVERY_BLOCK_TABLE,
  ORPHAN_TABLE,
  REASON_ORPHAN_UNRECORDED,
  REASON_LEDGER_ORPHAN,
  ensureRecoveryInfrastructure,
  orphansTableExists,
  evaluateRecoveryPersistenceCapability,
  assertRecoveryPersistenceForMutate,
  fetchRecoveryBlocks,
  recordRecoveryBlock,
  clearRecoveryBlock,
  recoveryBlockTableExists
};
