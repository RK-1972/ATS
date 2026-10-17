#!/usr/bin/env node

require("dotenv").config();

const {
  LEDGER_MIGRATION_FILENAME,
  resolveMigrationsDir
} = require("./lib/migrationConstants");
const { createPool, resolvePoolConfigFromEnv } = require("./lib/migrationDb");
const {
  requireDbTarget,
  describeConnection,
  assertReadOnlyTargetAllowed,
  assertMutatingTargetAllowed,
  assertMigrationRetryOverrideAllowed
} = require("./lib/migrationGuards");
const {
  fetchLedgerRows,
  computeMigrationInventory,
  assertNoDrift
} = require("./lib/migrationLedger");
const { assertNoUnknownInLedger } = require("./lib/migrationLedgerRecordGuards");
const { applyPendingMigrations, withAdvisoryLock } = require("./lib/migrationRunner");
const { repairLedgerForFilename } = require("./lib/migrationRepair");
const {
  enrichInventoryWithOrphanState,
  assertMigrateUpAllowedForPending,
  buildPendingStateVisibility
} = require("./lib/migrationOrphans");
const { assertRetryOrderingAllowed } = require("./lib/migrationRetryOrder");
const { assertRecoveryPersistenceForMutate } = require("./lib/migrationRecoveryBlocks");
const {
  getEffectiveManifest,
  buildBaselinePlan,
  evaluateFilenameFingerprints
} = require("./lib/migrationBaseline");
const { listMigrationSqlFiles } = require("./lib/migrationFiles");
const {
  runRegisteredPanDuplicatePreflight,
  pendingIncludes059,
  assertPreflight059AllowsMigration,
  MIGRATION_059_FILENAME
} = require("./lib/migrationPreflight059");
const { computeVerifyOutcome, VERIFY_OUTCOME } = require("./lib/migrationVerify");
const {
  BASELINE_ADOPT_CONFIRM_ENV,
  buildBaselineAdoptConfirmValue
} = require("./lib/migrationConstants");
const {
  dryRunBaselineAdopt,
  confirmBaselineAdopt,
  assertBaselineAdoptConfirmAllowed
} = require("./lib/migrationBaselineAdopt");

function printJson(payload) {
  console.log(JSON.stringify(payload, null, 2));
}

function parseArgs(argv) {
  const args = [...argv];
  const command = args.shift() || "help";
  const flags = {
    to: null,
    filename: null,
    offline: false,
    json: false,
    allowRetryFilename: null,
    dryRun: false,
    confirm: false
  };

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];

    if (token === "--to" && args[i + 1]) {
      flags.to = args[i + 1];
      i += 1;
      continue;
    }

    if (token === "--filename" && args[i + 1]) {
      flags.filename = args[i + 1];
      i += 1;
      continue;
    }

    if (token === "--offline") {
      flags.offline = true;
      continue;
    }

    if (token === "--json") {
      flags.json = true;
      continue;
    }

    if (token === "--allow-retry-filename" && args[i + 1]) {
      flags.allowRetryFilename = args[i + 1];
      i += 1;
      continue;
    }

    if (token === "--dry-run") {
      flags.dryRun = true;
      continue;
    }

    if (token === "--confirm") {
      flags.confirm = true;
      continue;
    }
  }

  return { command, flags };
}

function filterPendingUpTo(pending, toFilename) {
  if (!toFilename) {
    return pending;
  }

  const ordered = pending.map((item) => item.filename);
  const limitIndex = ordered.indexOf(toFilename);

  if (limitIndex === -1) {
    throw new Error(`--to migration not found in pending list: ${toFilename}`);
  }

  return pending.slice(0, limitIndex + 1);
}

async function loadInventory(pool, migrationsDir) {
  const ledger = await fetchLedgerRows(pool);
  const inventory = computeMigrationInventory(migrationsDir, {
    tableExists: ledger.tableExists,
    rows: ledger.rows
  });

  return { ledger, inventory };
}

async function loadEnrichedInventory(pool, migrationsDir) {
  const { ledger, inventory } = await loadInventory(pool, migrationsDir);
  const manifest = getEffectiveManifest(migrationsDir);
  const enriched = await enrichInventoryWithOrphanState(
    pool,
    manifest,
    inventory
  );

  return { ledger, inventory, enriched, manifest };
}

function appendOrphanFields(summary, enriched) {
  const stateVisibility = buildPendingStateVisibility(enriched);

  return {
    ...summary,
    normalPending: enriched.normalPending.map((item) => item.filename),
    suspectedOrphans: enriched.suspectedOrphans.map((item) => ({
      filename: item.filename,
      pendingKind: item.pendingKind,
      recordedOrphan: item.recordedOrphan,
      recoveryBlocked: item.recoveryBlocked,
      reasons: item.reasons
    })),
    unresolvedOrphanCount: enriched.unresolvedOrphanCount,
    ...stateVisibility
  };
}

async function attachPreflight059(pool, pendingFilenames, summary) {
  if (!pendingIncludes059(pendingFilenames)) {
    return summary;
  }

  const preflight059 = await runRegisteredPanDuplicatePreflight(pool);

  return {
    ...summary,
    preflight059
  };
}

function renderInventorySummary(connection, inventory) {
  return {
    connection,
    ledgerTablePresent: inventory.ledgerTablePresent,
    ledgerRowCount: inventory.ledgerRowCount,
    totalFiles: inventory.files.length,
    appliedCount: inventory.applied.length,
    pendingCount: inventory.pending.length,
    driftCount: inventory.drift.length,
    unknownInLedgerCount: inventory.unknownInLedger.length,
    applied: inventory.applied.map((item) => item.filename),
    pending: inventory.pending.map((item) => item.filename),
    drift: inventory.drift,
    unknownInLedger: inventory.unknownInLedger
  };
}

async function commandStatus(pool, migrationsDir, target, flags) {
  const config = resolvePoolConfigFromEnv();
  const connection = describeConnection(config, target);
  const { inventory, enriched } = await loadEnrichedInventory(pool, migrationsDir);
  let summary = appendOrphanFields(
    renderInventorySummary(connection, inventory),
    enriched
  );
  summary = await attachPreflight059(pool, summary.pending, summary);

  if (flags.json) {
    printJson(summary);
    return;
  }

  console.log("Migration status");
  console.log(`  target: ${connection.target}`);
  console.log(`  host: ${connection.host}`);
  console.log(`  database: ${connection.database}`);
  console.log(`  ledger table: ${summary.ledgerTablePresent ? "present" : "missing"}`);
  console.log(`  files: ${summary.totalFiles} | applied: ${summary.appliedCount} | pending: ${summary.pendingCount} | drift: ${summary.driftCount}`);

  if (summary.driftCount > 0) {
    console.log("\nDrift:");
    for (const item of summary.drift) {
      console.log(`  - ${item.filename}`);
    }
  }

  if (summary.normalPending?.length > 0) {
    console.log("\nPending (normal):");
    for (const name of summary.normalPending) {
      console.log(`  - ${name}`);
    }
  }

  if (summary.suspectedOrphans?.length > 0) {
    console.log("\nPending (suspected orphan — migrate:up blocked):");
    for (const item of summary.suspectedOrphans) {
      console.log(`  - ${item.filename} [${item.pendingKind}] ${item.reasons.join("; ")}`);
    }
  }

  if (summary.uncertainPartial?.length > 0) {
    console.log("\nPending (uncertain partial — migrate:up blocked):");
    for (const item of summary.uncertainPartial) {
      console.log(`  - ${item.filename} [${item.reasons.join("; ")}]`);
    }
  }

  if (summary.recoveryBlocked?.length > 0) {
    console.log("\nPending (recovery blocked — migrate:up blocked):");
    for (const item of summary.recoveryBlocked) {
      console.log(`  - ${item.filename} [${item.reasons.join("; ")}]`);
    }
  }

  if (summary.recoveryPersistenceCapable === false) {
    console.log(
      `\nRecovery persistence incomplete (missing tables: ${(summary.missingRecoveryTables || []).join(", ")}).`
    );
  }

  if (summary.preflight059) {
    console.log(`\nPreflight ${MIGRATION_059_FILENAME}:`);
    console.log(`  ok: ${summary.preflight059.ok}`);
    if (!summary.preflight059.ok) {
      console.log(
        `  duplicate PAN groups: ${summary.preflight059.duplicatePanGroups}`
      );
      console.log(
        `  affected REGISTERED rows: ${summary.preflight059.affectedRegisteredRows}`
      );
      if (summary.preflight059.nextStep) {
        console.log(`  next step: ${summary.preflight059.nextStep}`);
      }
    }
  }

  if (!summary.ledgerTablePresent) {
    console.log(
      `\nNote: ledger table is missing. First pending migration should be ${LEDGER_MIGRATION_FILENAME}.`
    );
  }
}

async function commandPlan(pool, migrationsDir, target, flags) {
  const config = resolvePoolConfigFromEnv();
  const connection = describeConnection(config, target);
  const { inventory, enriched } = await loadEnrichedInventory(pool, migrationsDir);

  let payload = appendOrphanFields(
    {
      connection,
      ...renderInventorySummary(connection, inventory),
      nextPending: inventory.pending[0]?.filename || null,
      blockedByDrift: inventory.drift.length > 0
    },
    enriched
  );

  payload = await attachPreflight059(pool, payload.pending, payload);
  payload.blockedByPreflight059 =
    Boolean(payload.preflight059) && payload.preflight059.ok === false;
  payload.blockedByOrphan = payload.unresolvedOrphanCount > 0;

  if (flags.json) {
    printJson(payload);
    return;
  }

  console.log("Migration plan");
  console.log(`  blocked by drift: ${payload.blockedByDrift}`);
  console.log(`  blocked by orphan: ${payload.blockedByOrphan}`);
  console.log(`  blocked by 059 preflight: ${payload.blockedByPreflight059}`);
  console.log(`  next pending: ${payload.nextPending || "(none)"}`);
  console.log(`  pending count: ${payload.pendingCount}`);
  console.log(`  suspected orphan count: ${payload.unresolvedOrphanCount}`);
}

async function commandDryRun(migrationsDir, target, flags, pool) {
  if (flags.offline) {
    const files = listMigrationSqlFiles(migrationsDir);
    const payload = {
      mode: "offline",
      target,
      note:
        "Offline dry-run does not connect to the database. Pending/applied state is unknown.",
      totalFiles: files.length,
      files,
      sqlExecuted: false
    };

    if (flags.json) {
      printJson(payload);
      return;
    }

    console.log("Dry-run (offline)");
    console.log(`  files discovered: ${files.length}`);
    console.log("  SQL execution: none");
    return;
  }

  const config = resolvePoolConfigFromEnv();
  const connection = describeConnection(config, target);
  const { inventory, enriched } = await loadEnrichedInventory(pool, migrationsDir);

  let payload = appendOrphanFields(
    {
      connection,
      mode: "connected-read-only",
      wouldApply: inventory.pending.map((item) => item.filename),
      wouldApplyNormal: enriched.normalPending.map((item) => item.filename),
      blockedByDrift: inventory.drift.length > 0,
      sqlExecuted: false,
      note:
        "Dry-run does not execute migration SQL. It only reports what migrate up would attempt."
    },
    enriched
  );

  payload = await attachPreflight059(pool, payload.wouldApply, payload);
  payload.blockedByPreflight059 =
    Boolean(payload.preflight059) && payload.preflight059.ok === false;
  payload.blockedByOrphan = payload.unresolvedOrphanCount > 0;

  if (flags.json) {
    printJson(payload);
    return;
  }

  console.log("Dry-run");
  console.log(`  target: ${connection.target}`);
  console.log(`  database: ${connection.database}`);
  console.log(`  blocked by drift: ${payload.blockedByDrift}`);
  console.log(`  blocked by orphan: ${payload.blockedByOrphan}`);
  console.log(`  would apply if unblocked (${payload.wouldApply.length}):`);

  for (const name of payload.wouldApply) {
    const orphan = payload.suspectedOrphans.find((item) => item.filename === name);
    const tag = orphan ? " [ORPHAN — blocked]" : "";
    console.log(`    - ${name}${tag}`);
  }

  console.log("  SQL execution: none");
}

async function commandUp(pool, migrationsDir, target, flags) {
  const config = resolvePoolConfigFromEnv();
  assertMutatingTargetAllowed(target, config);

  const connection = describeConnection(config, target);
  const { inventory, enriched } = await loadEnrichedInventory(pool, migrationsDir);

  assertNoDrift(inventory);
  assertNoUnknownInLedger(inventory);

  if (flags.allowRetryFilename) {
    assertMigrationRetryOverrideAllowed(flags.allowRetryFilename);
    console.warn(
      `[migrate:up] retry override acknowledged for ${flags.allowRetryFilename} (uncertain_partial only).`
    );
  }

  assertRecoveryPersistenceForMutate(enriched);

  const pending = filterPendingUpTo(inventory.pending, flags.to);
  let pendingFilenames = pending.map((item) => item.filename);

  if (flags.allowRetryFilename) {
    const allowed = String(flags.allowRetryFilename).trim();
    const assessment = enriched.pendingAssessment.find(
      (item) => item.filename === allowed
    );

    if (!assessment || assessment.pendingKind !== "uncertain_partial") {
      throw new Error(
        `Retry override refused: ${allowed} is not a blocked uncertain_partial migration.`
      );
    }

    assertRetryOrderingAllowed(pending, enriched, allowed);

    pendingFilenames = pendingFilenames.filter((name) => name === allowed);

    if (pendingFilenames.length === 0) {
      throw new Error(
        `Retry override refused: ${allowed} is not in the pending slice selected by migrate:up.`
      );
    }
  }

  assertMigrateUpAllowedForPending(enriched, {
    allowRetryFilename: flags.allowRetryFilename,
    pendingFilenames
  });

  if (pendingIncludes059(pendingFilenames)) {
    const preflight059 = await runRegisteredPanDuplicatePreflight(pool);
    assertPreflight059AllowsMigration(preflight059);
  }

  if (pending.length === 0) {
    const payload = { connection, applied: [], message: "No pending migrations." };

    if (flags.json) {
      printJson(payload);
      return;
    }

    console.log("No pending migrations.");
    return;
  }

  const applied = await applyPendingMigrations(pool, {
    migrationsDir,
    pendingFilenames,
    onApplied: (result) => {
      if (!flags.json) {
        console.log(`✅ Applied ${result.filename} (${result.durationMs}ms)`);
      }
    }
  });

  const payload = { connection, applied };

  if (flags.json) {
    printJson(payload);
  } else {
    console.log(`\nApplied ${applied.length} migration(s).`);
  }
}

async function commandVerify(pool, migrationsDir, target, flags) {
  const config = resolvePoolConfigFromEnv();
  const connection = describeConnection(config, target);
  const { inventory, enriched, manifest } = await loadEnrichedInventory(
    pool,
    migrationsDir
  );

  const fingerprintResults = [];

  for (const item of inventory.applied) {
    const entry = manifest.fingerprints?.[item.filename];

    if (!entry?.checks?.length) {
      fingerprintResults.push({
        filename: item.filename,
        configured: false,
        ok: null
      });
      continue;
    }

    const evaluation = await evaluateFilenameFingerprints(
      pool,
      manifest,
      item.filename
    );

    fingerprintResults.push({
      filename: item.filename,
      configured: true,
      ok: evaluation.allPass
    });
  }

  const verifyOutcome = computeVerifyOutcome({
    inventory,
    enriched,
    fingerprintResults
  });
  const {
    ok,
    verification,
    insufficientFingerprintCoverage,
    fingerprintCheckFailed,
    stateVisibility
  } = verifyOutcome;

  const payload = {
    connection,
    ok,
    verification,
    drift: inventory.drift,
    unknownInLedger: inventory.unknownInLedger,
    pendingMigrations: inventory.pending.map((item) => item.filename),
    fingerprintResults,
    insufficientFingerprintCoverage,
    fingerprintCheckFailed,
    suspectedOrphans: enriched.suspectedOrphans.map((item) => ({
      filename: item.filename,
      pendingKind: item.pendingKind,
      reasons: item.reasons
    })),
    unresolvedOrphanCount: enriched.unresolvedOrphanCount,
    ...stateVisibility
  };

  if (flags.json) {
    printJson(payload);
  } else {
    console.log(`Verify: ${ok ? "PASS" : "FAIL"} (${verification.primaryOutcome})`);
    for (const issue of verification.issues) {
      if (issue.code === VERIFY_OUTCOME.CHECKSUM_DRIFT) {
        console.log(`  drift: ${issue.filenames.join(", ")}`);
      } else if (issue.code === VERIFY_OUTCOME.UNKNOWN_IN_LEDGER) {
        console.log(`  unknown in ledger: ${issue.filenames.join(", ")}`);
      } else if (issue.code === VERIFY_OUTCOME.RECOVERY_PERSISTENCE_MISSING) {
        console.log(
          `  recovery persistence tables missing: ${issue.missingTables.join(", ")}`
        );
      } else if (issue.code === VERIFY_OUTCOME.RECOVERY_BLOCKED) {
        console.log(`  recovery blocked: ${issue.filenames.join(", ")}`);
      } else if (issue.code === VERIFY_OUTCOME.SUSPECTED_ORPHAN) {
        console.log(`  suspected orphans: ${issue.filenames.join(", ")}`);
      } else if (issue.code === VERIFY_OUTCOME.UNCERTAIN_PARTIAL) {
        console.log(`  uncertain partial: ${issue.filenames.join(", ")}`);
      } else if (issue.code === VERIFY_OUTCOME.PENDING_MIGRATIONS) {
        console.log(`  pending migrations: ${issue.filenames.join(", ")}`);
      } else if (issue.code === VERIFY_OUTCOME.INSUFFICIENT_FINGERPRINT_COVERAGE) {
        console.log(
          `  insufficient fingerprint coverage: ${issue.filenames.join(", ")}`
        );
      } else if (issue.code === VERIFY_OUTCOME.FINGERPRINT_CHECK_FAILED) {
        console.log(`  fingerprint check failed: ${issue.filenames.join(", ")}`);
      }
    }
  }

  if (!ok) {
    process.exitCode = 1;
  }
}

async function commandBaselinePlan(pool, migrationsDir, target, flags) {
  const config = resolvePoolConfigFromEnv();
  const connection = describeConnection(config, target);
  const { inventory } = await loadInventory(pool, migrationsDir);
  const manifest = getEffectiveManifest(migrationsDir);
  const plan = await buildBaselinePlan(pool, manifest, inventory);

  const payload = {
    connection,
    ...plan
  };

  if (flags.json) {
    printJson(payload);
    return;
  }

  console.log("Baseline plan (read-only)");
  console.log(`  adoption enabled: ${plan.adoptionEnabled}`);
  console.log(`  ${plan.note}`);

  for (const item of plan.recommendations) {
    console.log(
      `  - ${item.filename}: ledger=${item.ledgerStatus} recommendation=${item.recommendation}`
    );
  }
}

async function commandRepairLedger(pool, migrationsDir, target, flags) {
  const config = resolvePoolConfigFromEnv();
  assertMutatingTargetAllowed(target, config);

  const filename = String(flags.filename || "").trim();

  if (!filename) {
    throw new Error("repair-ledger requires --filename <migration-file.sql>");
  }

  const { enriched } = await loadEnrichedInventory(pool, migrationsDir);
  assertRecoveryPersistenceForMutate(enriched);

  const connection = describeConnection(config, target);
  const result = await withAdvisoryLock(pool, async (client) =>
    repairLedgerForFilename(client, migrationsDir, filename)
  );

  const payload = {
    connection,
    ...result
  };

  if (flags.json) {
    printJson(payload);
    return;
  }

  console.log(`✅ Ledger repaired for ${result.filename} (migration SQL was not executed).`);
}

async function commandBaselineAdopt(pool, migrationsDir, target, flags) {
  const filename = String(flags.filename || "").trim();

  if (!filename) {
    throw new Error("baseline-adopt requires --filename <migration-file.sql>.");
  }

  if (flags.dryRun && flags.confirm) {
    throw new Error("baseline-adopt requires exactly one of --dry-run or --confirm.");
  }

  if (!flags.dryRun && !flags.confirm) {
    throw new Error("baseline-adopt requires --dry-run or --confirm.");
  }

  const config = resolvePoolConfigFromEnv();
  const connection = describeConnection(config, target);

  if (flags.dryRun) {
    const payload = {
      connection,
      ...(await dryRunBaselineAdopt(pool, migrationsDir, filename))
    };

    if (flags.json) {
      printJson(payload);
    } else {
      console.log(`Baseline adopt (dry-run): ${payload.eligible ? "ELIGIBLE" : "REFUSED"}`);
      if (payload.refusalReasons?.length) {
        for (const reason of payload.refusalReasons) {
          console.log(`  - ${reason}`);
        }
      }
      console.log(`  migrationSqlExecuted: false`);
    }

    if (!payload.eligible) {
      process.exitCode = 1;
    }

    return;
  }

  assertMutatingTargetAllowed(target, config);
  assertBaselineAdoptConfirmAllowed(filename);

  const payload = {
    connection,
    ...(await confirmBaselineAdopt(pool, migrationsDir, filename))
  };

  if (flags.json) {
    printJson(payload);
  } else {
    console.log(`✅ Baseline adopt recorded ledger for ${payload.filename} (migration SQL was not executed).`);
  }
}

function printHelp() {
  console.log(`Optalynx migration CLI

Commands:
  status          Read-only ledger and pending/drift summary (requires DB)
  plan            Read-only next steps and drift blocking state
  dry-run         No DDL/DML; use --offline to avoid DB connection
  up              Apply pending migrations only (mutating; drift/orphan blocked)
                  Optional: --allow-retry-filename <file> with OPTALYNX_MIGRATE_ALLOW_RETRY_CONFIRM
  repair-ledger   Record ledger row after fingerprint verify (no migration SQL)
  verify          Drift, orphan, and fingerprint checks (no misleading PASS)
  baseline-plan   Read-only adoption recommendations (adoption disabled)
  baseline-adopt  Adopt one pending migration into the ledger (no SQL); --dry-run or --confirm
                  Confirm: ${BASELINE_ADOPT_CONFIRM_ENV}=<I_ADOPT_LEDGER_RECORD_FOR_<file.sql>>

Environment:
  OPTALYNX_DB_TARGET=local|neon   Required for connected commands
  OPTALYNX_MIGRATE_CONFIRM=I_UNDERSTAND_PRODUCTION   Required for neon mutate

Legacy:
  npm run migrate:master-data (and similar) are blocked; use migrate:up.
  Standalone apply*.js runners are blocked for the same reason.

Documentation:
  docs/database-migrations-runbook.md
`);
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const migrationsDir = resolveMigrationsDir();

  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  const readOnlyCommands = new Set([
    "status",
    "plan",
    "verify",
    "baseline-plan"
  ]);
  const needsPool = command !== "help" && !(command === "dry-run" && flags.offline);

  if (command === "dry-run" && flags.offline) {
    const target = process.env.OPTALYNX_DB_TARGET || "unspecified";
    await commandDryRun(migrationsDir, target, flags, null);
    return;
  }

  let pool = null;
  let target = null;

  try {
    if (needsPool) {
      target = requireDbTarget();
      const config = resolvePoolConfigFromEnv();

      if (command === "up" || command === "repair-ledger") {
        assertMutatingTargetAllowed(target, config);
      } else if (command === "baseline-adopt" && flags.confirm) {
        assertMutatingTargetAllowed(target, config);
      } else if (
        readOnlyCommands.has(command) ||
        command === "dry-run" ||
        (command === "baseline-adopt" && flags.dryRun)
      ) {
        assertReadOnlyTargetAllowed(target, config);
      } else if (command === "baseline-adopt") {
        throw new Error("baseline-adopt requires --dry-run or --confirm.");
      }

      pool = createPool();
    }

    if (command === "status") {
      await commandStatus(pool, migrationsDir, target, flags);
      return;
    }

    if (command === "plan") {
      await commandPlan(pool, migrationsDir, target, flags);
      return;
    }

    if (command === "dry-run") {
      await commandDryRun(migrationsDir, target, flags, pool);
      return;
    }

    if (command === "up") {
      await commandUp(pool, migrationsDir, target, flags);
      return;
    }

    if (command === "repair-ledger") {
      await commandRepairLedger(pool, migrationsDir, target, flags);
      return;
    }

    if (command === "verify") {
      await commandVerify(pool, migrationsDir, target, flags);
      return;
    }

    if (command === "baseline-plan") {
      await commandBaselinePlan(pool, migrationsDir, target, flags);
      return;
    }

    if (command === "baseline-adopt") {
      await commandBaselineAdopt(pool, migrationsDir, target, flags);
      return;
    }

    console.error(`Unknown command: ${command}`);
    printHelp();
    process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    if (pool) {
      await pool.end().catch(() => {});
    }
  }
}

main();
