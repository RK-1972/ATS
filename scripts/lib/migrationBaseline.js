const fs = require("fs");

const path = require("path");



const { DEFAULT_BASELINE_MANIFEST } = require("./migrationConstants");

const { listMigrationSqlFiles } = require("./migrationFiles");

const {

  buildEffectiveManifest,

  dedupeChecks

} = require("./migrationManifestDerive");

const { getExplicitSeedChecks } = require("./migrationSeedDataChecks");



function loadBaselineManifest(manifestPath = DEFAULT_BASELINE_MANIFEST) {

  if (!fs.existsSync(manifestPath)) {

    return { version: 2, fingerprints: {} };

  }



  const raw = fs.readFileSync(manifestPath, "utf8");

  const parsed = JSON.parse(raw);



  if (!parsed || typeof parsed !== "object") {

    throw new Error("Invalid baseline manifest JSON.");

  }



  return parsed;

}



function getEffectiveManifest(migrationsDir, manifestPath = DEFAULT_BASELINE_MANIFEST) {

  const base = loadBaselineManifest(manifestPath);

  const files = listMigrationSqlFiles(migrationsDir);

  const manifest = buildEffectiveManifest(migrationsDir, base, files);



  for (const filename of files) {

    const extra = getExplicitSeedChecks(filename);



    if (extra.length) {

      manifest.fingerprints[filename].checks = dedupeChecks([

        ...extra,

        ...(manifest.fingerprints[filename]?.checks || [])

      ]);

    }

  }



  return manifest;

}



const PG_UNDEFINED_TABLE = "42P01";

const FINGERPRINT_DETAIL_REFERENCED_RELATION_ABSENT = "referenced relation does not exist";
const FINGERPRINT_DETAIL_COLUMN_MISSING = "column missing";

function fingerprintMissingRelationResult() {
  return { ok: false, detail: FINGERPRINT_DETAIL_REFERENCED_RELATION_ABSENT };
}

function isUndefinedTableError(error) {
  return Boolean(error && error.code === PG_UNDEFINED_TABLE);
}

async function runFingerprintCheck(queryable, check) {

  if (!check || !check.type) {

    return { ok: false, reason: "missing check type" };

  }



  if (check.type === "regclass") {

    const result = await queryable.query("SELECT to_regclass($1) AS reg", [

      check.object

    ]);

    const present = Boolean(result.rows[0]?.reg);

    const expectPresent = check.expect !== "absent";



    return {

      ok: expectPresent ? present : !present,

      detail: present ? String(result.rows[0].reg) : null

    };

  }



  if (check.type === "column") {

    const result = await queryable.query(

      `SELECT EXISTS (

         SELECT 1

         FROM information_schema.columns

         WHERE table_schema = $1

           AND table_name = $2

           AND column_name = $3

       ) AS exists`,

      [check.schema || "public", check.table, check.column]

    );

    const present = Boolean(result.rows[0]?.exists);

    const expectPresent = check.expect !== "absent";



    return { ok: expectPresent ? present : !present, detail: present };

  }

  if (check.type === "column_characteristics") {
    const result = await queryable.query(
      `SELECT data_type, character_maximum_length
       FROM information_schema.columns
       WHERE table_schema = $1
         AND table_name = $2
         AND column_name = $3`,
      [check.schema || "public", check.table, check.column]
    );
    const row = result.rows[0];

    if (!row) {
      return { ok: false, detail: FINGERPRINT_DETAIL_COLUMN_MISSING };
    }

    const typeOk =
      !check.expectDataType || row.data_type === check.expectDataType;
    const lengthOk =
      check.expectMaxLength === undefined ||
      Number(row.character_maximum_length) === Number(check.expectMaxLength);

    return {
      ok: typeOk && lengthOk,
      detail: `${row.data_type}(${row.character_maximum_length})`
    };
  }

  if (check.type === "constraint") {
    try {
      const result = await queryable.query(
        `SELECT EXISTS (
           SELECT 1
           FROM pg_constraint
           WHERE conname = $1
             AND conrelid = ($2)::regclass
         ) AS exists`,
        [check.constraint, `public.${check.table}`]
      );
      const present = Boolean(result.rows[0]?.exists);
      const expectPresent = check.expect !== "absent";

      return { ok: expectPresent ? present : !present, detail: present };
    } catch (error) {
      if (isUndefinedTableError(error)) {
        return fingerprintMissingRelationResult();
      }
      throw error;
    }
  }

  if (check.type === "index") {

    const result = await queryable.query(

      `SELECT EXISTS (

         SELECT 1

         FROM pg_indexes

         WHERE schemaname = $1

           AND indexname = $2

       ) AS exists`,

      [check.schema || "public", check.index]

    );

    const present = Boolean(result.rows[0]?.exists);

    const expectPresent = check.expect !== "absent";



    return { ok: expectPresent ? present : !present, detail: present };

  }



  if (check.type === "data") {
    try {
      const result = await queryable.query(check.query);

      const row = result.rows[0] || {};

      const field = check.field || "c";

      const value = Number(row[field] ?? row.count ?? 0);

      let ok = true;

      if (check.expectMin !== undefined) {
        ok = value >= check.expectMin;
      }

      if (check.expectEquals !== undefined) {
        ok = value === check.expectEquals;
      }

      return { ok, detail: value };
    } catch (error) {
      if (isUndefinedTableError(error)) {
        return fingerprintMissingRelationResult();
      }
      throw error;
    }
  }

  if (check.type === "exists") {
    try {
      const result = await queryable.query(check.query);

      const present = Boolean(result.rows[0]?.exists);

      return { ok: present, detail: present };
    } catch (error) {
      if (isUndefinedTableError(error)) {
        return fingerprintMissingRelationResult();
      }
      throw error;
    }
  }



  return { ok: false, reason: `unsupported check type: ${check.type}` };

}



async function evaluateFilenameFingerprints(queryable, manifest, filename) {

  const entry = manifest.fingerprints?.[filename];



  if (!entry || !Array.isArray(entry.checks) || entry.checks.length === 0) {

    return {

      filename,

      fingerprintConfigured: false,

      checks: [],

      allPass: null,

      recommendation: "manual-review"

    };

  }



  const checks = [];



  for (const check of entry.checks) {

    const outcome = await runFingerprintCheck(queryable, check);

    checks.push({

      type: check.type,

      tier: check.tier || null,

      ok: outcome.ok,

      detail: outcome.detail ?? outcome.reason ?? null,

      proves: check.proves || null,

      cannotProve: check.cannotProve || null

    });

  }



  const allPass = checks.every((item) => item.ok);



  return {

    filename,

    fingerprintConfigured: true,

    checks,

    allPass,

    recommendation: allPass ? "mark-applied-candidate" : "needs-apply-or-manual-review"

  };

}



async function buildBaselinePlan(queryable, manifest, inventory) {

  const recommendations = [];



  for (const item of inventory.pending) {

    const evaluation = await evaluateFilenameFingerprints(

      queryable,

      manifest,

      item.filename

    );



    recommendations.push({

      filename: item.filename,

      ledgerStatus: "pending",

      ...evaluation

    });

  }



  for (const item of inventory.applied) {

    recommendations.push({

      filename: item.filename,

      ledgerStatus: "applied",

      fingerprintConfigured: false,

      recommendation: "already-recorded"

    });

  }



  for (const item of inventory.drift) {

    recommendations.push({

      filename: item.filename,

      ledgerStatus: "drift",

      fingerprintConfigured: false,

      recommendation: "resolve-checksum-drift"

    });

  }



  return {

    adoptionEnabled: false,

    note:

      "Baseline adoption is disabled in Phase 1. This plan is read-only and does not modify the ledger.",

    recommendations

  };

}



module.exports = {

  loadBaselineManifest,

  getEffectiveManifest,

  runFingerprintCheck,

  evaluateFilenameFingerprints,

  buildBaselinePlan,

  FINGERPRINT_DETAIL_REFERENCED_RELATION_ABSENT,

  FINGERPRINT_DETAIL_COLUMN_MISSING

};
