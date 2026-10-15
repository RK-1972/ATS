const {
  assertNoDrift,
  fetchLedgerRows,
  computeMigrationInventory
} = require("./migrationLedger");
const {
  enrichInventoryWithOrphanState,
  buildRepairEligibility,
  assessPendingOrphanRisk
} = require("./migrationOrphans");
const { assertRecoveryPersistenceForMutate } = require("./migrationRecoveryBlocks");
const {
  runRegisteredPanDuplicatePreflight,
  assertPreflight059AllowsMigration,
  MIGRATION_059_FILENAME
} = require("./migrationPreflight059");
const { getEffectiveManifest } = require("./migrationBaseline");
const { fileChecksum } = require("./migrationFiles");

const UNRESOLVED_PENDING_KINDS = new Set([
  "normal_pending",
  "uncertain_partial",
  "suspected_orphan",
  "recovery_blocked"
]);

function unknownInLedgerFilenames(inventory) {
  return (inventory.unknownInLedger || []).map((item) => item.filename);
}

function formatUnknownInLedgerMessage(inventory) {
  const names = unknownInLedgerFilenames(inventory).join(", ");
  return `unknown schema_migrations row(s) not present in migration directory: ${names}`;
}

function collectUnknownInLedgerRefusalReasons(inventory) {
  if (unknownInLedgerFilenames(inventory).length === 0) {
    return [];
  }

  return [formatUnknownInLedgerMessage(inventory)];
}

function assertNoUnknownInLedger(inventory) {
  const reasons = collectUnknownInLedgerRefusalReasons(inventory);

  if (reasons.length > 0) {
    throw new Error(reasons[0]);
  }
}

/**
 * Refuse ledger repair/adopt when any lexicographically earlier migration file
 * is still pending (any unresolved pending kind).
 */
function collectEarlierPendingRefusalReasons(inventory, enriched, targetFilename) {
  const files = inventory.files || [];
  const targetIndex = files.indexOf(targetFilename);

  if (targetIndex <= 0) {
    return [];
  }

  const reasons = [];
  const pendingNames = new Set(inventory.pending.map((item) => item.filename));

  for (let index = 0; index < targetIndex; index += 1) {
    const earlierFilename = files[index];

    if (!pendingNames.has(earlierFilename)) {
      continue;
    }

    const assessment = (enriched.pendingAssessment || []).find(
      (row) => row.filename === earlierFilename
    );
    const pendingKind = assessment?.pendingKind || "unknown";

    if (!UNRESOLVED_PENDING_KINDS.has(pendingKind)) {
      continue;
    }

    reasons.push(
      `earlier migration ${earlierFilename} is still unresolved (${pendingKind})`
    );
  }

  return reasons;
}

function assertLedgerRecordOrdering(inventory, enriched, targetFilename) {
  const reasons = collectEarlierPendingRefusalReasons(
    inventory,
    enriched,
    targetFilename
  );

  if (reasons.length === 0) {
    return;
  }

  throw new Error(
    [
      `ledger record refused for ${targetFilename}: earlier pending migrations must be resolved first in lexicographic order`,
      ...reasons.map((line) => `  - ${line}`)
    ].join("\n")
  );
}

/**
 * Shared preconditions for repair-ledger and baseline-adopt confirm (mutating ledger record).
 */
async function assertLedgerRecordPreconditions(
  queryable,
  migrationsDir,
  filename,
  options = {}
) {
  const { requireSuspectedOrphan = true } = options;
  const trimmed = String(filename || "").trim();
  const checksum = fileChecksum(migrationsDir, trimmed);

  const ledger = await fetchLedgerRows(queryable);
  const inventory = computeMigrationInventory(migrationsDir, {
    tableExists: ledger.tableExists,
    rows: ledger.rows
  });

  assertNoDrift(inventory);
  assertNoUnknownInLedger(inventory);

  if (inventory.applied.some((item) => item.filename === trimmed)) {
    throw new Error(
      `repair-ledger refused: ${trimmed} is already recorded in schema_migrations.`
    );
  }

  const pendingItem = inventory.pending.find((item) => item.filename === trimmed);

  if (!pendingItem) {
    throw new Error(
      `repair-ledger refused: ${trimmed} is not in the pending migration list.`
    );
  }

  const manifest = getEffectiveManifest(migrationsDir);
  const enriched = await enrichInventoryWithOrphanState(queryable, manifest, inventory);

  assertRecoveryPersistenceForMutate(enriched);
  assertLedgerRecordOrdering(inventory, enriched, trimmed);

  if (trimmed === MIGRATION_059_FILENAME) {
    const preflight059 = await runRegisteredPanDuplicatePreflight(queryable);
    assertPreflight059AllowsMigration(preflight059);
  }

  const assessment = await assessPendingOrphanRisk(queryable, manifest, pendingItem);

  if (requireSuspectedOrphan && assessment.pendingKind !== "suspected_orphan") {
    throw new Error(
      `repair-ledger refused for ${trimmed}: pending kind "${assessment.pendingKind}" is not eligible (requires suspected_orphan).`
    );
  }

  const eligibility = buildRepairEligibility(assessment, checksum);

  if (!eligibility.eligible) {
    throw new Error(
      `repair-ledger refused for ${trimmed}: ${eligibility.reason} Manual DBA review required.`
    );
  }

  return {
    checksum,
    inventory,
    enriched,
    assessment,
    eligibility
  };
}

module.exports = {
  UNRESOLVED_PENDING_KINDS,
  unknownInLedgerFilenames,
  formatUnknownInLedgerMessage,
  collectUnknownInLedgerRefusalReasons,
  assertNoUnknownInLedger,
  collectEarlierPendingRefusalReasons,
  assertLedgerRecordOrdering,
  assertLedgerRecordPreconditions
};
