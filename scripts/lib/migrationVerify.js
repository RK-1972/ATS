const { buildPendingStateVisibility } = require("./migrationOrphans");

const VERIFY_OUTCOME = {
  VERIFIED: "verified",
  CHECKSUM_DRIFT: "checksum_drift",
  UNKNOWN_IN_LEDGER: "unknown_in_ledger",
  RECOVERY_PERSISTENCE_MISSING: "recovery_persistence_missing",
  RECOVERY_BLOCKED: "recovery_blocked",
  SUSPECTED_ORPHAN: "suspected_orphan",
  UNCERTAIN_PARTIAL: "uncertain_partial",
  PENDING_MIGRATIONS: "pending_migrations",
  INSUFFICIENT_FINGERPRINT_COVERAGE: "insufficient_fingerprint_coverage",
  FINGERPRINT_CHECK_FAILED: "fingerprint_check_failed"
};

const PRIMARY_OUTCOME_PRIORITY = [
  VERIFY_OUTCOME.CHECKSUM_DRIFT,
  VERIFY_OUTCOME.UNKNOWN_IN_LEDGER,
  VERIFY_OUTCOME.RECOVERY_PERSISTENCE_MISSING,
  VERIFY_OUTCOME.RECOVERY_BLOCKED,
  VERIFY_OUTCOME.UNCERTAIN_PARTIAL,
  VERIFY_OUTCOME.SUSPECTED_ORPHAN,
  VERIFY_OUTCOME.PENDING_MIGRATIONS,
  VERIFY_OUTCOME.INSUFFICIENT_FINGERPRINT_COVERAGE,
  VERIFY_OUTCOME.FINGERPRINT_CHECK_FAILED
];

function selectPrimaryOutcome(issues) {
  for (const code of PRIMARY_OUTCOME_PRIORITY) {
    if (issues.some((issue) => issue.code === code)) {
      return code;
    }
  }

  return VERIFY_OUTCOME.VERIFIED;
}

function computeVerifyOutcome({ inventory, enriched, fingerprintResults }) {
  const stateVisibility = buildPendingStateVisibility(enriched);
  const issues = [];

  if (inventory.drift.length > 0) {
    issues.push({
      code: VERIFY_OUTCOME.CHECKSUM_DRIFT,
      filenames: inventory.drift.map((item) => item.filename)
    });
  }

  if ((inventory.unknownInLedger || []).length > 0) {
    issues.push({
      code: VERIFY_OUTCOME.UNKNOWN_IN_LEDGER,
      filenames: inventory.unknownInLedger.map((item) => item.filename)
    });
  }

  if (enriched.recoveryPersistenceCapable === false) {
    issues.push({
      code: VERIFY_OUTCOME.RECOVERY_PERSISTENCE_MISSING,
      missingTables: enriched.missingRecoveryTables || []
    });
  }

  if (stateVisibility.recoveryBlocked.length > 0) {
    issues.push({
      code: VERIFY_OUTCOME.RECOVERY_BLOCKED,
      filenames: stateVisibility.recoveryBlocked.map((item) => item.filename)
    });
  }

  if (stateVisibility.uncertainPartial.length > 0) {
    issues.push({
      code: VERIFY_OUTCOME.UNCERTAIN_PARTIAL,
      filenames: stateVisibility.uncertainPartial.map((item) => item.filename)
    });
  }

  if (stateVisibility.suspectedOrphan.length > 0) {
    issues.push({
      code: VERIFY_OUTCOME.SUSPECTED_ORPHAN,
      filenames: stateVisibility.suspectedOrphan.map((item) => item.filename)
    });
  }

  if (inventory.pending.length > 0) {
    issues.push({
      code: VERIFY_OUTCOME.PENDING_MIGRATIONS,
      filenames: inventory.pending.map((item) => item.filename)
    });
  }

  const insufficientFingerprintCoverage = fingerprintResults
    .filter((item) => item.configured === false || item.ok === null)
    .map((item) => item.filename);

  if (insufficientFingerprintCoverage.length > 0) {
    issues.push({
      code: VERIFY_OUTCOME.INSUFFICIENT_FINGERPRINT_COVERAGE,
      filenames: insufficientFingerprintCoverage
    });
  }

  const fingerprintCheckFailed = fingerprintResults
    .filter((item) => item.configured === true && item.ok === false)
    .map((item) => item.filename);

  if (fingerprintCheckFailed.length > 0) {
    issues.push({
      code: VERIFY_OUTCOME.FINGERPRINT_CHECK_FAILED,
      filenames: fingerprintCheckFailed
    });
  }

  const ok = issues.length === 0;
  const primaryOutcome = ok ? VERIFY_OUTCOME.VERIFIED : selectPrimaryOutcome(issues);

  return {
    ok,
    verification: {
      result: ok ? "pass" : "fail",
      primaryOutcome,
      issues
    },
    insufficientFingerprintCoverage,
    fingerprintCheckFailed,
    stateVisibility
  };
}

module.exports = {
  VERIFY_OUTCOME,
  computeVerifyOutcome
};
