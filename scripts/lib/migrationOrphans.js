const {
  evaluateFilenameFingerprints,
  FINGERPRINT_DETAIL_REFERENCED_RELATION_ABSENT,
  FINGERPRINT_DETAIL_COLUMN_MISSING
} = require("./migrationBaseline");

const {
  ensureRecoveryInfrastructure,
  fetchRecoveryBlocks,
  evaluateRecoveryPersistenceCapability,
  REASON_ORPHAN_UNRECORDED
} = require("./migrationRecoveryBlocks");



const ORPHAN_TABLE = "schema_migration_orphans";



const CAUSE_LEDGER_ORPHAN = "MIGRATION_LEDGER_ORPHAN";



async function orphansTableExists(queryable) {

  const result = await queryable.query(

    `SELECT EXISTS (

       SELECT 1

       FROM information_schema.tables

       WHERE table_schema = 'public'

         AND table_name = $1

     ) AS exists`,

    [ORPHAN_TABLE]

  );



  return Boolean(result.rows[0]?.exists);

}



async function fetchUnresolvedOrphans(queryable) {

  const exists = await orphansTableExists(queryable);



  if (!exists) {

    return { tableExists: false, rows: [] };

  }



  const result = await queryable.query(

    `SELECT filename, checksum_sha256, detected_at, detected_by, cause_code, cause_detail

     FROM ${ORPHAN_TABLE}

     WHERE resolved_at IS NULL

     ORDER BY filename`

  );



  return { tableExists: true, rows: result.rows };

}



async function recordOrphanFailure(queryable, payload) {

  const {

    filename,

    checksum,

    detectedBy,

    causeCode = CAUSE_LEDGER_ORPHAN,

    causeDetail

  } = payload;



  let exists = await orphansTableExists(queryable);



  if (!exists) {

    try {

      await ensureRecoveryInfrastructure(queryable);

      exists = await orphansTableExists(queryable);

    } catch {

      exists = false;

    }

  }



  if (!exists) {

    return { recorded: false, reason: "orphan table missing" };

  }



  await queryable.query(

    `INSERT INTO ${ORPHAN_TABLE} (

       filename,

       checksum_sha256,

       detected_by,

       cause_code,

       cause_detail,

       resolved_at,

       resolved_by

     ) VALUES ($1, $2, $3, $4, $5, NULL, NULL)

     ON CONFLICT (filename) DO UPDATE

     SET checksum_sha256 = EXCLUDED.checksum_sha256,

         detected_at = NOW(),

         detected_by = EXCLUDED.detected_by,

         cause_code = EXCLUDED.cause_code,

         cause_detail = EXCLUDED.cause_detail,

         resolved_at = NULL,

         resolved_by = NULL`,

    [filename, checksum, detectedBy || null, causeCode, causeDetail || null]

  );



  return { recorded: true };

}



async function resolveOrphan(queryable, filename, resolvedBy) {

  const exists = await orphansTableExists(queryable);



  if (!exists) {

    return { resolved: false };

  }



  const result = await queryable.query(

    `UPDATE ${ORPHAN_TABLE}

     SET resolved_at = NOW(),

         resolved_by = $2

     WHERE filename = $1

       AND resolved_at IS NULL`,

    [filename, resolvedBy || null]

  );



  return { resolved: result.rowCount > 0 };

}



function checkIndicatesPrerequisiteAbsent(check) {
  if (!check || check.ok) {
    return false;
  }

  const detail = check.detail;
  const type = check.type;

  if (
    detail === FINGERPRINT_DETAIL_REFERENCED_RELATION_ABSENT ||
    detail === FINGERPRINT_DETAIL_COLUMN_MISSING
  ) {
    return true;
  }

  if (type === "regclass" && (detail === null || detail === undefined)) {
    return true;
  }

  if (type === "column" && detail === false) {
    return true;
  }

  if (type === "index" && detail === false) {
    return true;
  }

  if (type === "constraint" && detail === false) {
    return false;
  }

  if (type === "data" && typeof detail === "number") {
    return false;
  }

  if (type === "exists" && detail === false) {
    return false;
  }

  if (type === "column_characteristics" && typeof detail === "string") {
    return false;
  }

  return false;
}

function fingerprintIndicatesNotYetApplied(fingerprint) {
  if (!fingerprint?.fingerprintConfigured || fingerprint.allPass !== false) {
    return false;
  }

  const checks = fingerprint.checks || [];

  if (checks.length === 0) {
    return false;
  }

  if (checks.some((item) => item.ok)) {
    return false;
  }

  return checks.every((item) => checkIndicatesPrerequisiteAbsent(item));
}

function classifyPendingKind({

  recordedOrphan,

  recoveryBlock,

  fingerprint

}) {

  if (recoveryBlock) {

    return "recovery_blocked";

  }



  if (recordedOrphan) {

    return "suspected_orphan";

  }



  if (fingerprint.fingerprintConfigured && fingerprint.allPass === true) {

    return "suspected_orphan";

  }



  if (fingerprint.fingerprintConfigured && fingerprint.allPass === false) {
    if (fingerprintIndicatesNotYetApplied(fingerprint)) {
      return "normal_pending";
    }

    return "uncertain_partial";

  }



  return "normal_pending";

}



async function assessPendingOrphanRisk(queryable, manifest, pendingItem, context = {}) {

  const filename = pendingItem.filename;

  const reasons = [];

  let recordedOrphan = false;



  const orphans = await fetchUnresolvedOrphans(queryable);

  const orphanRow = orphans.rows.find((row) => row.filename === filename);



  if (orphanRow) {

    recordedOrphan = true;

    reasons.push("persistent orphan record (schema_migration_orphans)");

  }



  const recovery = await fetchRecoveryBlocks(queryable);

  const recoveryBlock = recovery.rows.find((row) => row.filename === filename);



  if (recoveryBlock) {

    reasons.push(

      `recovery block (${recoveryBlock.reason_code || REASON_ORPHAN_UNRECORDED})`

    );

  }



  const fingerprint = await evaluateFilenameFingerprints(

    queryable,

    manifest,

    filename

  );



  if (fingerprint.fingerprintConfigured && fingerprint.allPass) {

    reasons.push("manifest fingerprint checks passed while ledger row is missing");

  }



  if (fingerprint.fingerprintConfigured && fingerprint.allPass === false) {
    if (fingerprintIndicatesNotYetApplied(fingerprint)) {
      reasons.push(
        "manifest fingerprint checks indicate schema prerequisites for this migration are not present"
      );
    } else {
      reasons.push(
        "manifest fingerprint checks failed — partial or missing schema/seed evidence"
      );
    }
  }



  let pendingKind = classifyPendingKind({

    recordedOrphan,

    recoveryBlock: Boolean(recoveryBlock),

    fingerprint

  });

  if (context.recoveryPersistenceCapable === false && context.ledgerTablePresent) {

    pendingKind = "recovery_blocked";

    reasons.push(

      `recovery persistence tables missing (${(context.missingRecoveryTables || []).join(", ")})`

    );

  }



  const migrateUpBlocked =

    pendingKind === "suspected_orphan" ||

    pendingKind === "uncertain_partial" ||

    pendingKind === "recovery_blocked";



  return {

    filename,

    checksum: pendingItem.checksum,

    pendingKind,

    suspectedOrphan: migrateUpBlocked,

    recordedOrphan,

    recoveryBlocked: Boolean(recoveryBlock),

    recoveryBlockReason: recoveryBlock?.reason_code || null,

    orphanChecksumSha256: orphanRow?.checksum_sha256 ?? null,

    fingerprint,

    reasons

  };

}



async function enrichInventoryWithOrphanState(queryable, manifest, inventory) {

  const pendingAssessment = [];

  const persistence = await evaluateRecoveryPersistenceCapability(

    queryable,

    inventory.ledgerTablePresent

  );

  const assessmentContext = {

    ledgerTablePresent: inventory.ledgerTablePresent,

    recoveryPersistenceCapable: persistence.capable,

    missingRecoveryTables: persistence.missingTables

  };



  for (const item of inventory.pending) {

    pendingAssessment.push(

      await assessPendingOrphanRisk(queryable, manifest, item, assessmentContext)

    );

  }



  const suspectedOrphans = pendingAssessment.filter((item) => item.suspectedOrphan);

  const normalPending = pendingAssessment.filter((item) => !item.suspectedOrphan);



  return {

    ...inventory,

    pendingAssessment,

    normalPending,

    suspectedOrphans,

    unresolvedOrphanCount: suspectedOrphans.length,

    recoveryPersistenceCapable: persistence.capable,

    missingRecoveryTables: persistence.missingTables

  };

}



function buildPendingStateVisibility(enriched) {

  const pick = (kind) =>

    (enriched.pendingAssessment || [])

      .filter((item) => item.pendingKind === kind)

      .map((item) => ({

        filename: item.filename,

        pendingKind: item.pendingKind,

        recordedOrphan: item.recordedOrphan,

        recoveryBlocked: item.recoveryBlocked,

        reasons: item.reasons

      }));



  return {

    uncertainPartial: pick("uncertain_partial"),

    recoveryBlocked: pick("recovery_blocked"),

    suspectedOrphan: pick("suspected_orphan"),

    recoveryPersistenceCapable: enriched.recoveryPersistenceCapable,

    missingRecoveryTables: enriched.missingRecoveryTables || []

  };

}



function formatOrphanBlockMessage(assessment) {

  const lines = [

    `migrate:up blocked for "${assessment.filename}" (${assessment.pendingKind}).`,

    "Automatic migrate:up retries are denied after uncertain or failed application evidence.",

    `Evidence: ${assessment.reasons.join("; ")}.`,

    "Approved recovery:",

    `  1. Run migrate:verify and migrate:status to review orphan state.`,

    `  2. If schema effects are confirmed, run: npm run migrate:repair-ledger -- --filename ${assessment.filename}`,

    "  3. If repair-ledger refuses (insufficient fingerprint evidence), perform manual DBA review.",

    "  4. Do not use migrate:up for this file until the ledger is repaired or manual recovery is complete."

  ];



  if (assessment.pendingKind === "uncertain_partial") {

    lines.push(

      "  5. After manual review only: migrate:up --allow-retry-filename <file> with OPTALYNX_MIGRATE_ALLOW_RETRY_CONFIRM=I_CONFIRM_MIGRATION_RETRY."

    );

  }



  return lines.join("\n");

}



function assertMigrateUpAllowedForPending(enrichedInventory, options = {}) {

  const { allowRetryFilename = null } = options;

  const blocked = enrichedInventory.suspectedOrphans || [];

  const retryFilename = String(allowRetryFilename || "").trim();



  const stillBlocked = blocked.filter((item) => {

    if (

      retryFilename &&

      item.filename === retryFilename &&

      item.pendingKind === "uncertain_partial"

    ) {

      return false;

    }



    return true;

  });



  if (stillBlocked.length === 0) {

    return;

  }



  const messages = stillBlocked.map((item) => formatOrphanBlockMessage(item));

  throw new Error(messages.join("\n\n"));

}



function buildRepairEligibility(assessment, currentChecksum) {

  if (assessment.pendingKind === "normal_pending") {

    return {

      eligible: false,

      reason: "File is not classified as a suspected orphan."

    };

  }



  if (assessment.recoveryBlocked) {

    return {

      eligible: false,

      reason:

        "A recovery block is active for this filename. Resolve the block via manual DBA review before repair-ledger."

    };

  }



  if (!assessment.fingerprint.fingerprintConfigured) {

    return {

      eligible: false,

      reason:

        "No manifest fingerprint is configured for this migration; automatic repair is not safe. Manual DBA review required."

    };

  }



  if (assessment.fingerprint.allPass !== true) {

    return {

      eligible: false,

      reason:

        "Manifest fingerprint checks did not pass; schema effects are not sufficiently verified for ledger repair."

    };

  }



  if (assessment.recordedOrphan) {

    const stored = assessment.orphanChecksumSha256;

    if (!stored || !String(stored).trim()) {

      return {

        eligible: false,

        reason:

          "Orphan record is missing a stored checksum; automatic repair is not safe. Manual DBA review required."

      };

    }

    if (String(stored).trim() !== String(currentChecksum).trim()) {

      return {

        eligible: false,

        reason:

          "Orphan record checksum does not match the current migration file (possible drift). Resolve checksum drift before repair."

      };

    }

  }



  return { eligible: true };

}



module.exports = {

  ORPHAN_TABLE,

  CAUSE_LEDGER_ORPHAN,

  orphansTableExists,

  fetchUnresolvedOrphans,

  recordOrphanFailure,

  resolveOrphan,

  assessPendingOrphanRisk,

  enrichInventoryWithOrphanState,

  formatOrphanBlockMessage,

  assertMigrateUpAllowedForPending,

  buildRepairEligibility,

  classifyPendingKind,

  checkIndicatesPrerequisiteAbsent,

  fingerprintIndicatesNotYetApplied,

  buildPendingStateVisibility

};
