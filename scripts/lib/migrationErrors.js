class MigrationConsistencyError extends Error {

  constructor(code, message, details = {}) {

    super(message);

    this.name = "MigrationConsistencyError";

    this.code = code;

    this.details = details;

  }

}



const RECOVERY_LEDGER_ORPHAN = `

Recovery (MIGRATION_LEDGER_ORPHAN):

  1. migrate:up is blocked for this filename (orphan record and/or fingerprint evidence).

  2. Run migrate:status and migrate:verify (verify will FAIL while orphan is unresolved).

  3. If schema effects are confirmed, run: npm run migrate:repair-ledger -- --filename <file>

     (never re-runs migration SQL; requires manifest fingerprint pass).

  4. If repair-ledger refuses, perform manual DBA review — do not use baseline-adopt.

  5. If schema is wrong, restore from backup or apply a forward-fix migration.

`;



const RECOVERY_ORPHAN_UNRECORDED = `

Recovery (MIGRATION_ORPHAN_UNRECORDED):

  1. Migration SQL may have committed but neither an orphan row nor a reliable ledger row was recorded.

  2. Check error details: orphanRecorded, recoveryBlockRecorded, recoveryBlockError.
  3. migrate:up is blocked when recovery persistence is incomplete (see verify/status).

  3. Run migrate:status and migrate:verify — do NOT re-run migrate:up for this file.

  4. Confirm schema state manually, then use migrate:repair-ledger --filename <file> only if fingerprints pass.

  5. If repair-ledger refuses, escalate to manual DBA review before any retry.

  6. Partial-schema retries are never automatic; use --allow-retry-filename only after explicit review

     with OPTALYNX_MIGRATE_ALLOW_RETRY_CONFIRM=I_CONFIRM_MIGRATION_RETRY (uncertain partial states only).

`;



module.exports = {

  MigrationConsistencyError,

  RECOVERY_LEDGER_ORPHAN,

  RECOVERY_ORPHAN_UNRECORDED

};
