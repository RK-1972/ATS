/**
 * Phase 5G — ATS stage alias foundation verification.
 * Run: node scripts/verifyPhase5gAtsStageAlias.js
 */
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const atsStageAliasService = require("../services/atsStageAliasService");

const PROVEN_ALIASES = [
  { legacy_value: "L1 Technical", stage_code: "L1_INTERVIEW", display_name: "L1 Interview" },
  { legacy_value: "L1 Non-Technical", stage_code: "L1_INTERVIEW", display_name: "L1 Interview" },
  { legacy_value: "L2 Technical", stage_code: "L2_INTERVIEW", display_name: "L2 Interview" },
  { legacy_value: "L2 Non-Technical", stage_code: "L2_INTERVIEW", display_name: "L2 Interview" },
  { legacy_value: "Client Round", stage_code: "CLIENT_INTERVIEW", display_name: "Client Interview" }
];

const AMBIGUOUS_VALUES = [
  "Interview Scheduled",
  "HR Interview Scheduled",
  "L1 Interview Scheduled",
  "L1 Technical Cleared",
  "HR Cleared",
  "Offered",
  "Screen Select",
  "To be screened"
];

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

function pass(label) {
  console.log(`PASS: ${label}`);
}

function fail(label, detail) {
  console.error(`FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
  process.exitCode = 1;
}

function skip(label, detail) {
  console.log(`SKIP: ${label}${detail ? ` — ${detail}` : ""}`);
}

async function ensureMigrationApplied() {
  const tableCheck = await pool.query(
    `SELECT EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = 'rm_ats_stage_alias'
    ) AS exists`
  );

  if (tableCheck.rows[0]?.exists) {
    pass("rm_ats_stage_alias table exists");
    return;
  }

  const migrationPath = path.join(
    __dirname,
    "..",
    "migrations",
    "051_rm_ats_stage_alias.sql"
  );
  const sql = fs.readFileSync(migrationPath, "utf8");
  await pool.query(sql);
  pass("applied migration 051_rm_ats_stage_alias.sql");
}

async function main() {
  console.log("=== Phase 5G ATS Stage Alias Foundation ===\n");

  const mappingCountBefore = (
    await pool.query(`SELECT COUNT(*)::int AS total FROM rm_candidate_mappings`)
  ).rows[0].total;
  const historyCountBefore = (
    await pool.query(`SELECT COUNT(*)::int AS total FROM rm_pipeline_history`)
  ).rows[0].total;

  await ensureMigrationApplied();

  const aliasCount = (
    await pool.query(
      `SELECT COUNT(*)::int AS total
       FROM rm_ats_stage_alias
       WHERE is_active = TRUE`
    )
  ).rows[0].total;

  if (aliasCount !== PROVEN_ALIASES.length) {
    fail("seeded alias count", `expected=${PROVEN_ALIASES.length}, got=${aliasCount}`);
  } else {
    pass(`seeded ${aliasCount} active aliases`);
  }

  const invalidFk = await pool.query(
    `SELECT a.alias_id, a.legacy_value
     FROM rm_ats_stage_alias a
     LEFT JOIN rm_ats_stage_catalog c ON c.stage_id = a.stage_id
     WHERE c.stage_id IS NULL`
  );

  if (invalidFk.rows.length > 0) {
    fail("aliases reference valid catalog stages", `orphan aliases=${invalidFk.rows.length}`);
  } else {
    pass("aliases reference valid catalog stages");
  }

  try {
    await pool.query(
      `INSERT INTO rm_ats_stage_alias (legacy_value, stage_id, is_active)
       SELECT 'L1 Technical', stage_id, TRUE
       FROM rm_ats_stage_catalog
       WHERE stage_code = 'L1_INTERVIEW'
       LIMIT 1`
    );
    fail("duplicate active legacy_value prevented");
  } catch (error) {
    if (error.code === "23505") {
      pass("duplicate active legacy_value prevented");
    } else {
      fail("duplicate active legacy_value prevented", error.message);
    }
  }

  for (const alias of PROVEN_ALIASES) {
    const resolved = await atsStageAliasService.resolveLegacyStageAlias(
      pool,
      alias.legacy_value
    );

    if (!resolved) {
      fail(`resolve alias ${alias.legacy_value}`, "no match");
      continue;
    }

    if (
      resolved.catalog.stage_code !== alias.stage_code
      || resolved.catalog.display_name !== alias.display_name
    ) {
      fail(
        `resolve alias ${alias.legacy_value}`,
        `got ${resolved.catalog.stage_code}/${resolved.catalog.display_name}`
      );
    } else {
      pass(`resolve alias ${alias.legacy_value} -> ${resolved.catalog.display_name}`);
    }
  }

  for (const value of AMBIGUOUS_VALUES) {
    const resolved = await atsStageAliasService.resolveLegacyStageAlias(pool, value);
    if (resolved) {
      fail(`ambiguous value remains unmapped (${value})`, resolved.catalog.display_name);
    } else {
      pass(`ambiguous value unmapped (${value})`);
    }
  }

  const aliases = await atsStageAliasService.listActiveAtsStageAliases(pool);
  if (aliases.length !== PROVEN_ALIASES.length) {
    fail("listActiveAtsStageAliases count", String(aliases.length));
  } else {
    pass("listActiveAtsStageAliases returns deterministic ordered rows");
  }

  const mappingCountAfter = (
    await pool.query(`SELECT COUNT(*)::int AS total FROM rm_candidate_mappings`)
  ).rows[0].total;
  const historyCountAfter = (
    await pool.query(`SELECT COUNT(*)::int AS total FROM rm_pipeline_history`)
  ).rows[0].total;

  if (mappingCountAfter !== mappingCountBefore) {
    fail("rm_candidate_mappings row count unchanged");
  } else {
    pass("rm_candidate_mappings row count unchanged");
  }

  if (historyCountAfter !== historyCountBefore) {
    fail("rm_pipeline_history row count unchanged");
  } else {
    pass("rm_pipeline_history row count unchanged");
  }

  if (process.exitCode) {
    console.error("\nPhase 5G ATS stage alias verification completed with failures.");
  } else {
    console.log("\nAll Phase 5G ATS stage alias checks passed.");
  }

  await pool.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
