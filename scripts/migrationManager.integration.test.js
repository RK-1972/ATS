/**
 * Disposable PostgreSQL integration tests.
 * Requires TEST_DATABASE_URL + OPTALYNX_MIG_TEST_DESTROY_CONFIRM (never uses dotenv).
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { describe, it, before, after } = require("node:test");

const { applySingleMigration } = require("./lib/migrationRunner");
const {
  LEDGER_MIGRATION_FILENAME,
  ADVISORY_LOCK_KEY
} = require("./lib/migrationConstants");
const { assessBaselineAdoptEligibility } = require("./lib/migrationBaselineAdopt");
const { fileChecksum } = require("./lib/migrationFiles");
const {
  evaluateFilenameFingerprints,
  getEffectiveManifest
} = require("./lib/migrationBaseline");
const {
  runRegisteredPanDuplicatePreflight,
  MIGRATION_059_FILENAME
} = require("./lib/migrationPreflight059");
const { repairLedgerForFilename } = require("./lib/migrationRepair");
const { assertRetryOrderingAllowed } = require("./lib/migrationRetryOrder");
const { enrichInventoryWithOrphanState } = require("./lib/migrationOrphans");
const { computeMigrationInventory } = require("./lib/migrationLedger");
const { buildFingerprintReviewReport } = require("./lib/migrationFingerprintReviewReport");
const {
  assertSafeDatabaseName,
  assertSafeTestTarget,
  parsePostgresUrl,
  assertIntegrationPgProbeSucceeded
} = require("./lib/migrationIntegrationGuards");
const {
  MIGRATIONS_DIR_ENV,
  prerequisiteMessage,
  probePostgresAvailability,
  recreateTestDatabase,
  recreateTestDatabaseWithFreshPool,
  destroyTestDatabase,
  createTestPool,
  prepareFixtureMigrationsDir,
  removeFixtureDir,
  spawnMigrateCli,
  buildBaselineAdoptCliEnv,
  queryBaselineAdoptSideEffects,
  parseCliJson
} = require("./lib/migrationIntegrationHarness");

const ALLOW_RETRY_CONFIRM = "I_CONFIRM_MIGRATION_RETRY";

const BASELINE_ADOPT_OK_FILENAME = "950_baseline_adopt_ok.sql";
const BASELINE_ADOPT_UNCERTAIN_FILENAME = "951_baseline_adopt_uncertain.sql";
const BASELINE_ADOPT_NORMAL_FILENAME = "952_baseline_adopt_normal.sql";

const BASELINE_ADOPT_FIXTURE_SQL = {
  [BASELINE_ADOPT_OK_FILENAME]:
    "CREATE TABLE IF NOT EXISTS mig_baseline_adopt (id int, sql_executed_marker boolean DEFAULT true);\n",
  [BASELINE_ADOPT_UNCERTAIN_FILENAME]:
    "CREATE TABLE IF NOT EXISTS mig_uncertain_adopt (id int);\nCREATE INDEX IF NOT EXISTS mig_uncertain_adopt_idx ON mig_uncertain_adopt (id);\n",
  [BASELINE_ADOPT_NORMAL_FILENAME]:
    "CREATE TABLE IF NOT EXISTS mig_normal_adopt (id int);\n"
};

async function bootstrapFixtureLedger(pool, fixtureDir) {
  await applySingleMigration(pool, {
    migrationsDir: fixtureDir,
    filename: LEDGER_MIGRATION_FILENAME,
    appliedBy: "integration"
  });
}

async function establishEligibleSuspectedOrphan(pool, fixtureDir, filename) {
  await bootstrapFixtureLedger(pool, fixtureDir);
  await pool.query("CREATE TABLE IF NOT EXISTS mig_baseline_adopt (id int)");

  const assessment = await assessBaselineAdoptEligibility(pool, fixtureDir, filename);
  assert.equal(assessment.pendingKind, "suspected_orphan", assessment.refusalReasons.join("; "));
  assert.equal(assessment.eligible, true, assessment.refusalReasons.join("; "));
  return assessment;
}

function spawnBaselineAdopt(fixtureDir, filename, config, { dryRun = false, confirm = false } = {}) {
  const args = [
    "baseline-adopt",
    "--filename",
    filename,
    "--json"
  ];

  if (dryRun) {
    args.push("--dry-run");
  } else if (confirm) {
    args.push("--confirm");
  }

  const env = confirm
    ? buildBaselineAdoptCliEnv(fixtureDir, filename)
    : { [MIGRATIONS_DIR_ENV]: fixtureDir };

  return spawnMigrateCli(args, config, env);
}

describe("migration integration guards (no database)", () => {
  it("refuses forbidden database names", () => {
    assert.throws(() => assertSafeDatabaseName("ats_dev"), /forbidden database/i);
    assert.throws(() => assertSafeDatabaseName("neondb"), /forbidden database/i);
  });

  it("allows optalynx_mig_test disposable name", () => {
    assertSafeDatabaseName("optalynx_mig_test");
    assertSafeDatabaseName("optalynx_mig_test_run1");
  });

  it("refuses ats_dev in TEST_DATABASE_URL target", () => {
    assert.throws(
      () =>
        assertSafeTestTarget(
          parsePostgresUrl("postgresql://postgres:postgres@127.0.0.1:5432/ats_dev")
        ),
      /forbidden database/i
    );
  });

  it("refuses neon-like hosts", () => {
    assert.throws(
      () =>
        assertSafeTestTarget({
          host: "ep-foo.neon.tech",
          port: 5432,
          user: "u",
          password: "p",
          database: "optalynx_mig_test"
        }),
      /non-local host/i
    );
  });
});

describe("migration fingerprint review report", () => {
  it("documents existence/count limitations without claiming full equivalence", () => {
    const report = buildFingerprintReviewReport();
    assert.ok(report.fileCount > 0);
    assert.match(report.disclaimer, /do NOT prove complete schema or seed equivalence/i);
    assert.ok(report.byFilename["001_master_data_schema.sql"]);
    assert.ok(
      report.byFilename["001_master_data_schema.sql"].some((item) =>
        /Minimum row count|existence/i.test(item.limitation)
      )
    );
  });
});

describe("migration manager PostgreSQL integration", () => {
  let probe;
  let config;
  let pool;
  let fixtureDir;

  before(async () => {
    probe = await probePostgresAvailability();
    assertIntegrationPgProbeSucceeded(probe);

    if (!probe.available) {
      return;
    }

    config = probe.config;
    await recreateTestDatabase();
    pool = createTestPool(config);
  });

  after(async () => {
    if (!probe?.available) {
      return;
    }

    if (pool) {
      await pool.end().catch(() => {});
    }

    await destroyTestDatabase();
    removeFixtureDir(fixtureDir);
  });

  it("reports prerequisites when TEST_DATABASE_URL is unavailable", async () => {
    if (probe.available) {
      assert.ok(config.database.startsWith("optalynx_mig_test"));
      return;
    }

    assert.ok(probe.error);
    assert.match(prerequisiteMessage(probe.error), /TEST_DATABASE_URL/);
  });

  it("bootstraps migration 000 and recovery tables", async (t) => {
    if (!probe.available) {
      t.skip(prerequisiteMessage(probe.error));
      return;
    }

    fixtureDir = prepareFixtureMigrationsDir();
    await applySingleMigration(pool, {
      migrationsDir: fixtureDir,
      filename: LEDGER_MIGRATION_FILENAME,
      appliedBy: "integration"
    });

    const tables = await pool.query(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN (
           'schema_migrations',
           'schema_migration_orphans',
           'schema_migration_recovery_blocks'
         )
       ORDER BY table_name`
    );

    assert.deepEqual(
      tables.rows.map((row) => row.table_name),
      [
        "schema_migration_orphans",
        "schema_migration_recovery_blocks",
        "schema_migrations"
      ]
    );
  });

  it("rolls back non-self-managed SQL failures without ledger row", async (t) => {
    if (!probe.available) {
      t.skip(prerequisiteMessage(probe.error));
      return;
    }

    const dir = prepareFixtureMigrationsDir({
      "911_plain_fail.sql": "SELECT 1/0;\n"
    });

    await assert.rejects(
      () =>
        applySingleMigration(pool, {
          migrationsDir: dir,
          filename: "911_plain_fail.sql",
          appliedBy: "integration"
        }),
      /division by zero|SQL failed/i
    );

    const ledger = await pool.query(
      "SELECT filename FROM schema_migrations WHERE filename = $1",
      ["911_plain_fail.sql"]
    );
    assert.equal(ledger.rowCount, 0);
    removeFixtureDir(dir);
  });

  it("does not record ledger when self-managed SQL fails", async (t) => {
    if (!probe.available) {
      t.skip(prerequisiteMessage(probe.error));
      return;
    }

    const dir = prepareFixtureMigrationsDir({
      "912_self_fail.sql": "BEGIN;\nSELECT 1/0;\nCOMMIT;\n"
    });

    await assert.rejects(
      () =>
        applySingleMigration(pool, {
          migrationsDir: dir,
          filename: "912_self_fail.sql",
          appliedBy: "integration"
        }),
      (error) => error.code === "MIGRATION_SQL_FAILED"
    );

    const ledger = await pool.query(
      "SELECT filename FROM schema_migrations WHERE filename = $1",
      ["912_self_fail.sql"]
    );
    assert.equal(ledger.rowCount, 0);
    removeFixtureDir(dir);
  });

  it("records orphan row when self-managed SQL commits but ledger insert is blocked", async (t) => {
    if (!probe.available) {
      t.skip(prerequisiteMessage(probe.error));
      return;
    }

    await pool.query(`
      CREATE OR REPLACE FUNCTION mig_test_block_ledger_insert()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'integration_test_ledger_block';
      END;
      $$ LANGUAGE plpgsql;
    `);
    await pool.query(`
      DROP TRIGGER IF EXISTS mig_test_block_ledger_ins ON schema_migrations;
      CREATE TRIGGER mig_test_block_ledger_ins
      BEFORE INSERT ON schema_migrations
      FOR EACH ROW EXECUTE PROCEDURE mig_test_block_ledger_insert();
    `);

    const dir = prepareFixtureMigrationsDir({
      "913_self_ok.sql":
        "BEGIN;\nCREATE TABLE IF NOT EXISTS mig_int_orphan (id int);\nCOMMIT;\n"
    });

    await assert.rejects(
      () =>
        applySingleMigration(pool, {
          migrationsDir: dir,
          filename: "913_self_ok.sql",
          appliedBy: "integration"
        }),
      /MIGRATION_LEDGER_ORPHAN/
    );

    const orphan = await pool.query(
      `SELECT filename, checksum_sha256
       FROM schema_migration_orphans
       WHERE filename = $1 AND resolved_at IS NULL`,
      ["913_self_ok.sql"]
    );
    assert.equal(orphan.rowCount, 1);

    await pool.query(
      "DROP TRIGGER IF EXISTS mig_test_block_ledger_ins ON schema_migrations"
    );
    await pool.query("DROP FUNCTION IF EXISTS mig_test_block_ledger_insert()");
    removeFixtureDir(dir);
  });

  it("recreates orphan persistence when orphans table missing and ledger insert fails", async (t) => {
    if (!probe.available) {
      t.skip(prerequisiteMessage(probe.error));
      return;
    }

    const ledgerTrigger = "mig_test_block_ledger_ins";
    const ledgerFn = "mig_test_block_ledger_insert";
    let dir;

    async function cleanupLedgerBlocker() {
      await pool.query(
        `DROP TRIGGER IF EXISTS ${ledgerTrigger} ON schema_migrations`
      );
      await pool.query(`DROP FUNCTION IF EXISTS ${ledgerFn}()`);
    }

    try {
      await pool.query("DROP TABLE IF EXISTS schema_migration_orphans CASCADE");

      await pool.query(`
        CREATE OR REPLACE FUNCTION ${ledgerFn}()
        RETURNS trigger AS $$
        BEGIN
          RAISE EXCEPTION 'integration_test_ledger_block';
        END;
        $$ LANGUAGE plpgsql;
      `);
      await pool.query(`
        DROP TRIGGER IF EXISTS ${ledgerTrigger} ON schema_migrations;
        CREATE TRIGGER ${ledgerTrigger}
        BEFORE INSERT ON schema_migrations
        FOR EACH ROW EXECUTE PROCEDURE ${ledgerFn}();
      `);

      dir = prepareFixtureMigrationsDir({
        "914_self_ok.sql":
          "BEGIN;\nCREATE TABLE IF NOT EXISTS mig_int_recovery (id int);\nCOMMIT;\n"
      });

      await assert.rejects(
        () =>
          applySingleMigration(pool, {
            migrationsDir: dir,
            filename: "914_self_ok.sql",
            appliedBy: "integration"
          }),
        (error) => error.code === "MIGRATION_LEDGER_ORPHAN"
      );

      const orphan = await pool.query(
        `SELECT filename
         FROM schema_migration_orphans
         WHERE filename = $1 AND resolved_at IS NULL`,
        ["914_self_ok.sql"]
      );
      assert.equal(orphan.rowCount, 1);

      const ledger = await pool.query(
        "SELECT filename FROM schema_migrations WHERE filename = $1",
        ["914_self_ok.sql"]
      );
      assert.equal(ledger.rowCount, 0);

      const orphansTable = await pool.query(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.tables
           WHERE table_schema = 'public' AND table_name = 'schema_migration_orphans'
         ) AS exists`
      );
      assert.equal(orphansTable.rows[0].exists, true);

      const ledger000 = await pool.query(
        "SELECT 1 FROM schema_migrations WHERE filename = $1",
        [LEDGER_MIGRATION_FILENAME]
      );
      assert.equal(ledger000.rowCount, 1);
    } finally {
      removeFixtureDir(dir);
      await cleanupLedgerBlocker().catch(() => {});
    }
  });

  it("blocks migrate:up across CLI when recovery persistence tables are missing", async (t) => {
    if (!probe.available) {
      t.skip(prerequisiteMessage(probe.error));
      return;
    }

    await pool.query("DROP TABLE IF EXISTS schema_migration_orphans CASCADE");
    await pool.query("DROP TABLE IF EXISTS schema_migration_recovery_blocks CASCADE");

    const result = spawnMigrateCli(["up", "--json"], config);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}${result.stdout}`, /recovery persistence tables are missing/i);
  });

  it("refuses retry override when an earlier pending migration exists", async (t) => {
    if (!probe.available) {
      t.skip(prerequisiteMessage(probe.error));
      return;
    }

    pool = await recreateTestDatabaseWithFreshPool(pool, config);

    const dir = prepareFixtureMigrationsDir({
      "911_first.sql": "CREATE TABLE IF NOT EXISTS mig_first (id int);\n",
      "912_second.sql": "CREATE TABLE IF NOT EXISTS mig_second (id int);\n"
    });

    await applySingleMigration(pool, {
      migrationsDir: dir,
      filename: LEDGER_MIGRATION_FILENAME,
      appliedBy: "integration"
    });

    const manifest = getEffectiveManifest(dir);
    const inventory = computeMigrationInventory(dir, {
      tableExists: true,
      rows: (
        await pool.query("SELECT filename, checksum_sha256 FROM schema_migrations")
      ).rows
    });
    const enriched = await enrichInventoryWithOrphanState(pool, manifest, inventory);

    assert.throws(
      () => assertRetryOrderingAllowed(inventory.pending, enriched, "912_second.sql"),
      /not the first pending migration/i
    );

    removeFixtureDir(dir);
  });

  it("allows retry override only when target is first pending uncertain_partial", async (t) => {
    if (!probe.available) {
      t.skip(prerequisiteMessage(probe.error));
      return;
    }

    const dir = prepareFixtureMigrationsDir({
      "920_uncertain.sql": "CREATE TABLE IF NOT EXISTS mig_uncertain (id int);\n"
    });

    const manifest = getEffectiveManifest(dir);
    const pendingItem = {
      filename: "920_uncertain.sql",
      checksum: "abc"
    };
    const enriched = {
      pendingAssessment: [
        {
          filename: "920_uncertain.sql",
          pendingKind: "uncertain_partial",
          reasons: ["manifest fingerprint checks failed"]
        }
      ]
    };

    assertRetryOrderingAllowed([pendingItem], enriched, "920_uncertain.sql");
    removeFixtureDir(dir);
  });

  it("blocks concurrent migrate:up with advisory lock held", async (t) => {
    if (!probe.available) {
      t.skip(prerequisiteMessage(probe.error));
      return;
    }

    let lockFixtureDir;
    let locker;

    try {
      pool = await recreateTestDatabaseWithFreshPool(pool, config);

      lockFixtureDir = prepareFixtureMigrationsDir({
        "911_lock_pending.sql": "SELECT 1;\n"
      });

      await applySingleMigration(pool, {
        migrationsDir: lockFixtureDir,
        filename: LEDGER_MIGRATION_FILENAME,
        appliedBy: "integration"
      });

      locker = await pool.connect();
      await locker.query("SELECT pg_advisory_lock(913782451)");

      const blocked = spawnMigrateCli(["up", "--json"], config, {
        [MIGRATIONS_DIR_ENV]: lockFixtureDir
      });
      assert.notEqual(blocked.status, 0);
      assert.match(`${blocked.stderr}${blocked.stdout}`, /advisory lock/i);
      assert.doesNotMatch(
        `${blocked.stderr}${blocked.stdout}`,
        /preflight failed for 059_candidate_registered_pan_unique/i
      );
    } finally {
      if (locker) {
        await locker.query("SELECT pg_advisory_unlock(913782451)").catch(() => {});
        locker.release();
      }
      removeFixtureDir(lockFixtureDir);
    }
  });

  it("repair-ledger accepts valid orphan recovery and refuses checksum mismatch", async (t) => {
    if (!probe.available) {
      t.skip(prerequisiteMessage(probe.error));
      return;
    }

    pool = await recreateTestDatabaseWithFreshPool(pool, config);

    const dir = prepareFixtureMigrationsDir({
      "930_repair.sql":
        "BEGIN;\nCREATE TABLE IF NOT EXISTS mig_repair (id int);\nCOMMIT;\n"
    });

    await applySingleMigration(pool, {
      migrationsDir: dir,
      filename: LEDGER_MIGRATION_FILENAME,
      appliedBy: "integration"
    });

    await pool.query("CREATE TABLE IF NOT EXISTS mig_repair (id int)");

    await pool.query(
      `INSERT INTO schema_migration_orphans (
         filename, checksum_sha256, cause_code
       ) VALUES ($1, $2, 'MIGRATION_LEDGER_ORPHAN')`,
      ["930_repair.sql", "0".repeat(64)]
    );

    await assert.rejects(
      () => repairLedgerForFilename(pool, dir, "930_repair.sql", "integration"),
      /checksum does not match/i
    );

    const { fileChecksum } = require("./lib/migrationFiles");
    const checksum = fileChecksum(dir, "930_repair.sql");
    await pool.query(
      "UPDATE schema_migration_orphans SET checksum_sha256 = $2 WHERE filename = $1",
      ["930_repair.sql", checksum]
    );

    await pool.query("BEGIN");
    await pool.query(
      `INSERT INTO schema_migration_orphans (
         filename, checksum_sha256, cause_code
       ) VALUES ($1, $2, 'MIGRATION_LEDGER_ORPHAN')
       ON CONFLICT (filename) DO UPDATE
       SET checksum_sha256 = EXCLUDED.checksum_sha256,
           resolved_at = NULL`,
      ["930_repair.sql", checksum]
    );
    await pool.query("COMMIT");

    const repaired = await repairLedgerForFilename(
      pool,
      dir,
      "930_repair.sql",
      "integration"
    );
    assert.equal(repaired.migrationSqlExecuted, false);

    const applied = await pool.query(
      "SELECT filename FROM schema_migrations WHERE filename = $1",
      ["930_repair.sql"]
    );
    assert.equal(applied.rowCount, 1);
    removeFixtureDir(dir);
  });

  it("validates migration 060 column characteristics on real PostgreSQL metadata", async (t) => {
    if (!probe.available) {
      t.skip(prerequisiteMessage(probe.error));
      return;
    }

    const manifest = getEffectiveManifest(
      path.join(__dirname, "..", "migrations")
    );

    await pool.query("DROP TABLE IF EXISTS interview_panel_mstr");
    let evaluation = await evaluateFilenameFingerprints(
      pool,
      manifest,
      "060_interview_panel_mstr_employee_code_extend.sql"
    );
    assert.equal(evaluation.allPass, false);

    await pool.query(
      "CREATE TABLE interview_panel_mstr (employee_code VARCHAR(50))"
    );
    evaluation = await evaluateFilenameFingerprints(
      pool,
      manifest,
      "060_interview_panel_mstr_employee_code_extend.sql"
    );
    assert.equal(evaluation.allPass, false);

    await pool.query(
      "ALTER TABLE interview_panel_mstr ALTER COLUMN employee_code TYPE VARCHAR(100)"
    );
    evaluation = await evaluateFilenameFingerprints(
      pool,
      manifest,
      "060_interview_panel_mstr_employee_code_extend.sql"
    );
    assert.equal(evaluation.allPass, true);
  });

  it("runs migration 059 preflight with duplicate counts only (no PAN values)", async (t) => {
    if (!probe.available) {
      t.skip(prerequisiteMessage(probe.error));
      return;
    }

    await pool.query(`
      CREATE TABLE IF NOT EXISTS cand_mstr (
        candidate_id SERIAL PRIMARY KEY,
        candidate_status VARCHAR(32),
        pan_number VARCHAR(32)
      );
    `);
    await pool.query("DELETE FROM cand_mstr");
    await pool.query(
      `INSERT INTO cand_mstr (candidate_status, pan_number)
       VALUES ('REGISTERED', 'abcd1234f'), ('REGISTERED', 'abcd1234f')`
    );

    const preflight = await runRegisteredPanDuplicatePreflight(pool);
    assert.equal(preflight.ok, false);
    assert.ok(preflight.duplicatePanGroups >= 1);

    const serialized = JSON.stringify(preflight);
    assert.ok(!serialized.includes("abcd1234f"));
    assert.ok(!serialized.toLowerCase().includes("pan_value"));
  });

  it("reports recovery and uncertain states via status/plan/dry-run/verify CLI", async (t) => {
    if (!probe.available) {
      t.skip(prerequisiteMessage(probe.error));
      return;
    }

    pool = await recreateTestDatabaseWithFreshPool(pool, config);
    fixtureDir = prepareFixtureMigrationsDir({
      "940_verify.sql": "CREATE TABLE IF NOT EXISTS mig_verify (id int);\n"
    });

    await applySingleMigration(pool, {
      migrationsDir: fixtureDir,
      filename: LEDGER_MIGRATION_FILENAME,
      appliedBy: "integration"
    });

    await pool.query(
      `INSERT INTO schema_migration_recovery_blocks (
         filename, checksum_sha256, reason_code, detail
       ) VALUES ($1, $2, 'MIGRATION_ORPHAN_UNRECORDED', 'integration fixture')`,
      ["940_verify.sql", "f".repeat(64)]
    );

    const fixtureCliEnv = { [MIGRATIONS_DIR_ENV]: fixtureDir };

    for (const command of ["status", "plan", "dry-run", "verify"]) {
      const args = [command, "--json"];
      const result = spawnMigrateCli(args, config, fixtureCliEnv);
      const payload = parseCliJson(result);

      const payloadDiagnostic = [
        `expected JSON payload for migrate:${command}`,
        `status=${result.status}`,
        result.error != null ? `error=${result.error}` : null,
        `stdout:\n${result.stdout ?? ""}`,
        `stderr:\n${result.stderr ?? ""}`
      ]
        .filter(Boolean)
        .join("\n\n");
      assert.ok(payload, payloadDiagnostic);
      assert.ok(Array.isArray(payload.recoveryBlocked));
      assert.ok(
        payload.recoveryBlocked.some((item) => item.filename === "940_verify.sql")
      );
    }

    const verify = spawnMigrateCli(["verify", "--json"], config, fixtureCliEnv);
    const verifyPayload = parseCliJson(verify);
    assert.equal(verifyPayload.ok, false);
  });

  it("baseline-adopt dry-run does not mutate ledger, orphan, or recovery state", async (t) => {
    if (!probe.available) {
      t.skip(prerequisiteMessage(probe.error));
      return;
    }

    let dir;
    try {
      pool = await recreateTestDatabaseWithFreshPool(pool, config);
      dir = prepareFixtureMigrationsDir(BASELINE_ADOPT_FIXTURE_SQL);
      await establishEligibleSuspectedOrphan(pool, dir, BASELINE_ADOPT_OK_FILENAME);

      const before = await queryBaselineAdoptSideEffects(pool, BASELINE_ADOPT_OK_FILENAME);
      assert.equal(before.ledgerRows.length, 0);

      const dryRun = spawnBaselineAdopt(dir, BASELINE_ADOPT_OK_FILENAME, config, {
        dryRun: true
      });
      const payload = parseCliJson(dryRun);

      assert.equal(dryRun.status, 0, `${dryRun.stderr}${dryRun.stdout}`);
      assert.ok(payload);
      assert.equal(payload.mode, "dry-run");
      assert.equal(payload.eligible, true);
      assert.equal(payload.migrationSqlExecuted, false);
      assert.equal(payload.adoptionOutcome, "eligible");

      const after = await queryBaselineAdoptSideEffects(pool, BASELINE_ADOPT_OK_FILENAME);
      assert.deepEqual(after, before);
    } finally {
      removeFixtureDir(dir);
    }
  });

  it("baseline-adopt confirm records ledger without executing migration SQL", async (t) => {
    if (!probe.available) {
      t.skip(prerequisiteMessage(probe.error));
      return;
    }

    let dir;
    try {
      pool = await recreateTestDatabaseWithFreshPool(pool, config);
      dir = prepareFixtureMigrationsDir(BASELINE_ADOPT_FIXTURE_SQL);
      const preflight = await establishEligibleSuspectedOrphan(
        pool,
        dir,
        BASELINE_ADOPT_OK_FILENAME
      );
      const expectedChecksum = fileChecksum(dir, BASELINE_ADOPT_OK_FILENAME);

      const before = await queryBaselineAdoptSideEffects(pool, BASELINE_ADOPT_OK_FILENAME);
      assert.equal(before.migrationSqlMarkerPresent, false);

      const confirm = spawnBaselineAdopt(dir, BASELINE_ADOPT_OK_FILENAME, config, {
        confirm: true
      });
      const payload = parseCliJson(confirm);

      assert.equal(confirm.status, 0, `${confirm.stderr}${confirm.stdout}`);
      assert.ok(payload);
      assert.equal(payload.mode, "confirm");
      assert.equal(payload.adoptionOutcome, "ledger_recorded");
      assert.equal(payload.filename, BASELINE_ADOPT_OK_FILENAME);
      assert.equal(payload.checksum, expectedChecksum);
      assert.equal(payload.migrationSqlExecuted, false);
      assert.equal(payload.fingerprint.configured, true);
      assert.equal(payload.fingerprint.allPass, true);
      assert.equal(preflight.checksum, expectedChecksum);

      const after = await queryBaselineAdoptSideEffects(pool, BASELINE_ADOPT_OK_FILENAME);
      assert.equal(after.ledgerRows.length, 1);
      assert.equal(after.ledgerRows[0].checksum_sha256, expectedChecksum);
      assert.equal(after.migrationSqlMarkerPresent, false);
      assert.equal(after.recoveryRows.length, 0);
      assert.ok(
        after.orphanRows.length === 0 ||
          after.orphanRows.every((row) => row.resolved_at !== null)
      );
    } finally {
      removeFixtureDir(dir);
    }
  });

  it("baseline-adopt refuses normal_pending, uncertain_partial, and recovery_blocked", async (t) => {
    if (!probe.available) {
      t.skip(prerequisiteMessage(probe.error));
      return;
    }

    let dir;
    try {
      pool = await recreateTestDatabaseWithFreshPool(pool, config);
      dir = prepareFixtureMigrationsDir(BASELINE_ADOPT_FIXTURE_SQL);
      await bootstrapFixtureLedger(pool, dir);

      await pool.query(
        "CREATE TABLE IF NOT EXISTS mig_uncertain_adopt (id int)"
      );

      const cases = [
        {
          filename: BASELINE_ADOPT_NORMAL_FILENAME,
          expectedKind: "normal_pending"
        },
        {
          filename: BASELINE_ADOPT_UNCERTAIN_FILENAME,
          expectedKind: "uncertain_partial"
        }
      ];

      for (const { filename, expectedKind } of cases) {
        const assessment = await assessBaselineAdoptEligibility(pool, dir, filename);
        assert.equal(assessment.pendingKind, expectedKind);
        assert.equal(assessment.eligible, false);

        const refused = spawnBaselineAdopt(dir, filename, config, { confirm: true });
        assert.notEqual(refused.status, 0);
        const ledger = await pool.query(
          "SELECT 1 FROM schema_migrations WHERE filename = $1",
          [filename]
        );
        assert.equal(ledger.rowCount, 0);
      }

      await pool.query("CREATE TABLE IF NOT EXISTS mig_baseline_adopt (id int)");
      const eligibleOk = await assessBaselineAdoptEligibility(
        pool,
        dir,
        BASELINE_ADOPT_OK_FILENAME
      );
      assert.equal(eligibleOk.eligible, true, eligibleOk.refusalReasons.join("; "));

      const checksum = fileChecksum(dir, BASELINE_ADOPT_OK_FILENAME);
      await pool.query(
        `INSERT INTO schema_migration_recovery_blocks (
           filename, checksum_sha256, reason_code, detail
         ) VALUES ($1, $2, 'MIGRATION_ORPHAN_UNRECORDED', 'integration recovery block')`,
        [BASELINE_ADOPT_OK_FILENAME, checksum]
      );

      const blocked = await assessBaselineAdoptEligibility(
        pool,
        dir,
        BASELINE_ADOPT_OK_FILENAME
      );
      assert.equal(blocked.pendingKind, "recovery_blocked");
      assert.equal(blocked.eligible, false);

      const blockedCli = spawnBaselineAdopt(dir, BASELINE_ADOPT_OK_FILENAME, config, {
        confirm: true
      });
      assert.notEqual(blockedCli.status, 0);
      const ledgerOk = await pool.query(
        "SELECT 1 FROM schema_migrations WHERE filename = $1",
        [BASELINE_ADOPT_OK_FILENAME]
      );
      assert.equal(ledgerOk.rowCount, 0);
    } finally {
      removeFixtureDir(dir);
    }
  });

  it("baseline-adopt refuses when checksum drift exists anywhere", async (t) => {
    if (!probe.available) {
      t.skip(prerequisiteMessage(probe.error));
      return;
    }

    let dir;
    try {
      pool = await recreateTestDatabaseWithFreshPool(pool, config);
      dir = prepareFixtureMigrationsDir(BASELINE_ADOPT_FIXTURE_SQL);
      await establishEligibleSuspectedOrphan(pool, dir, BASELINE_ADOPT_OK_FILENAME);

      await pool.query(
        `UPDATE schema_migrations
         SET checksum_sha256 = $2
         WHERE filename = $1`,
        [LEDGER_MIGRATION_FILENAME, "0".repeat(64)]
      );

      const drift = spawnBaselineAdopt(dir, BASELINE_ADOPT_OK_FILENAME, config, {
        dryRun: true
      });
      const payload = parseCliJson(drift);
      assert.notEqual(drift.status, 0);
      assert.ok(payload);
      assert.equal(payload.eligible, false);
      assert.ok(
        payload.refusalReasons.some((reason) => /checksum drift/i.test(reason))
      );

      const ledger = await pool.query(
        "SELECT 1 FROM schema_migrations WHERE filename = $1",
        [BASELINE_ADOPT_OK_FILENAME]
      );
      assert.equal(ledger.rowCount, 0);
    } finally {
      removeFixtureDir(dir);
    }
  });

  it("baseline-adopt confirm refuses when advisory lock is held", async (t) => {
    if (!probe.available) {
      t.skip(prerequisiteMessage(probe.error));
      return;
    }

    let dir;
    let locker;
    try {
      pool = await recreateTestDatabaseWithFreshPool(pool, config);
      dir = prepareFixtureMigrationsDir(BASELINE_ADOPT_FIXTURE_SQL);
      await establishEligibleSuspectedOrphan(pool, dir, BASELINE_ADOPT_OK_FILENAME);

      locker = await pool.connect();
      await locker.query("SELECT pg_advisory_lock($1)", [ADVISORY_LOCK_KEY]);

      const blocked = spawnBaselineAdopt(dir, BASELINE_ADOPT_OK_FILENAME, config, {
        confirm: true
      });
      assert.notEqual(blocked.status, 0);
      assert.match(`${blocked.stderr}${blocked.stdout}`, /advisory lock/i);

      const ledger = await pool.query(
        "SELECT 1 FROM schema_migrations WHERE filename = $1",
        [BASELINE_ADOPT_OK_FILENAME]
      );
      assert.equal(ledger.rowCount, 0);
    } finally {
      if (locker) {
        await locker.query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK_KEY]).catch(() => {});
        locker.release();
      }
      removeFixtureDir(dir);
    }
  });

  it("baseline-adopt refuses when an earlier fixture migration is still pending", async (t) => {
    if (!probe.available) {
      t.skip(prerequisiteMessage(probe.error));
      return;
    }

    let dir;
    try {
      pool = await recreateTestDatabaseWithFreshPool(pool, config);
      dir = prepareFixtureMigrationsDir({
        "945_first_pending.sql": "CREATE TABLE IF NOT EXISTS mig_first_pending (id int);\n",
        ...BASELINE_ADOPT_FIXTURE_SQL
      });
      await bootstrapFixtureLedger(pool, dir);
      await pool.query("CREATE TABLE IF NOT EXISTS mig_baseline_adopt (id int)");

      const dryRun = spawnBaselineAdopt(dir, BASELINE_ADOPT_OK_FILENAME, config, {
        dryRun: true
      });
      const payload = parseCliJson(dryRun);

      assert.notEqual(dryRun.status, 0);
      assert.ok(payload);
      assert.equal(payload.eligible, false);
      assert.ok(
        payload.refusalReasons.some((reason) =>
          reason.includes("945_first_pending.sql")
        )
      );

      const ledger = await pool.query(
        "SELECT 1 FROM schema_migrations WHERE filename = $1",
        [BASELINE_ADOPT_OK_FILENAME]
      );
      assert.equal(ledger.rowCount, 0);
    } finally {
      removeFixtureDir(dir);
    }
  });

  it("baseline-adopt dry-run refuses when unknown ledger rows exist", async (t) => {
    if (!probe.available) {
      t.skip(prerequisiteMessage(probe.error));
      return;
    }

    let dir;
    try {
      pool = await recreateTestDatabaseWithFreshPool(pool, config);
      dir = prepareFixtureMigrationsDir(BASELINE_ADOPT_FIXTURE_SQL);
      await establishEligibleSuspectedOrphan(pool, dir, BASELINE_ADOPT_OK_FILENAME);

      await pool.query(
        `INSERT INTO schema_migrations (filename, checksum_sha256, applied_by)
         VALUES ($1, $2, 'integration')`,
        ["999_unknown_migration.sql", "f".repeat(64)]
      );

      const dryRun = spawnBaselineAdopt(dir, BASELINE_ADOPT_OK_FILENAME, config, {
        dryRun: true
      });
      const payload = parseCliJson(dryRun);

      assert.notEqual(dryRun.status, 0);
      assert.ok(payload);
      assert.equal(payload.eligible, false);
      assert.ok(
        payload.refusalReasons.some((reason) =>
          reason.includes("999_unknown_migration.sql")
        )
      );

      const ledger = await pool.query(
        "SELECT 1 FROM schema_migrations WHERE filename = $1",
        [BASELINE_ADOPT_OK_FILENAME]
      );
      assert.equal(ledger.rowCount, 0);
    } finally {
      removeFixtureDir(dir);
    }
  });

  it("repair-ledger refuses when an earlier fixture migration is still pending", async (t) => {
    if (!probe.available) {
      t.skip(prerequisiteMessage(probe.error));
      return;
    }

    let dir;
    try {
      pool = await recreateTestDatabaseWithFreshPool(pool, config);
      dir = prepareFixtureMigrationsDir({
        // Must sort before 930_repair.sql (lexicographic execution order, not numeric intent).
        "920_first_pending.sql": "CREATE TABLE IF NOT EXISTS mig_first_pending (id int);\n",
        "930_repair.sql":
          "BEGIN;\nCREATE TABLE IF NOT EXISTS mig_repair (id int);\nCOMMIT;\n"
      });
      await bootstrapFixtureLedger(pool, dir);
      await pool.query("CREATE TABLE IF NOT EXISTS mig_repair (id int)");

      await assert.rejects(
        () => repairLedgerForFilename(pool, dir, "930_repair.sql", "integration"),
        /earlier pending migrations must be resolved/
      );
    } finally {
      removeFixtureDir(dir);
    }
  });
});
