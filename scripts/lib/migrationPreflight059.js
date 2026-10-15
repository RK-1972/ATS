const MIGRATION_059_FILENAME = "059_candidate_registered_pan_unique.sql";

/**
 * Matches migration 059 filters: REGISTERED candidates with non-blank PAN.
 * Does not select or log PAN values.
 */
const DUPLICATE_PAN_SUMMARY_SQL = `
SELECT
  COUNT(*)::int AS duplicate_pan_groups,
  COALESCE(SUM(row_count), 0)::int AS affected_registered_rows
FROM (
  SELECT COUNT(*)::int AS row_count
  FROM cand_mstr
  WHERE UPPER(TRIM(candidate_status)) = 'REGISTERED'
    AND pan_number IS NOT NULL
    AND TRIM(pan_number) <> ''
  GROUP BY UPPER(TRIM(pan_number))
  HAVING COUNT(*) > 1
) duplicate_groups`;

async function tableExists(queryable, tableName) {
  const result = await queryable.query(
    `SELECT EXISTS (
       SELECT 1
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = $1
     ) AS exists`,
    [tableName]
  );

  return Boolean(result.rows[0]?.exists);
}

async function runRegisteredPanDuplicatePreflight(queryable) {
  const hasTable = await tableExists(queryable, "cand_mstr");

  if (!hasTable) {
    return {
      ok: false,
      skipped: false,
      reason: "cand_mstr table is missing",
      duplicatePanGroups: 0,
      affectedRegisteredRows: 0,
      nextStep:
        "Apply prerequisite candidate schema migrations before 059."
    };
  }

  const result = await queryable.query(DUPLICATE_PAN_SUMMARY_SQL);
  const duplicatePanGroups = Number(result.rows[0]?.duplicate_pan_groups || 0);
  const affectedRegisteredRows = Number(
    result.rows[0]?.affected_registered_rows || 0
  );

  if (duplicatePanGroups > 0) {
    return {
      ok: false,
      skipped: false,
      reason: "duplicate normalized PAN values among REGISTERED candidates",
      duplicatePanGroups,
      affectedRegisteredRows,
      nextStep:
        "Resolve duplicate REGISTERED candidate PAN data, then re-run migrate:plan and migrate:up."
    };
  }

  return {
    ok: true,
    skipped: false,
    duplicatePanGroups: 0,
    affectedRegisteredRows: 0
  };
}

function pendingIncludes059(pendingFilenames) {
  return pendingFilenames.some(
    (name) => name === MIGRATION_059_FILENAME || name?.filename === MIGRATION_059_FILENAME
  );
}

function assertPreflight059AllowsMigration(preflightResult) {
  if (preflightResult.ok) {
    return;
  }

  throw new Error(
    [
      `Migration blocked: preflight failed for ${MIGRATION_059_FILENAME}.`,
      `Reason: ${preflightResult.reason}.`,
      `Duplicate PAN groups: ${preflightResult.duplicatePanGroups}.`,
      `Affected REGISTERED rows: ${preflightResult.affectedRegisteredRows}.`,
      preflightResult.nextStep || ""
    ]
      .filter(Boolean)
      .join(" ")
  );
}

module.exports = {
  MIGRATION_059_FILENAME,
  DUPLICATE_PAN_SUMMARY_SQL,
  runRegisteredPanDuplicatePreflight,
  pendingIncludes059,
  assertPreflight059AllowsMigration
};
