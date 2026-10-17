const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, it, beforeEach, afterEach } = require("node:test");

const {
  sqlManagesOwnTransaction,
  buildExecutionSql,
  listMigrationSqlFiles,
  checksumSha256
} = require("./lib/migrationFiles");
const {
  assertReadOnlyTargetAllowed,
  assertMutatingTargetAllowed,
  assertMigrationRetryOverrideAllowed,
  ALLOW_RETRY_CONFIRM_ENV,
  ALLOW_RETRY_CONFIRM_VALUE,
  classifyHost
} = require("./lib/migrationGuards");
const { computeMigrationInventory, assertNoDrift } = require("./lib/migrationLedger");
const { assertNoUnknownInLedger } = require("./lib/migrationLedgerRecordGuards");
const {
  withAdvisoryLock,
  applySingleMigration,
  applyPendingMigrations
} = require("./lib/migrationRunner");
const {
  assertMigrateUpAllowedForPending,
  buildRepairEligibility,
  classifyPendingKind
} = require("./lib/migrationOrphans");
const { repairLedgerForFilename } = require("./lib/migrationRepair");
const { enrichInventoryWithOrphanState } = require("./lib/migrationOrphans");
const {
  runRegisteredPanDuplicatePreflight,
  assertPreflight059AllowsMigration,
  DUPLICATE_PAN_SUMMARY_SQL,
  MIGRATION_059_FILENAME
} = require("./lib/migrationPreflight059");
const { MigrationConsistencyError } = require("./lib/migrationErrors");
const { spawnSync } = require("node:child_process");
const {
  buildBaselinePlan,
  loadBaselineManifest,
  getEffectiveManifest,
  evaluateFilenameFingerprints,
  runFingerprintCheck
} = require("./lib/migrationBaseline");
const { assertRetryOrderingAllowed } = require("./lib/migrationRetryOrder");
const {
  assertRecoveryPersistenceForMutate,
  evaluateRecoveryPersistenceCapability
} = require("./lib/migrationRecoveryBlocks");
const {
  DEFAULT_MIGRATIONS_DIR,
  LEDGER_MIGRATION_FILENAME,
  MIGRATIONS_DIR_ENV,
  resolveMigrationsDir
} = require("./lib/migrationConstants");
function prepareLedgerFixtureDir(extraFilenames = []) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "optalynx-mig-test-"));
  fs.copyFileSync(
    path.join(DEFAULT_MIGRATIONS_DIR, LEDGER_MIGRATION_FILENAME),
    path.join(tempDir, LEDGER_MIGRATION_FILENAME)
  );

  for (const name of extraFilenames) {
    fs.copyFileSync(
      path.join(DEFAULT_MIGRATIONS_DIR, name),
      path.join(tempDir, name)
    );
  }

  return tempDir;
}

function appliedLedgerRow(migrationsDir, filename) {
  const { fileChecksum } = require("./lib/migrationFiles");
  return {
    filename,
    checksum_sha256: fileChecksum(migrationsDir, filename),
    applied_at: new Date(),
    applied_by: "tester",
    duration_ms: 1
  };
}

function localConfig(database = "ats_dev") {
  return {
    host: "localhost",
    port: 5432,
    user: "postgres",
    password: "x",
    database
  };
}

describe("migrationGuards", () => {
  it("rejects local target against neon host", () => {
    assert.throws(
      () =>
        assertReadOnlyTargetAllowed("local", {
          host: "ep-example.neon.tech",
          database: "ats_dev"
        }),
      /not a local host/
    );
  });

  it("rejects neon target against localhost", () => {
    assert.throws(
      () =>
        assertReadOnlyTargetAllowed("neon", {
          host: "localhost",
          database: "neondb"
        }),
      /does not match Neon/
    );
  });

  it("requires production confirmation for neon mutate", () => {
    const prev = process.env.OPTALYNX_MIGRATE_CONFIRM;
    delete process.env.OPTALYNX_MIGRATE_CONFIRM;

    assert.throws(
      () =>
        assertMutatingTargetAllowed("neon", {
          host: "ep-example.neon.tech",
          database: "neondb"
        }),
      /OPTALYNX_MIGRATE_CONFIRM/
    );

    process.env.OPTALYNX_MIGRATE_CONFIRM = prev;
  });

  it("classifies neon.tech hosts", () => {
    assert.equal(classifyHost("ep-foo.neon.tech"), "neon");
    assert.equal(classifyHost("localhost"), "local");
  });
});

describe("migration directory resolution", () => {
  it("defaults to the repository migrations folder when env override is unset", () => {
    const prev = process.env[MIGRATIONS_DIR_ENV];
    delete process.env[MIGRATIONS_DIR_ENV];
    assert.equal(resolveMigrationsDir(), DEFAULT_MIGRATIONS_DIR);
    if (prev === undefined) {
      delete process.env[MIGRATIONS_DIR_ENV];
    } else {
      process.env[MIGRATIONS_DIR_ENV] = prev;
    }
  });
});

describe("migrationFiles", () => {
  it("detects self-managed transactions", () => {
    const sql = "BEGIN;\nSELECT 1;\nCOMMIT;";
    assert.equal(sqlManagesOwnTransaction(sql), true);
    assert.equal(buildExecutionSql(sql).wrapped, false);
  });

  it("wraps files without transaction boundaries", () => {
    const sql = "SELECT 1;";
    const built = buildExecutionSql(sql);
    assert.equal(built.wrapped, true);
    assert.match(built.sql, /^BEGIN;/);
    assert.match(built.sql, /COMMIT;$/);
  });

  it("orders duplicate 049_* files lexicographically", () => {
    const files = listMigrationSqlFiles(DEFAULT_MIGRATIONS_DIR);
    const idxEmployee = files.indexOf("049_employee_lifecycle_responsibility_v1.sql");
    const idxHiring = files.indexOf("049_hiring_manager_employee_code_binding.sql");

    assert.notEqual(idxEmployee, -1);
    assert.notEqual(idxHiring, -1);
    assert.ok(idxEmployee < idxHiring);
  });
});

describe("migrationLedger inventory", () => {
  it("reports pending when ledger is empty", () => {
    const inventory = computeMigrationInventory(DEFAULT_MIGRATIONS_DIR, {
      tableExists: false,
      rows: []
    });

    assert.ok(inventory.pending.length > 0);
    assert.equal(inventory.applied.length, 0);
    assert.equal(inventory.pending[0].filename, "000_schema_migration_ledger.sql");
  });

  it("detects checksum drift", () => {
    const filename = inventoryFirstFile();
    const fakeChecksum = "0".repeat(64);
    const inventory = computeMigrationInventory(DEFAULT_MIGRATIONS_DIR, {
      tableExists: true,
      rows: [{ filename, checksum_sha256: fakeChecksum }]
    });

    assert.equal(inventory.drift.length, 1);
    assert.throws(() => assertNoDrift(inventory), /drift/i);
  });

  it("reports unknown ledger filenames absent from the migrations directory", () => {
    const filename = inventoryFirstFile();
    const { fileChecksum } = require("./lib/migrationFiles");
    const checksum = fileChecksum(DEFAULT_MIGRATIONS_DIR, filename);
    const inventory = computeMigrationInventory(DEFAULT_MIGRATIONS_DIR, {
      tableExists: true,
      rows: [
        { filename, checksum_sha256: checksum },
        { filename: "999_removed_from_repo.sql", checksum_sha256: checksum }
      ]
    });

    assert.equal(inventory.unknownInLedger.length, 1);
    assert.equal(inventory.unknownInLedger[0].filename, "999_removed_from_repo.sql");
  });

  it("migrate:up inventory gates fail closed on unknown ledger rows (same as verify/repair)", () => {
    const inventory = {
      drift: [],
      unknownInLedger: [{ filename: "999_legacy.sql" }]
    };

    assert.throws(() => {
      assertNoDrift(inventory);
      assertNoUnknownInLedger(inventory);
    }, /999_legacy\.sql/);
  });

  it("treats matching checksum as applied", () => {
    const filename = "000_schema_migration_ledger.sql";
    const { fileChecksum } = require("./lib/migrationFiles");
    const checksum = fileChecksum(DEFAULT_MIGRATIONS_DIR, filename);
    const inventory = computeMigrationInventory(DEFAULT_MIGRATIONS_DIR, {
      tableExists: true,
      rows: [{ filename, checksum_sha256: checksum }]
    });

    assert.equal(inventory.pending.length, inventory.files.length - 1);
    assert.equal(inventory.applied.length, 1);
  });
});

function inventoryFirstFile() {
  return listMigrationSqlFiles(DEFAULT_MIGRATIONS_DIR)[0];
}

describe("migrationRunner", () => {
  it("fails when advisory lock is not acquired", async () => {
    const pool = {
      connect: async () => ({
        query: async (sql) => {
          if (String(sql).includes("pg_try_advisory_lock")) {
            return { rows: [{ acquired: false }] };
          }
          return { rows: [] };
        },
        release: () => {}
      })
    };

    await assert.rejects(
      () => withAdvisoryLock(pool, async () => "ok"),
      /advisory lock/
    );
  });

  it("records ledger only after SQL succeeds", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "optalynx-mig-"));
    const filename = "001_test.sql";
    fs.writeFileSync(path.join(tempDir, filename), "BEGIN;\nSELECT 1;\nCOMMIT;\n", "utf8");

    const calls = [];
    const client = {
      query: async (sql) => {
        calls.push(String(sql));
        if (String(sql).includes("pg_try_advisory_lock")) {
          return { rows: [{ acquired: true }] };
        }
        if (String(sql).trim() === "BEGIN;") {
          return { rows: [] };
        }
        if (String(sql).includes("INSERT INTO schema_migrations")) {
          return { rows: [{ filename: "001_test.sql" }], rowCount: 1 };
        }
        if (String(sql).includes("SELECT checksum_sha256")) {
          const { fileChecksum } = require("./lib/migrationFiles");
          return {
            rows: [{ checksum_sha256: fileChecksum(tempDir, filename) }],
            rowCount: 1
          };
        }
        return { rows: [] };
      },
      release: () => {}
    };

    await applySingleMigration(client, {
      migrationsDir: tempDir,
      filename,
      appliedBy: "test"
    });

    const sqlIndex = calls.findIndex((item) => item.includes("SELECT 1"));
    const insertIndex = calls.findIndex((item) =>
      item.includes("INSERT INTO schema_migrations")
    );

    assert.ok(sqlIndex >= 0);
    assert.ok(insertIndex > sqlIndex);

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("does not record ledger when SQL fails", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "optalynx-mig-"));
    const filename = "001_fail.sql";
    fs.writeFileSync(path.join(tempDir, filename), "BEGIN;\nSELECT oops;\nCOMMIT;\n", "utf8");

    const client = {
      query: async (sql) => {
        if (String(sql).includes("SELECT oops")) {
          throw new Error("syntax error");
        }
        return { rows: [] };
      }
    };

    await assert.rejects(
      () =>
        applySingleMigration(client, {
          migrationsDir: tempDir,
          filename
        }),
      (error) => error.code === "MIGRATION_SQL_FAILED"
    );

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("uses one transaction for non-self-managed SQL and ledger", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "optalynx-mig-"));
    const filename = "001_plain.sql";
    fs.writeFileSync(path.join(tempDir, filename), "SELECT 1;\n", "utf8");

    const calls = [];
    const client = {
      query: async (sql) => {
        calls.push(String(sql).trim());
        if (String(sql).includes("INSERT INTO schema_migrations")) {
          return { rows: [{ filename }], rowCount: 1 };
        }
        if (String(sql).includes("SELECT checksum_sha256")) {
          const { fileChecksum } = require("./lib/migrationFiles");
          return {
            rows: [{ checksum_sha256: fileChecksum(tempDir, filename) }],
            rowCount: 1
          };
        }
        return { rows: [] };
      }
    };

    await applySingleMigration(client, {
      migrationsDir: tempDir,
      filename,
      appliedBy: "test"
    });

    const beginIndexes = calls
      .map((item, index) => (item === "BEGIN" || item === "BEGIN;" ? index : -1))
      .filter((index) => index >= 0);
    assert.equal(beginIndexes.length, 1);
    assert.ok(calls[0].startsWith("BEGIN"));

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("throws MIGRATION_LEDGER_ORPHAN when ledger write fails after self-managed SQL", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "optalynx-mig-"));
    const filename = "001_self.sql";
    fs.writeFileSync(path.join(tempDir, filename), "BEGIN;\nSELECT 1;\nCOMMIT;\n", "utf8");

    const client = {
      query: async (sql) => {
        if (
          String(sql).includes("information_schema.tables") &&
          String(sql).includes("table_name = $1")
        ) {
          return { rows: [{ exists: true }] };
        }
        if (String(sql).includes("INSERT INTO schema_migrations")) {
          throw new Error("ledger insert failed");
        }
        if (String(sql).includes("INSERT INTO schema_migration_orphans")) {
          return { rows: [] };
        }
        return { rows: [] };
      }
    };

    await assert.rejects(
      () =>
        applySingleMigration(client, {
          migrationsDir: tempDir,
          filename
        }),
      (error) => error.code === "MIGRATION_LEDGER_ORPHAN"
    );

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("releases advisory lock when inner work throws", async () => {
    const unlockCalls = [];
    const pool = {
      connect: async () => ({
        query: async (sql) => {
          if (String(sql).includes("pg_try_advisory_lock")) {
            return { rows: [{ acquired: true }] };
          }
          if (String(sql).includes("pg_advisory_unlock")) {
            unlockCalls.push(sql);
            return { rows: [{ released: true }] };
          }
          return { rows: [] };
        },
        release: () => {}
      })
    };

    await assert.rejects(
      () =>
        withAdvisoryLock(pool, async () => {
          throw new Error("inner failure");
        }),
      /inner failure/
    );

    assert.equal(unlockCalls.length, 1);
  });

  it("destroys client when advisory unlock reports failure", async () => {
    let endCalled = false;
    let releaseCalled = false;
    const pool = {
      connect: async () => ({
        query: async (sql) => {
          if (String(sql).includes("pg_try_advisory_lock")) {
            return { rows: [{ acquired: true }] };
          }
          if (String(sql).includes("pg_advisory_unlock")) {
            return { rows: [{ released: false }] };
          }
          return { rows: [] };
        },
        release: () => {
          releaseCalled = true;
        },
        end: async () => {
          endCalled = true;
        }
      })
    };

    await withAdvisoryLock(pool, async () => "ok");
    assert.equal(endCalled, true);
    assert.equal(releaseCalled, false);
  });

  it("records orphan metadata when ledger write fails after self-managed SQL", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "optalynx-mig-"));
    const filename = "001_self.sql";
    fs.writeFileSync(path.join(tempDir, filename), "BEGIN;\nSELECT 1;\nCOMMIT;\n", "utf8");

    const orphanWrites = [];
    const client = {
      query: async (sql) => {
        if (String(sql).includes("INSERT INTO schema_migration_orphans")) {
          orphanWrites.push(sql);
          return { rows: [] };
        }
        if (
          String(sql).includes("information_schema.tables") &&
          String(sql).includes("table_name = $1")
        ) {
          return { rows: [{ exists: true }] };
        }
        if (String(sql).includes("INSERT INTO schema_migrations")) {
          throw new Error("ledger insert failed");
        }
        return { rows: [] };
      }
    };

    await assert.rejects(
      () =>
        applySingleMigration(client, {
          migrationsDir: tempDir,
          filename
        }),
      (error) => error.code === "MIGRATION_LEDGER_ORPHAN"
    );

    assert.equal(orphanWrites.length, 1);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("stops partial batches after failure without reporting later files applied", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "optalynx-mig-"));
    fs.writeFileSync(
      path.join(tempDir, "001_a.sql"),
      "BEGIN;\nSELECT 1;\nCOMMIT;\n",
      "utf8"
    );
    fs.writeFileSync(
      path.join(tempDir, "002_b.sql"),
      "BEGIN;\nSELECT fail;\nCOMMIT;\n",
      "utf8"
    );

    const applied = [];
    const pool = {
      connect: async () => ({
        query: async (sql) => {
          if (String(sql).includes("pg_try_advisory_lock")) {
            return { rows: [{ acquired: true }] };
          }
          if (String(sql).includes("pg_advisory_unlock")) {
            return { rows: [{ released: true }] };
          }
          if (String(sql).includes("SELECT fail")) {
            throw new Error("sql failed");
          }
          if (String(sql).includes("INSERT INTO schema_migrations")) {
            return { rows: [{ filename: "001_a.sql" }], rowCount: 1 };
          }
          if (String(sql).includes("SELECT checksum_sha256")) {
            const { fileChecksum } = require("./lib/migrationFiles");
            return {
              rows: [{ checksum_sha256: fileChecksum(tempDir, "001_a.sql") }],
              rowCount: 1
            };
          }
          if (String(sql).includes("schema_migration_orphans")) {
            return { rows: [{ exists: false }] };
          }
          return { rows: [] };
        },
        release: () => {}
      })
    };

    await assert.rejects(
      () =>
        applyPendingMigrations(pool, {
          migrationsDir: tempDir,
          pendingFilenames: ["001_a.sql", "002_b.sql"],
          onApplied: (result) => applied.push(result.filename)
        }),
      (error) => error.code === "MIGRATION_SQL_FAILED"
    );

    assert.deepEqual(applied, ["001_a.sql"]);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});

describe("orphan recovery controls", () => {
  it("blocks migrate:up when suspected orphan evidence exists", () => {
    assert.throws(
      () =>
        assertMigrateUpAllowedForPending({
          suspectedOrphans: [
            {
              filename: "056_rm_headcount_change_history.sql",
              reasons: ["persistent orphan record (schema_migration_orphans)"]
            }
          ]
        }),
      /migrate:up blocked/
    );
  });

  it("refuses repair when fingerprint evidence is insufficient", () => {
    const assessment = {
      suspectedOrphan: true,
      recordedOrphan: true,
      checksum: "abc",
      fingerprint: { fingerprintConfigured: false, allPass: null }
    };

    const result = buildRepairEligibility(assessment, "abc");
    assert.equal(result.eligible, false);
  });

  it("repair-ledger never executes migration SQL (mocked ledger write only)", async () => {
    const filename = "056_rm_headcount_change_history.sql";
    const migrationsDir = prepareLedgerFixtureDir([filename]);

    const sqlCalls = [];
    const pool = {
      query: async (sql, params) => {
        sqlCalls.push(String(sql));
        if (String(sql).trim() === "BEGIN" || String(sql).trim() === "COMMIT") {
          return { rows: [] };
        }
        if (String(sql).includes("information_schema.tables")) {
          return { rows: [{ exists: true }] };
        }
        if (String(sql).includes("to_regclass")) {
          return { rows: [{ reg: "rm_headcount_change_history" }] };
        }
        if (String(sql).includes("INSERT INTO schema_migrations")) {
          return { rows: [{ filename }], rowCount: 1 };
        }
        if (
          String(sql).includes("checksum_sha256") &&
          String(sql).includes("WHERE filename = $1")
        ) {
          const { fileChecksum } = require("./lib/migrationFiles");
          return {
            rows: [
              {
            checksum_sha256: fileChecksum(migrationsDir, filename)
          }
        ],
        rowCount: 1
      };
    }
    if (
      String(sql).includes("FROM schema_migrations") &&
      String(sql).includes("ORDER BY filename")
    ) {
      return {
        rows: [appliedLedgerRow(migrationsDir, LEDGER_MIGRATION_FILENAME)],
        rowCount: 1
      };
    }
    if (String(sql).includes("schema_migration_orphans")) {
      if (String(sql).includes("UPDATE")) {
        return { rowCount: 1, rows: [] };
      }
      if (
        String(sql).includes("WHERE resolved_at IS NULL") &&
        !String(sql).includes("information_schema")
      ) {
        return {
          rows: [
            {
              filename,
              checksum_sha256: fileChecksum(migrationsDir, filename)
            }
          ]
        };
      }
      return { rows: [], rowCount: 0 };
    }
    if (String(sql).includes("schema_migration_recovery_blocks")) {
          if (String(sql).includes("information_schema")) {
            return { rows: [{ exists: true }] };
          }
          return { rows: [] };
        }
        if (String(sql).includes("information_schema.columns")) {
          return { rows: [{ exists: true }] };
        }
        if (String(sql).includes("pg_indexes")) {
          return { rows: [{ exists: true }] };
        }
        if (String(sql).includes("pg_constraint")) {
          return { rows: [{ exists: true }] };
        }
        if (String(sql).includes("COUNT(*)")) {
          return { rows: [{ c: 10 }] };
        }
        return { rows: [] };
      }
    };

    const { readMigrationSql, fileChecksum } = require("./lib/migrationFiles");
    const migrationSql = readMigrationSql(migrationsDir, filename).trim();

    const result = await repairLedgerForFilename(
      pool,
      migrationsDir,
      filename,
      "tester"
    );
    assert.equal(result.migrationSqlExecuted, false);
    assert.ok(!sqlCalls.some((call) => call.trim() === migrationSql));
    fs.rmSync(migrationsDir, { recursive: true, force: true });
  });

  it("repair-ledger refuses when an earlier migration is still pending", async () => {
    const migrationsDir = prepareLedgerFixtureDir([
      "056_rm_headcount_change_history.sql",
      "057_rm_budget_change_history.sql"
    ]);
    const pool = {
      query: async (sql) => {
        const text = String(sql);
        if (text.includes("FROM schema_migrations") && text.includes("ORDER BY")) {
          return {
            rows: [appliedLedgerRow(migrationsDir, LEDGER_MIGRATION_FILENAME)]
          };
        }
        if (text.includes("information_schema.tables")) {
          return { rows: [{ exists: true }] };
        }
        if (text.includes("schema_migration_orphans")) {
          return { rows: [] };
        }
        if (text.includes("schema_migration_recovery_blocks")) {
          if (text.includes("information_schema")) {
            return { rows: [{ exists: true }] };
          }
          return { rows: [] };
        }
        if (text.includes("to_regclass")) {
          return { rows: [{ reg: "rm_budget_change_history" }] };
        }
        return { rows: [] };
      }
    };

    await assert.rejects(
      () =>
        repairLedgerForFilename(
          pool,
          migrationsDir,
          "057_rm_budget_change_history.sql",
          "tester"
        ),
      /earlier pending migrations must be resolved/
    );

    fs.rmSync(migrationsDir, { recursive: true, force: true });
  });

  it("repair-ledger refuses when unknown ledger rows exist", async () => {
    const migrationsDir = prepareLedgerFixtureDir([
      "056_rm_headcount_change_history.sql"
    ]);
    const pool = {
      query: async (sql) => {
        const text = String(sql);
        if (text.includes("FROM schema_migrations") && text.includes("ORDER BY")) {
          return {
            rows: [
              appliedLedgerRow(migrationsDir, LEDGER_MIGRATION_FILENAME),
              {
                filename: "999_unknown_migration.sql",
                checksum_sha256: "f".repeat(64),
                applied_at: new Date(),
                applied_by: "tester",
                duration_ms: 1
              }
            ]
          };
        }
        if (text.includes("information_schema.tables")) {
          return { rows: [{ exists: true }] };
        }
        return { rows: [] };
      }
    };

    await assert.rejects(
      () => repairLedgerForFilename(pool, migrationsDir, "056_rm_headcount_change_history.sql"),
      /unknown schema_migrations row/
    );

    fs.rmSync(migrationsDir, { recursive: true, force: true });
  });

  it("verify-style enrichment fails when orphan is suspected", async () => {
    const manifest = loadBaselineManifest();
    const inventory = computeMigrationInventory(DEFAULT_MIGRATIONS_DIR, {
      tableExists: true,
      rows: []
    });

    const queryable = {
      query: async (sql) => {
        if (String(sql).includes("schema_migration_orphans")) {
          if (String(sql).includes("information_schema.tables")) {
            return { rows: [{ exists: true }] };
          }
          return { rows: [{ filename: "004_workflow_engine_schema.sql" }] };
        }
        if (String(sql).includes("to_regclass")) {
          return { rows: [{ reg: "wf_instances" }] };
        }
        if (String(sql).includes("information_schema.columns")) {
          return { rows: [{ exists: true }] };
        }
        return { rows: [] };
      }
    };

    const enriched = await enrichInventoryWithOrphanState(
      queryable,
      manifest,
      inventory
    );

    assert.ok(enriched.unresolvedOrphanCount > 0);
    const verifyOk =
      inventory.drift.length === 0 && enriched.unresolvedOrphanCount === 0;
    assert.equal(verifyOk, false);
  });
});

describe("legacy migration guard", () => {
  it("blocks runMigrations.js without connecting", () => {
    const result = spawnSync(process.execPath, ["scripts/runMigrations.js"], {
      cwd: path.join(__dirname, ".."),
      encoding: "utf8"
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Legacy schema migration blocked/);
    assert.match(result.stderr, /migrate:up/);
  });

  it("blocks apply052 runner", () => {
    const result = spawnSync(
      process.execPath,
      ["scripts/apply052NotificationDeliveriesMigration.js"],
      { cwd: path.join(__dirname, ".."), encoding: "utf8" }
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /052_notification_deliveries_schema.sql/);
  });
});

describe("preflight 059", () => {
  it("uses migration-aligned duplicate PAN summary SQL", () => {
    assert.match(DUPLICATE_PAN_SUMMARY_SQL, /UPPER\(TRIM\(candidate_status\)\) = 'REGISTERED'/);
    assert.match(DUPLICATE_PAN_SUMMARY_SQL, /UPPER\(TRIM\(pan_number\)\)/);
    assert.match(DUPLICATE_PAN_SUMMARY_SQL, /TRIM\(pan_number\) <> ''/);
  });

  it("passes when no duplicate groups exist", async () => {
    const result = await runRegisteredPanDuplicatePreflight({
      query: async (sql) => {
        if (String(sql).includes("information_schema.tables")) {
          return { rows: [{ exists: true }] };
        }
        return {
          rows: [{ duplicate_pan_groups: 0, affected_registered_rows: 0 }]
        };
      }
    });

    assert.equal(result.ok, true);
  });

  it("blocks when duplicate groups exist without exposing PAN values", async () => {
    const result = await runRegisteredPanDuplicatePreflight({
      query: async (sql) => {
        if (String(sql).includes("information_schema.tables")) {
          return { rows: [{ exists: true }] };
        }
        return {
          rows: [{ duplicate_pan_groups: 2, affected_registered_rows: 5 }]
        };
      }
    });

    assert.equal(result.ok, false);
    assert.equal(result.duplicatePanGroups, 2);
    assert.equal(result.affectedRegisteredRows, 5);
    assert.throws(
      () => assertPreflight059AllowsMigration(result),
      /Duplicate PAN groups: 2/
    );
    assert.throws(
      () => assertPreflight059AllowsMigration(result),
      (error) => !String(error.message).includes("ABCDE")
    );
  });

  it("treats null duplicate summary as clean", async () => {
    const result = await runRegisteredPanDuplicatePreflight({
      query: async (sql) => {
        if (String(sql).includes("information_schema.tables")) {
          return { rows: [{ exists: true }] };
        }
        return { rows: [{ duplicate_pan_groups: null, affected_registered_rows: null }] };
      }
    });

    assert.equal(result.ok, true);
  });
});

describe("baseline plan", () => {
  it("returns read-only recommendations without adoption", async () => {
    const manifest = loadBaselineManifest();
    const inventory = computeMigrationInventory(DEFAULT_MIGRATIONS_DIR, {
      tableExists: false,
      rows: []
    });

    const queryable = {
      query: async (sql, params) => {
        if (String(sql).includes("to_regclass")) {
          return { rows: [{ reg: "schema_migrations" }] };
        }
        if (String(sql).includes("information_schema.columns")) {
          return { rows: [{ exists: true }] };
        }
        if (String(sql).includes("pg_indexes")) {
          return { rows: [{ exists: false }] };
        }
        return { rows: [] };
      }
    };

    const plan = await buildBaselinePlan(queryable, manifest, inventory);

    assert.equal(plan.adoptionEnabled, false);
    assert.ok(plan.recommendations.length > 0);
    assert.ok(
      plan.recommendations.some(
        (item) => item.filename === "000_schema_migration_ledger.sql"
      )
    );
  });
});

describe("checksum stability", () => {
  it("produces stable sha256 for known content", () => {
    const value = checksumSha256("BEGIN;\nSELECT 1;\nCOMMIT;\n");
    assert.equal(value.length, 64);
    assert.equal(
      value,
      checksumSha256("BEGIN;\nSELECT 1;\nCOMMIT;\n")
    );
  });
});

describe("phase 1.5 safety hardening", () => {
  it("effective manifest defines checks for every migration file", () => {
    const manifest = getEffectiveManifest(DEFAULT_MIGRATIONS_DIR);
    const files = listMigrationSqlFiles(DEFAULT_MIGRATIONS_DIR);

    for (const filename of files) {
      const checks = manifest.fingerprints[filename]?.checks || [];
      assert.ok(checks.length > 0, `expected checks for ${filename}`);
    }
  });

  it("throws MIGRATION_ORPHAN_UNRECORDED when orphan persistence fails", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "optalynx-mig-"));
    const filename = "001_self.sql";
    fs.writeFileSync(
      path.join(tempDir, filename),
      "BEGIN;\nSELECT 1;\nCOMMIT;\n",
      "utf8"
    );

    const client = {
      query: async (sql) => {
        if (
          String(sql).includes("information_schema.tables") &&
          String(sql).includes("table_name = $1")
        ) {
          return { rows: [{ exists: false }] };
        }
        if (String(sql).includes("CREATE TABLE IF NOT EXISTS schema_migration")) {
          throw new Error("cannot create recovery infrastructure");
        }
        if (String(sql).includes("INSERT INTO schema_migrations")) {
          throw new Error("ledger insert failed");
        }
        return { rows: [] };
      }
    };

    await assert.rejects(
      () =>
        applySingleMigration(client, {
          migrationsDir: tempDir,
          filename
        }),
      (error) =>
        error instanceof MigrationConsistencyError &&
        error.code === "MIGRATION_ORPHAN_UNRECORDED" &&
        error.details.orphanRecorded === false
    );

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("blocks migrate:up for uncertain_partial fingerprint failures", () => {
    assert.throws(
      () =>
        assertMigrateUpAllowedForPending({
          suspectedOrphans: [
            {
              filename: "050_rm_ats_stage_catalog.sql",
              pendingKind: "uncertain_partial",
              reasons: ["manifest fingerprint checks failed"]
            }
          ]
        }),
      /uncertain_partial/
    );
  });

  it("does not block migrate:up for suspected_orphan when ledger table is missing", () => {
    assertMigrateUpAllowedForPending({
      ledgerTablePresent: false,
      suspectedOrphans: [
        {
          filename: "001_master_data_schema.sql",
          pendingKind: "suspected_orphan",
          reasons: ["manifest fingerprint checks passed while ledger row is missing"]
        }
      ]
    });
  });

  it("scopes migrate:up orphan blocks to the pending slice being applied", () => {
    assertMigrateUpAllowedForPending(
      {
        suspectedOrphans: [
          {
            filename: "061_application_audit_session_history.sql",
            pendingKind: "uncertain_partial",
            reasons: ["partial evidence"]
          }
        ]
      },
      { pendingFilenames: ["000_schema_migration_ledger.sql"] }
    );
  });

  it("allows retry override only for uncertain_partial with confirmation env", () => {
    const prev = process.env[ALLOW_RETRY_CONFIRM_ENV];
    process.env[ALLOW_RETRY_CONFIRM_ENV] = ALLOW_RETRY_CONFIRM_VALUE;

    assertMigrateUpAllowedForPending(
      {
        suspectedOrphans: [
          {
            filename: "050_rm_ats_stage_catalog.sql",
            pendingKind: "uncertain_partial",
            reasons: []
          }
        ]
      },
      { allowRetryFilename: "050_rm_ats_stage_catalog.sql" }
    );

    assertMigrationRetryOverrideAllowed("050_rm_ats_stage_catalog.sql");

    delete process.env[ALLOW_RETRY_CONFIRM_ENV];
    assert.throws(
      () =>
        assertMigrationRetryOverrideAllowed("050_rm_ats_stage_catalog.sql"),
      /OPTALYNX_MIGRATE_ALLOW_RETRY_CONFIRM/
    );

    process.env[ALLOW_RETRY_CONFIRM_ENV] = prev;
  });

  it("does not allow retry override for suspected_orphan", () => {
    const prev = process.env[ALLOW_RETRY_CONFIRM_ENV];
    process.env[ALLOW_RETRY_CONFIRM_ENV] = ALLOW_RETRY_CONFIRM_VALUE;

    assert.throws(
      () =>
        assertMigrateUpAllowedForPending(
          {
            suspectedOrphans: [
              {
                filename: "056_rm_headcount_change_history.sql",
                pendingKind: "suspected_orphan",
                reasons: ["persistent orphan record"]
              }
            ]
          },
          { allowRetryFilename: "056_rm_headcount_change_history.sql" }
        ),
      /suspected_orphan/
    );

    process.env[ALLOW_RETRY_CONFIRM_ENV] = prev;
  });

  it("refuses repair when seed data checks fail", async () => {
    const manifest = getEffectiveManifest(DEFAULT_MIGRATIONS_DIR);
    const queryable = {
      query: async (sql) => {
        if (String(sql).includes("to_regclass")) {
          return { rows: [{ reg: "rm_ats_stage_catalog" }] };
        }
        if (String(sql).includes("COUNT(*)")) {
          return { rows: [{ c: 0 }] };
        }
        if (String(sql).includes("schema_migration_orphans")) {
          if (String(sql).includes("information_schema")) {
            return { rows: [{ exists: true }] };
          }
          return { rows: [] };
        }
        if (String(sql).includes("schema_migration_recovery_blocks")) {
          if (String(sql).includes("information_schema")) {
            return { rows: [{ exists: true }] };
          }
          return { rows: [] };
        }
        return { rows: [] };
      }
    };

    const evaluation = await evaluateFilenameFingerprints(
      queryable,
      manifest,
      "050_rm_ats_stage_catalog.sql"
    );

    assert.equal(evaluation.allPass, false);

    const assessment = {
      pendingKind: "uncertain_partial",
      suspectedOrphan: true,
      recordedOrphan: false,
      recoveryBlocked: false,
      checksum: "abc",
      fingerprint: evaluation
    };

    const result = buildRepairEligibility(assessment, "abc");
    assert.equal(result.eligible, false);
  });

  it("repair-ledger refuses 059 when duplicate PAN preflight fails", async () => {
    const migrationsDir = prepareLedgerFixtureDir([MIGRATION_059_FILENAME]);
    const pool = {
      query: async (sql) => {
        const text = String(sql);
        if (text.includes("FROM schema_migrations") && text.includes("ORDER BY")) {
          return {
            rows: [appliedLedgerRow(migrationsDir, LEDGER_MIGRATION_FILENAME)]
          };
        }
        if (text.includes("information_schema.tables")) {
          return { rows: [{ exists: true }] };
        }
        if (text.includes("schema_migration_orphans")) {
          return { rows: [] };
        }
        if (text.includes("schema_migration_recovery_blocks")) {
          if (text.includes("information_schema")) {
            return { rows: [{ exists: true }] };
          }
          return { rows: [] };
        }
        if (text.includes("duplicate_pan_groups")) {
          return {
            rows: [{ duplicate_pan_groups: 1, affected_registered_rows: 2 }]
          };
        }
        if (text.includes("cand_mstr")) {
          return { rows: [{ exists: true }] };
        }
        if (text.includes("pg_indexes") || text.includes("pg_index")) {
          return { rows: [{ exists: true }] };
        }
        if (text.includes("EXISTS (")) {
          return { rows: [{ exists: true }] };
        }
        return { rows: [] };
      }
    };

    await assert.rejects(
      () =>
        repairLedgerForFilename(
          pool,
          migrationsDir,
          MIGRATION_059_FILENAME,
          "tester"
        ),
      /preflight failed/
    );

    fs.rmSync(migrationsDir, { recursive: true, force: true });
  });

  it("classifies recovery blocks as migrate-up blocked", () => {
    const kind = classifyPendingKind({
      recordedOrphan: false,
      recoveryBlock: true,
      fingerprint: { fingerprintConfigured: false, allPass: null }
    });

    assert.equal(kind, "recovery_blocked");
  });
});

describe("phase 1.7 targeted remediation", () => {
  const CHECK_060 = {
    type: "column_characteristics",
    table: "interview_panel_mstr",
    column: "employee_code",
    expectDataType: "character varying",
    expectMaxLength: 100
  };

  function columnMetaQueryable(dataType, maxLength) {
    return {
      query: async (sql) => {
        if (String(sql).includes("character_maximum_length")) {
          if (dataType === null) {
            return { rows: [] };
          }
          return {
            rows: [
              {
                data_type: dataType,
                character_maximum_length: maxLength
              }
            ]
          };
        }
        return { rows: [] };
      }
    };
  }

  it("retry ordering refuses when earlier normal pending exists", () => {
    const pendingSlice = [
      { filename: "012_a.sql" },
      { filename: "013_b.sql" }
    ];
    const enriched = {
      pendingAssessment: [
        { filename: "012_a.sql", pendingKind: "normal_pending", reasons: [] },
        { filename: "013_b.sql", pendingKind: "uncertain_partial", reasons: [] }
      ]
    };

    assert.throws(
      () => assertRetryOrderingAllowed(pendingSlice, enriched, "013_b.sql"),
      /not the first pending migration/
    );
  });

  it("retry ordering refuses when earlier migration is blocked", () => {
    const pendingSlice = [
      { filename: "056_a.sql" },
      { filename: "057_b.sql" }
    ];
    const enriched = {
      pendingAssessment: [
        {
          filename: "056_a.sql",
          pendingKind: "suspected_orphan",
          reasons: ["persistent orphan record"]
        },
        { filename: "057_b.sql", pendingKind: "uncertain_partial", reasons: [] }
      ]
    };

    assert.throws(
      () => assertRetryOrderingAllowed(pendingSlice, enriched, "057_b.sql"),
      /Earlier pending migrations/
    );
  });

  it("retry ordering allows uncertain_partial when it is first in queue", () => {
    const pendingSlice = [{ filename: "050_x.sql" }];
    const enriched = {
      pendingAssessment: [
        { filename: "050_x.sql", pendingKind: "uncertain_partial", reasons: [] }
      ]
    };

    assertRetryOrderingAllowed(pendingSlice, enriched, "050_x.sql");
  });

  it("060 fingerprint accepts VARCHAR(100) and rejects VARCHAR(50) or missing column", async () => {
    const ok = await runFingerprintCheck(columnMetaQueryable("character varying", 100), CHECK_060);
    assert.equal(ok.ok, true);

    const short = await runFingerprintCheck(
      columnMetaQueryable("character varying", 50),
      CHECK_060
    );
    assert.equal(short.ok, false);

    const missing = await runFingerprintCheck(columnMetaQueryable(null, null), CHECK_060);
    assert.equal(missing.ok, false);
  });

  it("repair refuses orphan checksum mismatch and missing stored checksum", () => {
    const base = {
      pendingKind: "suspected_orphan",
      recordedOrphan: true,
      recoveryBlocked: false,
      fingerprint: { fingerprintConfigured: true, allPass: true }
    };

    assert.equal(
      buildRepairEligibility(
        { ...base, orphanChecksumSha256: "a".repeat(64) },
        "b".repeat(64)
      ).eligible,
      false
    );

    assert.equal(
      buildRepairEligibility({ ...base, orphanChecksumSha256: null }, "b".repeat(64))
        .eligible,
      false
    );

    assert.equal(
      buildRepairEligibility(
        { ...base, orphanChecksumSha256: "c".repeat(64) },
        "c".repeat(64)
      ).eligible,
      true
    );
  });

  it("repair does not require orphan checksum for fingerprint-only suspected orphan", () => {
    const result = buildRepairEligibility(
      {
        pendingKind: "suspected_orphan",
        recordedOrphan: false,
        recoveryBlocked: false,
        orphanChecksumSha256: null,
        fingerprint: { fingerprintConfigured: true, allPass: true }
      },
      "d".repeat(64)
    );

    assert.equal(result.eligible, true);
  });

  it("reports recovery-block persistence outcome on MIGRATION_ORPHAN_UNRECORDED", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "optalynx-mig-"));
    const filename = "001_self.sql";
    fs.writeFileSync(
      path.join(tempDir, filename),
      "BEGIN;\nSELECT 1;\nCOMMIT;\n",
      "utf8"
    );

    const client = {
      query: async (sql) => {
        if (
          String(sql).includes("information_schema.tables") &&
          String(sql).includes("table_name = $1")
        ) {
          return { rows: [{ exists: false }] };
        }
        if (String(sql).includes("CREATE TABLE IF NOT EXISTS schema_migration")) {
          return { rows: [] };
        }
        if (String(sql).includes("INSERT INTO schema_migration_recovery_blocks")) {
          return { rows: [] };
        }
        if (String(sql).includes("INSERT INTO schema_migrations")) {
          throw new Error("ledger insert failed");
        }
        return { rows: [] };
      }
    };

    await assert.rejects(
      () =>
        applySingleMigration(client, {
          migrationsDir: tempDir,
          filename
        }),
      (error) =>
        error instanceof MigrationConsistencyError &&
        error.code === "MIGRATION_ORPHAN_UNRECORDED" &&
        error.details.recoveryBlockRecorded === true &&
        error.details.orphanRecorded === false
    );

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("reports recovery-block failure on MIGRATION_ORPHAN_UNRECORDED", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "optalynx-mig-"));
    const filename = "001_self.sql";
    fs.writeFileSync(
      path.join(tempDir, filename),
      "BEGIN;\nSELECT 1;\nCOMMIT;\n",
      "utf8"
    );

    const client = {
      query: async (sql) => {
        if (
          String(sql).includes("information_schema.tables") &&
          String(sql).includes("table_name = $1")
        ) {
          return { rows: [{ exists: false }] };
        }
        if (String(sql).includes("CREATE TABLE IF NOT EXISTS schema_migration")) {
          throw new Error("cannot create recovery infrastructure");
        }
        if (String(sql).includes("INSERT INTO schema_migrations")) {
          throw new Error("ledger insert failed");
        }
        return { rows: [] };
      }
    };

    await assert.rejects(
      () =>
        applySingleMigration(client, {
          migrationsDir: tempDir,
          filename
        }),
      (error) =>
        error instanceof MigrationConsistencyError &&
        error.details.recoveryBlockRecorded === false &&
        typeof error.details.recoveryBlockError === "string"
    );

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("classifies pending as recovery_blocked when persistence tables are missing", async () => {
    const manifest = getEffectiveManifest(DEFAULT_MIGRATIONS_DIR);
    const inventory = computeMigrationInventory(DEFAULT_MIGRATIONS_DIR, {
      tableExists: true,
      rows: [{ filename: "000_schema_migration_ledger.sql", checksum_sha256: "x" }]
    });

    const queryable = {
      query: async (sql) => {
        if (
          String(sql).includes("information_schema.tables") &&
          String(sql).includes("table_name = $1")
        ) {
          return { rows: [{ exists: false }] };
        }
        if (String(sql).includes("to_regclass")) {
          return { rows: [{ reg: "public.schema_migrations" }] };
        }
        return { rows: [] };
      }
    };

    const enriched = await enrichInventoryWithOrphanState(
      queryable,
      manifest,
      inventory
    );

    assert.equal(enriched.recoveryPersistenceCapable, false);
    assert.ok(
      enriched.pendingAssessment.some((item) => item.pendingKind === "recovery_blocked")
    );
    assert.throws(() => assertRecoveryPersistenceForMutate(enriched), /migrate:up refused/);
  });

  it("evaluateRecoveryPersistenceCapability is capable before ledger bootstrap", async () => {
    const result = await evaluateRecoveryPersistenceCapability(
      { query: async () => ({ rows: [] }) },
      false
    );
    assert.equal(result.capable, true);
  });
});
