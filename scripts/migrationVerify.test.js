const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const {
  computeVerifyOutcome,
  VERIFY_OUTCOME
} = require("./lib/migrationVerify");

function baseInventory(overrides = {}) {
  return {
    drift: [],
    pending: [],
    applied: [{ filename: "001_master_data_schema.sql" }],
    ...overrides
  };
}

function baseEnriched(overrides = {}) {
  return {
    unresolvedOrphanCount: 0,
    suspectedOrphans: [],
    recoveryPersistenceCapable: true,
    missingRecoveryTables: [],
    pendingAssessment: [],
    ...overrides
  };
}

describe("migrate:verify outcome (computeVerifyOutcome)", () => {
  it("passes when fingerprints are configured and all checks pass with no pending or drift", () => {
    const result = computeVerifyOutcome({
      inventory: baseInventory(),
      enriched: baseEnriched(),
      fingerprintResults: [
        { filename: "001_master_data_schema.sql", configured: true, ok: true }
      ]
    });

    assert.equal(result.ok, true);
    assert.equal(result.verification.result, "pass");
    assert.equal(result.verification.primaryOutcome, VERIFY_OUTCOME.VERIFIED);
    assert.deepEqual(result.verification.issues, []);
  });

  it("fails when applied migration has no fingerprint coverage", () => {
    const result = computeVerifyOutcome({
      inventory: baseInventory(),
      enriched: baseEnriched(),
      fingerprintResults: [
        { filename: "001_master_data_schema.sql", configured: false, ok: null }
      ]
    });

    assert.equal(result.ok, false);
    assert.equal(
      result.verification.primaryOutcome,
      VERIFY_OUTCOME.INSUFFICIENT_FINGERPRINT_COVERAGE
    );
    assert.deepEqual(result.insufficientFingerprintCoverage, [
      "001_master_data_schema.sql"
    ]);
  });

  it("fails when configured fingerprint checks do not pass", () => {
    const result = computeVerifyOutcome({
      inventory: baseInventory(),
      enriched: baseEnriched(),
      fingerprintResults: [
        { filename: "001_master_data_schema.sql", configured: true, ok: false }
      ]
    });

    assert.equal(result.ok, false);
    assert.equal(
      result.verification.primaryOutcome,
      VERIFY_OUTCOME.FINGERPRINT_CHECK_FAILED
    );
    assert.deepEqual(result.fingerprintCheckFailed, ["001_master_data_schema.sql"]);
  });

  it("fails on checksum drift before fingerprint coverage", () => {
    const result = computeVerifyOutcome({
      inventory: baseInventory({
        drift: [{ filename: "002_platform_config_schema.sql" }]
      }),
      enriched: baseEnriched(),
      fingerprintResults: [
        { filename: "001_master_data_schema.sql", configured: false, ok: null }
      ]
    });

    assert.equal(result.ok, false);
    assert.equal(result.verification.primaryOutcome, VERIFY_OUTCOME.CHECKSUM_DRIFT);
    assert.ok(
      result.verification.issues.some(
        (issue) => issue.code === VERIFY_OUTCOME.INSUFFICIENT_FINGERPRINT_COVERAGE
      )
    );
  });

  it("fails when pending migrations remain", () => {
    const result = computeVerifyOutcome({
      inventory: baseInventory({
        pending: [{ filename: "002_platform_config_schema.sql" }]
      }),
      enriched: baseEnriched(),
      fingerprintResults: [
        { filename: "001_master_data_schema.sql", configured: true, ok: true }
      ]
    });

    assert.equal(result.ok, false);
    assert.equal(
      result.verification.primaryOutcome,
      VERIFY_OUTCOME.PENDING_MIGRATIONS
    );
  });

  it("fails when suspected orphans are unresolved", () => {
    const result = computeVerifyOutcome({
      inventory: baseInventory(),
      enriched: baseEnriched({
        unresolvedOrphanCount: 1,
        suspectedOrphans: [
          {
            filename: "004_workflow_engine_schema.sql",
            pendingKind: "suspected_orphan",
            reasons: ["orphan"]
          }
        ],
        pendingAssessment: [
          {
            filename: "004_workflow_engine_schema.sql",
            pendingKind: "suspected_orphan"
          }
        ]
      }),
      fingerprintResults: []
    });

    assert.equal(result.ok, false);
    assert.equal(result.verification.primaryOutcome, VERIFY_OUTCOME.SUSPECTED_ORPHAN);
    const orphanIssue = result.verification.issues.find(
      (issue) => issue.code === VERIFY_OUTCOME.SUSPECTED_ORPHAN
    );
    assert.deepEqual(orphanIssue.filenames, ["004_workflow_engine_schema.sql"]);
  });

  it("uncertain-partial-only does not report misleading suspected-orphan filenames", () => {
    const result = computeVerifyOutcome({
      inventory: baseInventory(),
      enriched: baseEnriched({
        unresolvedOrphanCount: 1,
        suspectedOrphans: [
          {
            filename: "050_rm_ats_stage_catalog.sql",
            pendingKind: "uncertain_partial",
            reasons: ["partial evidence"]
          }
        ],
        pendingAssessment: [
          {
            filename: "050_rm_ats_stage_catalog.sql",
            pendingKind: "uncertain_partial"
          }
        ]
      }),
      fingerprintResults: []
    });

    assert.equal(result.ok, false);
    assert.equal(result.verification.primaryOutcome, VERIFY_OUTCOME.UNCERTAIN_PARTIAL);
    assert.equal(
      result.verification.issues.some(
        (issue) => issue.code === VERIFY_OUTCOME.SUSPECTED_ORPHAN
      ),
      false
    );
  });

  it("recovery-blocked scenario uses recovery_blocked as primaryOutcome", () => {
    const result = computeVerifyOutcome({
      inventory: baseInventory(),
      enriched: baseEnriched({
        unresolvedOrphanCount: 1,
        suspectedOrphans: [
          {
            filename: "940_verify.sql",
            pendingKind: "recovery_blocked",
            reasons: ["recovery block"]
          }
        ],
        pendingAssessment: [
          {
            filename: "940_verify.sql",
            pendingKind: "recovery_blocked",
            recoveryBlocked: true
          }
        ]
      }),
      fingerprintResults: []
    });

    assert.equal(result.ok, false);
    assert.equal(result.verification.primaryOutcome, VERIFY_OUTCOME.RECOVERY_BLOCKED);
    const recoveryIssue = result.verification.issues.find(
      (issue) => issue.code === VERIFY_OUTCOME.RECOVERY_BLOCKED
    );
    assert.deepEqual(recoveryIssue.filenames, ["940_verify.sql"]);
    assert.equal(
      result.verification.issues.some(
        (issue) => issue.code === VERIFY_OUTCOME.SUSPECTED_ORPHAN
      ),
      false
    );
  });

  it("fails when uncertain partial pending states exist", () => {
    const result = computeVerifyOutcome({
      inventory: baseInventory(),
      enriched: baseEnriched({
        pendingAssessment: [
          {
            filename: "050_rm_ats_stage_catalog.sql",
            pendingKind: "uncertain_partial"
          }
        ]
      }),
      fingerprintResults: []
    });

    assert.equal(result.ok, false);
    assert.equal(result.verification.primaryOutcome, VERIFY_OUTCOME.UNCERTAIN_PARTIAL);
  });

  it("fails when recovery blocks are active", () => {
    const result = computeVerifyOutcome({
      inventory: baseInventory(),
      enriched: baseEnriched({
        pendingAssessment: [
          {
            filename: "940_verify.sql",
            pendingKind: "recovery_blocked",
            recoveryBlocked: true
          }
        ]
      }),
      fingerprintResults: []
    });

    assert.equal(result.ok, false);
    assert.equal(result.verification.primaryOutcome, VERIFY_OUTCOME.RECOVERY_BLOCKED);
  });

  it("exposes fingerprintCheckFailed consistently with verification.issues and verify JSON shape", () => {
    const result = computeVerifyOutcome({
      inventory: baseInventory(),
      enriched: baseEnriched(),
      fingerprintResults: [
        { filename: "001_master_data_schema.sql", configured: true, ok: false },
        { filename: "002_platform_config_schema.sql", configured: true, ok: false }
      ]
    });

    assert.equal(result.ok, false);
    assert.deepEqual(result.fingerprintCheckFailed, [
      "001_master_data_schema.sql",
      "002_platform_config_schema.sql"
    ]);

    const issue = result.verification.issues.find(
      (entry) => entry.code === VERIFY_OUTCOME.FINGERPRINT_CHECK_FAILED
    );
    assert.deepEqual(issue.filenames, result.fingerprintCheckFailed);

    const verifyJsonPayload = {
      fingerprintCheckFailed: result.fingerprintCheckFailed,
      verification: result.verification
    };
    assert.deepEqual(
      verifyJsonPayload.fingerprintCheckFailed,
      issue.filenames
    );
  });

  it("fails when recovery persistence tables are missing", () => {
    const result = computeVerifyOutcome({
      inventory: baseInventory(),
      enriched: baseEnriched({
        recoveryPersistenceCapable: false,
        missingRecoveryTables: ["schema_migration_orphans"]
      }),
      fingerprintResults: []
    });

    assert.equal(result.ok, false);
    assert.equal(
      result.verification.primaryOutcome,
      VERIFY_OUTCOME.RECOVERY_PERSISTENCE_MISSING
    );
  });
});
