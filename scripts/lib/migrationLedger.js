const { LEDGER_TABLE } = require("./migrationConstants");
const { fileChecksum, listMigrationSqlFiles } = require("./migrationFiles");

async function ledgerTableExists(queryable) {
  const result = await queryable.query(
    `SELECT EXISTS (
       SELECT 1
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = $1
     ) AS exists`,
    [LEDGER_TABLE]
  );

  return Boolean(result.rows[0]?.exists);
}

async function fetchLedgerRows(queryable) {
  const tableExists = await ledgerTableExists(queryable);

  if (!tableExists) {
    return { tableExists: false, rows: [] };
  }

  const result = await queryable.query(
    `SELECT filename, checksum_sha256, applied_at, applied_by, duration_ms
     FROM ${LEDGER_TABLE}
     ORDER BY filename`
  );

  return { tableExists: true, rows: result.rows };
}

function buildLedgerMap(rows) {
  const map = new Map();

  for (const row of rows) {
    map.set(row.filename, row);
  }

  return map;
}

function computeMigrationInventory(migrationsDir, ledgerState) {
  const ledgerRows = ledgerState?.rows || [];
  const ledgerTablePresent = Boolean(ledgerState?.tableExists);

  const files = listMigrationSqlFiles(migrationsDir);
  const ledgerMap = buildLedgerMap(ledgerRows);

  const applied = [];
  const pending = [];
  const drift = [];
  const unknownInLedger = [];

  for (const filename of files) {
    const ledgerRow = ledgerMap.get(filename);
    const currentChecksum = fileChecksum(migrationsDir, filename);

    if (!ledgerRow) {
      pending.push({ filename, checksum: currentChecksum });
      continue;
    }

    if (ledgerRow.checksum_sha256 !== currentChecksum) {
      drift.push({
        filename,
        recordedChecksum: ledgerRow.checksum_sha256,
        currentChecksum,
        applied_at: ledgerRow.applied_at
      });
      continue;
    }

    applied.push({
      filename,
      checksum: currentChecksum,
      applied_at: ledgerRow.applied_at,
      applied_by: ledgerRow.applied_by,
      duration_ms: ledgerRow.duration_ms
    });
  }

  for (const [filename] of ledgerMap) {
    if (!files.includes(filename)) {
      unknownInLedger.push({ filename });
    }
  }

  return {
    files,
    applied,
    pending,
    drift,
    unknownInLedger,
    ledgerTablePresent,
    ledgerRowCount: ledgerRows.length
  };
}

function assertNoDrift(inventory) {
  if (inventory.drift.length > 0) {
    const names = inventory.drift.map((item) => item.filename).join(", ");
    throw new Error(
      `Checksum drift detected for applied migration(s): ${names}. Resolve drift before applying pending migrations.`
    );
  }
}

async function recordMigrationApplied(queryable, payload) {
  const { filename, checksum, appliedBy, durationMs } = payload;

  const result = await queryable.query(
    `INSERT INTO ${LEDGER_TABLE} (
       filename,
       checksum_sha256,
       applied_by,
       duration_ms
     ) VALUES ($1, $2, $3, $4)
     ON CONFLICT (filename) DO NOTHING
     RETURNING filename`,
    [filename, checksum, appliedBy || null, durationMs ?? null]
  );

  if (result.rowCount !== 1) {
    throw new Error(
      `Ledger insert did not create a row for ${filename} (already recorded or ledger table missing).`
    );
  }
}

async function verifyLedgerRow(queryable, filename, checksum) {
  const result = await queryable.query(
    `SELECT checksum_sha256
     FROM ${LEDGER_TABLE}
     WHERE filename = $1`,
    [filename]
  );

  if (result.rowCount !== 1) {
    throw new Error(
      `Ledger verification failed: no row found for ${filename} after migration.`
    );
  }

  const recorded = String(result.rows[0].checksum_sha256 || "");

  if (recorded !== checksum) {
    throw new Error(
      `Ledger verification failed: checksum mismatch for ${filename}.`
    );
  }
}

module.exports = {
  ledgerTableExists,
  fetchLedgerRows,
  buildLedgerMap,
  computeMigrationInventory,
  assertNoDrift,
  recordMigrationApplied,
  verifyLedgerRow
};
