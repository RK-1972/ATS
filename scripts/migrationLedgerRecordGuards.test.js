const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const { listMigrationSqlFiles } = require("./lib/migrationFiles");
const { DEFAULT_MIGRATIONS_DIR } = require("./lib/migrationConstants");
const {
  collectEarlierPendingRefusalReasons,
  collectUnknownInLedgerRefusalReasons,
  assertNoUnknownInLedger,
  assertLedgerRecordOrdering
} = require("./lib/migrationLedgerRecordGuards");
const { computeVerifyOutcome, VERIFY_OUTCOME } = require("./lib/migrationVerify");

describe("migration ledger record guards", () => {
  it("refuses when unknown ledger rows exist", () => {
    const inventory = {
      unknownInLedger: [{ filename: "999_legacy.sql" }]
    };

    const reasons = collectUnknownInLedgerRefusalReasons(inventory);
    assert.equal(reasons.length, 1);
    assert.match(reasons[0], /999_legacy\.sql/);

    assert.throws(() => assertNoUnknownInLedger(inventory), /999_legacy\.sql/);
  });

  it("passes unknown ledger gate when list is empty", () => {
    assert.deepEqual(collectUnknownInLedgerRefusalReasons({ unknownInLedger: [] }), []);
    assertNoUnknownInLedger({ unknownInLedger: [] });
  });

  it("refuses adopting a later migration while earlier pending kinds are unresolved", () => {
    const inventory = {
      files: ["000.sql", "010.sql", "020.sql"],
      pending: [{ filename: "010.sql" }, { filename: "020.sql" }],
      applied: [],
      drift: [],
      unknownInLedger: []
    };
    const enriched = {
      pendingAssessment: [
        { filename: "010.sql", pendingKind: "normal_pending" },
        { filename: "020.sql", pendingKind: "suspected_orphan" }
      ]
    };

    const reasons = collectEarlierPendingRefusalReasons(
      inventory,
      enriched,
      "020.sql"
    );
    assert.equal(reasons.length, 1);
    assert.match(reasons[0], /010\.sql/);
    assert.match(reasons[0], /normal_pending/);

    assert.throws(
      () => assertLedgerRecordOrdering(inventory, enriched, "020.sql"),
      /earlier pending migrations must be resolved/
    );
  });

  it("refuses for earlier uncertain_partial, suspected_orphan, and recovery_blocked", () => {
    for (const kind of [
      "uncertain_partial",
      "suspected_orphan",
      "recovery_blocked"
    ]) {
      const inventory = {
        files: ["a.sql", "b.sql"],
        pending: [{ filename: "a.sql" }, { filename: "b.sql" }],
        applied: [],
        drift: [],
        unknownInLedger: []
      };
      const enriched = {
        pendingAssessment: [
          { filename: "a.sql", pendingKind: kind },
          { filename: "b.sql", pendingKind: "suspected_orphan" }
        ]
      };

      const reasons = collectEarlierPendingRefusalReasons(
        inventory,
        enriched,
        "b.sql"
      );
      assert.equal(reasons.length, 1);
      assert.match(reasons[0], new RegExp(kind));
    }
  });

  it("blocks later targets when an earlier lexicographic filename is pending", () => {
    const inventory = {
      files: [
        "000_schema_migration_ledger.sql",
        "920_first_pending.sql",
        "930_repair.sql"
      ],
      pending: [{ filename: "920_first_pending.sql" }, { filename: "930_repair.sql" }],
      applied: [{ filename: "000_schema_migration_ledger.sql" }],
      drift: [],
      unknownInLedger: []
    };
    const enriched = {
      pendingAssessment: [
        { filename: "920_first_pending.sql", pendingKind: "normal_pending" },
        { filename: "930_repair.sql", pendingKind: "suspected_orphan" }
      ]
    };

    const reasons = collectEarlierPendingRefusalReasons(
      inventory,
      enriched,
      "930_repair.sql"
    );
    assert.equal(reasons.length, 1);
    assert.match(reasons[0], /920_first_pending\.sql/);
  });

  it("does not treat a higher numeric prefix as earlier (945 is after 930)", () => {
    const inventory = {
      files: [
        "000_schema_migration_ledger.sql",
        "930_repair.sql",
        "945_first_pending.sql"
      ],
      pending: [{ filename: "930_repair.sql" }, { filename: "945_first_pending.sql" }],
      applied: [{ filename: "000_schema_migration_ledger.sql" }],
      drift: [],
      unknownInLedger: []
    };
    const enriched = {
      pendingAssessment: [
        { filename: "930_repair.sql", pendingKind: "suspected_orphan" },
        { filename: "945_first_pending.sql", pendingKind: "normal_pending" }
      ]
    };

    const reasons = collectEarlierPendingRefusalReasons(
      inventory,
      enriched,
      "930_repair.sql"
    );
    assert.equal(reasons.length, 0);
  });

  it("uses repository lexicographic order for duplicate 049 migrations", () => {
    const files = listMigrationSqlFiles(DEFAULT_MIGRATIONS_DIR);
    const employee = "049_employee_lifecycle_responsibility_v1.sql";
    const hiring = "049_hiring_manager_employee_code_binding.sql";
    const employeeIndex = files.indexOf(employee);
    const hiringIndex = files.indexOf(hiring);

    assert.ok(employeeIndex >= 0);
    assert.ok(hiringIndex >= 0);
    assert.ok(employeeIndex < hiringIndex);

    const inventory = {
      files,
      pending: [{ filename: employee }, { filename: hiring }],
      applied: files.slice(0, employeeIndex).map((filename) => ({ filename })),
      drift: [],
      unknownInLedger: []
    };
    const enriched = {
      pendingAssessment: [
        { filename: employee, pendingKind: "normal_pending" },
        { filename: hiring, pendingKind: "suspected_orphan" }
      ]
    };

    const reasons = collectEarlierPendingRefusalReasons(
      inventory,
      enriched,
      hiring
    );
    assert.equal(reasons.length, 1);
    assert.match(reasons[0], /049_employee_lifecycle_responsibility_v1\.sql/);
  });
});

describe("verify unknown in ledger outcome", () => {
  it("fails verify when unknownInLedger is non-empty", () => {
    const result = computeVerifyOutcome({
      inventory: {
        drift: [],
        pending: [],
        applied: [],
        unknownInLedger: [{ filename: "orphan_row.sql" }]
      },
      enriched: {
        recoveryPersistenceCapable: true,
        missingRecoveryTables: [],
        pendingAssessment: []
      },
      fingerprintResults: []
    });

    assert.equal(result.ok, false);
    assert.equal(result.verification.primaryOutcome, VERIFY_OUTCOME.UNKNOWN_IN_LEDGER);
    assert.deepEqual(
      result.verification.issues.find((item) => item.code === VERIFY_OUTCOME.UNKNOWN_IN_LEDGER)
        .filenames,
      ["orphan_row.sql"]
    );
  });

  it("passes unknown in ledger gate when list is empty", () => {
    const result = computeVerifyOutcome({
      inventory: {
        drift: [],
        pending: [],
        applied: [{ filename: "001_master_data_schema.sql" }],
        unknownInLedger: []
      },
      enriched: {
        recoveryPersistenceCapable: true,
        missingRecoveryTables: [],
        pendingAssessment: []
      },
      fingerprintResults: [
        { filename: "001_master_data_schema.sql", configured: true, ok: true }
      ]
    });

    assert.equal(result.ok, true);
    assert.ok(
      !result.verification.issues.some(
        (item) => item.code === VERIFY_OUTCOME.UNKNOWN_IN_LEDGER
      )
    );
  });
});
