const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, it, beforeEach, afterEach } = require("node:test");

const {
  DEFAULT_MIGRATIONS_DIR,
  LEDGER_MIGRATION_FILENAME
} = require("./lib/migrationConstants");
const {
  BASELINE_ADOPT_CONFIRM_ENV,
  buildBaselineAdoptConfirmValue
} = require("./lib/migrationConstants");
const {
  assessBaselineAdoptEligibility,
  dryRunBaselineAdopt,
  confirmBaselineAdopt,
  assertBaselineAdoptConfirmAllowed
} = require("./lib/migrationBaselineAdopt");
const { withAdvisoryLock } = require("./lib/migrationRunner");
const { MIGRATION_059_FILENAME } = require("./lib/migrationPreflight059");
const { fileChecksum, listMigrationSqlFiles } = require("./lib/migrationFiles");

const HEADCOUNT_FILENAME = "056_rm_headcount_change_history.sql";

function prepareLedgerFixtureDir(extraFilenames = []) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "optalynx-mig-adopt-"));
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
  return {
    filename,
    checksum_sha256: fileChecksum(migrationsDir, filename),
    applied_at: new Date(),
    applied_by: "tester",
    duration_ms: 1
  };
}

function createSuspectedOrphanPool(migrationsDir, filename, options = {}) {
  const {
    ledgerRows = [appliedLedgerRow(migrationsDir, LEDGER_MIGRATION_FILENAME)],
    recoveryBlockRows = []
  } = options;

  const queryHandler = async (sql, params) => {
    const text = String(sql);

    if (text.trim() === "BEGIN" || text.trim() === "COMMIT") {
      return { rows: [] };
    }
    if (text.includes("pg_try_advisory_lock")) {
      return { rows: [{ acquired: true }] };
    }
    if (text.includes("pg_advisory_unlock")) {
      return { rows: [{ released: true }] };
    }
    if (text.includes("information_schema.tables")) {
      const tableName = params?.[0];
      if (tableName === "schema_migrations") {
        return { rows: [{ exists: true }] };
      }
      if (tableName === "cand_mstr") {
        return { rows: [{ exists: true }] };
      }
      return { rows: [{ exists: true }] };
    }
    if (text.includes("FROM schema_migrations") && text.includes("ORDER BY filename")) {
      return { rows: ledgerRows };
    }
    if (text.includes("to_regclass")) {
      const objectName = String(params?.[0] || "");
      if (objectName.includes("rm_budget_change_history")) {
        return { rows: [{ reg: "rm_budget_change_history" }] };
      }
      return { rows: [{ reg: "rm_headcount_change_history" }] };
    }
    if (text.includes("INSERT INTO schema_migrations")) {
      return { rows: [{ filename }], rowCount: 1 };
    }
    if (
      text.includes("checksum_sha256") &&
      text.includes("WHERE filename = $1")
    ) {
      return {
        rows: [
          {
            checksum_sha256: fileChecksum(migrationsDir, filename)
          }
        ],
        rowCount: 1
      };
    }
    if (text.includes("schema_migration_orphans")) {
      if (text.includes("UPDATE")) {
        return { rowCount: 1, rows: [] };
      }
      if (
        text.includes("WHERE resolved_at IS NULL") &&
        !text.includes("information_schema")
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
    if (text.includes("schema_migration_recovery_blocks")) {
      if (text.includes("information_schema")) {
        return { rows: [{ exists: true }] };
      }
      if (text.includes("FROM schema_migration_recovery_blocks")) {
        return { rows: recoveryBlockRows };
      }
      return { rows: [] };
    }
    if (text.includes("information_schema.columns")) {
      return { rows: [{ exists: true }] };
    }
    if (text.includes("pg_indexes")) {
      return { rows: [{ exists: true }] };
    }
    if (text.includes("pg_constraint")) {
      return { rows: [{ exists: true }] };
    }
    if (text.includes("COUNT(*)")) {
      return { rows: [{ c: 10 }] };
    }
    if (text.includes("duplicate_groups")) {
      return {
        rows: [{ duplicate_pan_groups: 0, affected_registered_rows: 0 }]
      };
    }
    return { rows: [] };
  };

  return {
    query: queryHandler,
    connect: async () => ({
      query: queryHandler,
      release: () => {},
      end: async () => {}
    })
  };
}

describe("baseline-adopt confirmation", () => {
  const filename = "010_interview_stages_schema.sql";
  const envKey = BASELINE_ADOPT_CONFIRM_ENV;
  let previous;

  beforeEach(() => {
    previous = process.env[envKey];
    delete process.env[envKey];
  });

  afterEach(() => {
    if (previous === undefined) {
      delete process.env[envKey];
    } else {
      process.env[envKey] = previous;
    }
  });

  it("refuses confirm unless the exact filename-specific env value is set", () => {
    assert.throws(
      () => assertBaselineAdoptConfirmAllowed(filename),
      /Refusing baseline-adopt/
    );

    process.env[envKey] = "I_ADOPT_LEDGER_RECORD_FOR_wrong.sql";
    assert.throws(
      () => assertBaselineAdoptConfirmAllowed(filename),
      /Refusing baseline-adopt/
    );

    process.env[envKey] = buildBaselineAdoptConfirmValue(filename);
    assert.equal(assertBaselineAdoptConfirmAllowed(filename), filename);
  });
});

describe("baseline-adopt eligibility assessment", () => {
  it("refuses normal_pending and uncertain_partial (non suspected_orphan)", async () => {
    const queryable = {
      query: async (sql) => {
        const text = String(sql);
        if (text.includes("FROM schema_migrations")) {
          return { rows: [] };
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
          return { rows: [{ reg: null }] };
        }
        return { rows: [] };
      }
    };

    const result = await assessBaselineAdoptEligibility(
      queryable,
      DEFAULT_MIGRATIONS_DIR,
      "010_interview_stages_schema.sql"
    );

    assert.equal(result.eligible, false);
    assert.ok(
      result.refusalReasons.some((reason) =>
        reason.includes('not adoptable (requires suspected_orphan)')
      )
    );
  });

  it("refuses recovery_blocked pending kind", async () => {
    const filename = HEADCOUNT_FILENAME;
    const migrationsDir = prepareLedgerFixtureDir([filename]);
    const pool = createSuspectedOrphanPool(migrationsDir, filename, {
      recoveryBlockRows: [
        {
          filename,
          checksum_sha256: fileChecksum(migrationsDir, filename),
          reason_code: "MIGRATION_ORPHAN_UNRECORDED"
        }
      ]
    });

    const result = await assessBaselineAdoptEligibility(pool, migrationsDir, filename);

    assert.equal(result.eligible, false);
    assert.equal(result.pendingKind, "recovery_blocked");
    assert.ok(
      result.refusalReasons.some((reason) =>
        reason.includes('not adoptable (requires suspected_orphan)')
      )
    );
  });

  it("refuses when checksum drift exists anywhere in inventory", async () => {
    const target = "010_interview_stages_schema.sql";
    const migrationsDir = prepareLedgerFixtureDir([target]);

    const queryable = createSuspectedOrphanPool(migrationsDir, target, {
      ledgerRows: [
        {
          filename: LEDGER_MIGRATION_FILENAME,
          checksum_sha256: "0".repeat(64),
          applied_at: new Date(),
          applied_by: "tester",
          duration_ms: 1
        }
      ]
    });

    const result = await assessBaselineAdoptEligibility(queryable, migrationsDir, target);

    fs.rmSync(migrationsDir, { recursive: true, force: true });

    assert.equal(result.eligible, false);
    assert.ok(
      result.refusalReasons.some((reason) => /checksum drift/i.test(reason))
    );
  });

  it("refuses when fingerprint checks do not all pass", async () => {
    const filename = HEADCOUNT_FILENAME;
    const migrationsDir = prepareLedgerFixtureDir([filename]);
    const pool = createSuspectedOrphanPool(migrationsDir, filename);
    const broken = {
      query: async (sql, params) => {
        const text = String(sql);
        if (text.includes("to_regclass")) {
          return { rows: [{ reg: null }] };
        }
        return pool.query(sql, params);
      },
      connect: pool.connect
    };

    const result = await assessBaselineAdoptEligibility(broken, migrationsDir, filename);

    assert.equal(result.eligible, false);
    assert.equal(result.fingerprint.allPass, false);
    assert.ok(
      result.refusalReasons.some((reason) =>
        reason.includes("Manifest fingerprint checks did not pass")
      )
    );
  });
});

describe("baseline-adopt dry-run", () => {
  it("never writes ledger, orphan, or recovery-block data", async () => {
    const writes = [];
    const queryable = {
      query: async (sql) => {
        const text = String(sql);
        if (
          text.includes("INSERT INTO schema_migrations") ||
          text.includes("UPDATE schema_migration_orphans") ||
          text.includes("DELETE FROM schema_migration_recovery_blocks")
        ) {
          writes.push(text);
        }
        if (text.trim() === "BEGIN" || text.trim() === "COMMIT") {
          writes.push(text);
        }
        if (text.includes("FROM schema_migrations")) {
          return { rows: [] };
        }
        if (text.includes("information_schema.tables")) {
          return { rows: [{ exists: true }] };
        }
        return { rows: [] };
      }
    };

    const payload = await dryRunBaselineAdopt(
      queryable,
      DEFAULT_MIGRATIONS_DIR,
      "999_missing_migration.sql"
    );

    assert.equal(payload.mode, "dry-run");
    assert.equal(writes.length, 0);
    assert.equal(payload.migrationSqlExecuted, false);
    assert.equal(payload.eligible, false);
  });
});

describe("baseline-adopt confirm path", () => {
  it("blocks adoption when advisory lock is not acquired", async () => {
    const pool = {
      connect: async () => ({
        query: async (sql) => {
          if (String(sql).includes("pg_try_advisory_lock")) {
            return { rows: [{ acquired: false }] };
          }
          return { rows: [] };
        },
        release: () => {},
        end: async () => {}
      })
    };

    await assert.rejects(
      () =>
        withAdvisoryLock(pool, async () => {
          throw new Error("should not run");
        }),
      /advisory lock/i
    );
  });

  it("refuses confirm when eligibility fails (independent of confirmation env)", async () => {
    const pool = { query: async () => ({ rows: [] }) };

    await assert.rejects(
      () => confirmBaselineAdopt(pool, DEFAULT_MIGRATIONS_DIR, "010_interview_stages_schema.sql"),
      /baseline-adopt refused/i
    );
  });

  it("adopts suspected orphan with correct checksum and migrationSqlExecuted false", async () => {
    const filename = HEADCOUNT_FILENAME;
    const migrationsDir = prepareLedgerFixtureDir([filename]);
    const expectedChecksum = fileChecksum(migrationsDir, filename);
    const pool = createSuspectedOrphanPool(migrationsDir, filename);

    const dry = await dryRunBaselineAdopt(pool, migrationsDir, filename);
    assert.equal(dry.eligible, true);
    assert.equal(dry.migrationSqlExecuted, false);

    const result = await confirmBaselineAdopt(
      pool,
      migrationsDir,
      filename,
      "adopt-tester"
    );

    assert.equal(result.adoptionOutcome, "ledger_recorded");
    assert.equal(result.filename, filename);
    assert.equal(result.checksum, expectedChecksum);
    assert.equal(result.migrationSqlExecuted, false);
    assert.equal(result.fingerprint.configured, true);
    assert.equal(result.fingerprint.allPass, true);

    fs.rmSync(migrationsDir, { recursive: true, force: true });
  });

  it("confirm JSON fingerprint reflects under-lock reassess, not pre-lock snapshot", async () => {
    const filename = HEADCOUNT_FILENAME;
    const migrationsDir = prepareLedgerFixtureDir([filename]);
    const pool = createSuspectedOrphanPool(migrationsDir, filename);

    const adoptMod = require("./lib/migrationBaselineAdopt");
    const realAssess = adoptMod.assessBaselineAdoptEligibility.bind(adoptMod);
    let assessCalls = 0;

    adoptMod.assessBaselineAdoptEligibility = async (...args) => {
      assessCalls += 1;
      const base = await realAssess(...args);

      if (assessCalls === 1) {
        return {
          ...base,
          fingerprint: {
            configured: true,
            allPass: true,
            checks: [{ type: "phase", ok: true, detail: "pre-lock" }]
          }
        };
      }

      if (assessCalls === 2) {
        return {
          ...base,
          fingerprint: {
            configured: true,
            allPass: true,
            checks: [{ type: "phase", ok: true, detail: "under-lock" }]
          }
        };
      }

      return base;
    };

    try {
      const result = await adoptMod.confirmBaselineAdopt(
        pool,
        migrationsDir,
        filename,
        "adopt-tester"
      );

      assert.equal(assessCalls, 2);
      assert.equal(result.fingerprint.checks[0].detail, "under-lock");
      assert.notEqual(result.fingerprint.checks[0].detail, "pre-lock");
    } finally {
      adoptMod.assessBaselineAdoptEligibility = realAssess;
      fs.rmSync(migrationsDir, { recursive: true, force: true });
    }
  });

  it("refuses adopt when an earlier migration remains pending in lex order", async () => {
    const migrationsDir = prepareLedgerFixtureDir([
      HEADCOUNT_FILENAME,
      "057_rm_budget_change_history.sql"
    ]);
    const pool = createSuspectedOrphanPool(migrationsDir, "057_rm_budget_change_history.sql");

    const result = await assessBaselineAdoptEligibility(
      pool,
      migrationsDir,
      "057_rm_budget_change_history.sql"
    );

    assert.equal(result.eligible, false);
    assert.ok(
      result.refusalReasons.some((reason) =>
        reason.includes("056_rm_headcount_change_history.sql")
      )
    );

    fs.rmSync(migrationsDir, { recursive: true, force: true });
  });

  it("refuses adopt when unknown ledger rows exist", async () => {
    const migrationsDir = prepareLedgerFixtureDir([HEADCOUNT_FILENAME]);
    const pool = createSuspectedOrphanPool(migrationsDir, HEADCOUNT_FILENAME, {
      ledgerRows: [
        {
          filename: "999_unknown_migration.sql",
          checksum_sha256: "a".repeat(64),
          applied_at: new Date(),
          applied_by: "tester",
          duration_ms: 1
        }
      ]
    });

    const result = await assessBaselineAdoptEligibility(
      pool,
      migrationsDir,
      HEADCOUNT_FILENAME
    );

    assert.equal(result.eligible, false);
    assert.ok(
      result.refusalReasons.some((reason) => reason.includes("999_unknown_migration.sql"))
    );

    fs.rmSync(migrationsDir, { recursive: true, force: true });
  });
});

describe("baseline-adopt 059 preflight", () => {
  it("refuses when duplicate PAN preflight fails", async () => {
    const queryable = {
      query: async (sql) => {
        const text = String(sql);
        if (text.includes("duplicate_groups")) {
          return {
            rows: [{ duplicate_pan_groups: 2, affected_registered_rows: 4 }]
          };
        }
        if (text.includes("cand_mstr") && text.includes("information_schema")) {
          return { rows: [{ exists: true }] };
        }
        if (text.includes("FROM schema_migrations")) {
          return { rows: [] };
        }
        if (text.includes("information_schema.tables")) {
          return { rows: [{ exists: true }] };
        }
        if (text.includes("schema_migration_orphans")) {
          return { rows: [] };
        }
        if (text.includes("schema_migration_recovery_blocks")) {
          return { rows: [] };
        }
        return { rows: [] };
      }
    };

    const result = await assessBaselineAdoptEligibility(
      queryable,
      DEFAULT_MIGRATIONS_DIR,
      MIGRATION_059_FILENAME
    );

    assert.equal(result.eligible, false);
    assert.match(result.refusalReasons.join(" "), /059 preflight failed/i);
    assert.equal(result.preflight059.ok, false);
    assert.equal(typeof result.preflight059.duplicatePanGroups, "number");
  });
});
