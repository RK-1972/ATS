const os = require("os");

const { fileChecksum, listMigrationSqlFiles } = require("./migrationFiles");
const {
  fetchLedgerRows,
  computeMigrationInventory,
  assertNoDrift
} = require("./migrationLedger");
const { getEffectiveManifest } = require("./migrationBaseline");
const {
  enrichInventoryWithOrphanState,
  buildRepairEligibility,
  assessPendingOrphanRisk
} = require("./migrationOrphans");
const { assertRecoveryPersistenceForMutate } = require("./migrationRecoveryBlocks");
const {
  collectUnknownInLedgerRefusalReasons,
  collectEarlierPendingRefusalReasons
} = require("./migrationLedgerRecordGuards");
const {
  runRegisteredPanDuplicatePreflight,
  MIGRATION_059_FILENAME
} = require("./migrationPreflight059");
const { repairLedgerForFilename } = require("./migrationRepair");
const { withAdvisoryLock } = require("./migrationRunner");
const {
  BASELINE_ADOPT_CONFIRM_ENV,
  buildBaselineAdoptConfirmValue
} = require("./migrationConstants");

function summarizeFingerprint(fingerprint) {
  if (!fingerprint) {
    return {
      configured: false,
      allPass: null,
      checks: []
    };
  }

  return {
    configured: fingerprint.fingerprintConfigured,
    allPass: fingerprint.allPass,
    checks: (fingerprint.checks || []).map((check) => ({
      type: check.type,
      ok: check.ok,
      detail: check.detail ?? null
    }))
  };
}

function summarizePreflight059(preflight059) {
  if (!preflight059) {
    return null;
  }

  return {
    ok: preflight059.ok,
    duplicatePanGroups: preflight059.duplicatePanGroups,
    affectedRegisteredRows: preflight059.affectedRegisteredRows,
    reason: preflight059.reason || null,
    nextStep: preflight059.nextStep || null
  };
}

async function assessBaselineAdoptEligibility(queryable, migrationsDir, filename) {
  const refusalReasons = [];
  const trimmed = String(filename || "").trim();

  const files = listMigrationSqlFiles(migrationsDir);
  if (!files.includes(trimmed)) {
    return {
      filename: trimmed,
      eligible: false,
      refusalReasons: ["migration file not found in configured migrations directory"],
      checksum: null,
      pendingKind: null,
      fingerprint: summarizeFingerprint(null),
      preflight059: null,
      migrationSqlExecuted: false
    };
  }

  const checksum = fileChecksum(migrationsDir, trimmed);
  const ledger = await fetchLedgerRows(queryable);
  const inventory = computeMigrationInventory(migrationsDir, {
    tableExists: ledger.tableExists,
    rows: ledger.rows
  });

  if (inventory.drift.length > 0) {
    refusalReasons.push(
      `checksum drift detected for: ${inventory.drift.map((item) => item.filename).join(", ")}`
    );
  }

  refusalReasons.push(...collectUnknownInLedgerRefusalReasons(inventory));

  if (inventory.applied.some((item) => item.filename === trimmed)) {
    refusalReasons.push("migration is already recorded in schema_migrations");
  }

  const pendingItem = inventory.pending.find((item) => item.filename === trimmed);
  if (!pendingItem) {
    if (inventory.drift.some((item) => item.filename === trimmed)) {
      refusalReasons.push("migration is in checksum drift state (not adoptable as pending)");
    } else {
      refusalReasons.push("migration is not in the pending list");
    }
  }

  const manifest = getEffectiveManifest(migrationsDir);
  let enriched = null;
  let assessment = null;

  if (pendingItem) {
    enriched = await enrichInventoryWithOrphanState(queryable, manifest, inventory);

    try {
      assertRecoveryPersistenceForMutate(enriched);
    } catch (error) {
      refusalReasons.push(error.message);
    }

    refusalReasons.push(
      ...collectEarlierPendingRefusalReasons(inventory, enriched, trimmed)
    );

    assessment = await assessPendingOrphanRisk(queryable, manifest, pendingItem);

    if (assessment.pendingKind !== "suspected_orphan") {
      refusalReasons.push(
        `pending kind "${assessment.pendingKind}" is not adoptable (requires suspected_orphan)`
      );
    }

    const eligibility = buildRepairEligibility(assessment, checksum);
    if (!eligibility.eligible) {
      refusalReasons.push(eligibility.reason);
    }
  }

  let preflight059 = null;
  if (trimmed === MIGRATION_059_FILENAME) {
    preflight059 = await runRegisteredPanDuplicatePreflight(queryable);
    if (!preflight059.ok) {
      refusalReasons.push(
        `059 preflight failed: ${preflight059.reason || "duplicate REGISTERED PAN groups present"}`
      );
    }
  }

  return {
    filename: trimmed,
    eligible: refusalReasons.length === 0,
    refusalReasons,
    checksum,
    pendingKind: assessment?.pendingKind || null,
    fingerprint: summarizeFingerprint(assessment?.fingerprint),
    preflight059: summarizePreflight059(preflight059),
    migrationSqlExecuted: false
  };
}

async function dryRunBaselineAdopt(pool, migrationsDir, filename) {
  const assessment = await assessBaselineAdoptEligibility(pool, migrationsDir, filename);

  return {
    mode: "dry-run",
    adoptionOutcome: assessment.eligible ? "eligible" : "refused",
    ...assessment
  };
}

async function confirmBaselineAdopt(pool, migrationsDir, filename, appliedBy) {
  const ledger = await fetchLedgerRows(pool);
  const inventory = computeMigrationInventory(migrationsDir, {
    tableExists: ledger.tableExists,
    rows: ledger.rows
  });

  assertNoDrift(inventory);

  const assessEligibility = module.exports.assessBaselineAdoptEligibility;

  const assessment = await assessEligibility(pool, migrationsDir, filename);
  if (!assessment.eligible) {
    throw new Error(
      `baseline-adopt refused for ${filename}: ${assessment.refusalReasons.join("; ")}`
    );
  }

  const actor = appliedBy || os.userInfo().username;

  const locked = await withAdvisoryLock(pool, async (client) => {
    const reassess = await assessEligibility(client, migrationsDir, filename);
    if (!reassess.eligible) {
      throw new Error(
        `baseline-adopt refused after advisory lock for ${filename}: ${reassess.refusalReasons.join("; ")}`
      );
    }

    const repairResult = await repairLedgerForFilename(
      client,
      migrationsDir,
      filename,
      actor
    );

    return { repairResult, decisionAssessment: reassess };
  });

  return {
    mode: "confirm",
    adoptionOutcome: "ledger_recorded",
    filename: locked.repairResult.filename,
    checksum: locked.repairResult.checksum,
    adoptedBy: locked.repairResult.repairedBy,
    fingerprint: locked.decisionAssessment.fingerprint,
    preflight059: locked.decisionAssessment.preflight059,
    migrationSqlExecuted: false
  };
}

function assertBaselineAdoptConfirmAllowed(filename) {
  const trimmed = String(filename || "").trim();

  if (!trimmed) {
    throw new Error("baseline-adopt requires --filename <migration-file.sql>.");
  }

  const expected = buildBaselineAdoptConfirmValue(trimmed);
  const confirm = String(process.env[BASELINE_ADOPT_CONFIRM_ENV] || "").trim();

  if (confirm !== expected) {
    throw new Error(
      `Refusing baseline-adopt: set ${BASELINE_ADOPT_CONFIRM_ENV}=${expected}`
    );
  }

  return trimmed;
}

module.exports = {
  assessBaselineAdoptEligibility,
  dryRunBaselineAdopt,
  confirmBaselineAdopt,
  assertBaselineAdoptConfirmAllowed,
  summarizeFingerprint,
  summarizePreflight059
};
