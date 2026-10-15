const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const {
  getEffectiveManifest,
  evaluateFilenameFingerprints,
  runFingerprintCheck,
  FINGERPRINT_DETAIL_REFERENCED_RELATION_ABSENT
} = require("./lib/migrationBaseline");
const { DEFAULT_MIGRATIONS_DIR } = require("./lib/migrationConstants");
const { buildRepairEligibility } = require("./lib/migrationOrphans");
const { getExplicitSeedChecks } = require("./lib/migrationSeedDataChecks");

function get020ConstraintColumnOrderCheck() {
  return getExplicitSeedChecks("020_approval_route_unique_constraint.sql").find(
    (item) => item.query?.includes("unnest(c.conkey)")
  );
}

function get015SourceIdForeignKeyCheck() {
  return getExplicitSeedChecks("015_rm_candidate_intake_schema.sql").find(
    (item) => item.query?.includes("md_candidate_sources")
  );
}

function create020ColumnOrderQueryable(constraintColumnOrder) {
  return {
    query: async (sql) => {
      const text = String(sql);
      if (
        !text.includes("unnest(c.conkey)") ||
        !text.includes("uq_approval_route_applies_to_route_name")
      ) {
        return { rows: [{ exists: false }] };
      }

      const ok =
        Array.isArray(constraintColumnOrder) &&
        constraintColumnOrder.length === 2 &&
        constraintColumnOrder[0] === "applies_to" &&
        constraintColumnOrder[1] === "route_name";

      return { rows: [{ exists: ok }] };
    }
  };
}

function create015ForeignKeyQueryable({ referencedTable, referencedColumn, confdeltype }) {
  return {
    query: async (sql) => {
      const text = String(sql);
      if (
        !text.includes("rm_candidate_intake") ||
        !text.includes("md_candidate_sources") ||
        !text.includes("confdeltype")
      ) {
        return { rows: [{ exists: false }] };
      }

      const ok =
        referencedTable === "md_candidate_sources" &&
        referencedColumn === "id" &&
        confdeltype === "a";

      return { rows: [{ exists: ok }] };
    }
  };
}

const PHASE1_FILES = [
  "010_interview_stages_schema.sql",
  "013_rm_candidate_sources_schema.sql",
  "015_rm_candidate_intake_schema.sql",
  "020_approval_route_unique_constraint.sql",
  "059_candidate_registered_pan_unique.sql"
];

describe("Phase 1 strengthened migration fingerprints", () => {
  it("defines strengthened checks for each Phase 1 migration", () => {
    const manifest = getEffectiveManifest(DEFAULT_MIGRATIONS_DIR);

    for (const filename of PHASE1_FILES) {
      const seedChecks = getExplicitSeedChecks(filename);
      const effectiveCount = manifest.fingerprints[filename].checks.length;

      if (filename === "059_candidate_registered_pan_unique.sql") {
        assert.ok(seedChecks.length >= 1, "expected seed index-definition check for 059");
        assert.ok(
          effectiveCount >= 2,
          "expected baseline index name + seed definition checks for 059"
        );
        continue;
      }

      assert.ok(seedChecks.length >= 2, `expected >=2 seed checks for ${filename}`);
      assert.ok(effectiveCount >= 2, `expected >=2 effective checks for ${filename}`);
    }
  });

  it("010 registry check fails when table_name does not match catalog view", async () => {
    const check = getExplicitSeedChecks("010_interview_stages_schema.sql")[0];
    const queryable = {
      query: async () => ({ rows: [{ exists: false }] })
    };

    const result = await runFingerprintCheck(queryable, check);
    assert.equal(result.ok, false);
  });

  it("013 partial schema (table only) fails allPass and blocks repair-ledger", async () => {
    const manifest = getEffectiveManifest(DEFAULT_MIGRATIONS_DIR);
    const queryable = {
      query: async (sql) => {
        const text = String(sql);

        if (text.includes("to_regclass")) {
          return { rows: [{ reg: "rm_candidate_sources" }] };
        }

        if (text.includes("information_schema.columns")) {
          return { rows: [{ exists: false }] };
        }

        if (text.includes("pg_constraint") || text.includes("pg_indexes")) {
          return { rows: [{ exists: false }] };
        }

        return { rows: [{ exists: false }] };
      }
    };

    const evaluation = await evaluateFilenameFingerprints(
      queryable,
      manifest,
      "013_rm_candidate_sources_schema.sql"
    );

    assert.equal(evaluation.fingerprintConfigured, true);
    assert.equal(evaluation.allPass, false);

    const eligibility = buildRepairEligibility(
      {
        pendingKind: "suspected_orphan",
        recoveryBlocked: false,
        recordedOrphan: false,
        fingerprint: evaluation
      },
      "a".repeat(64)
    );

    assert.equal(eligibility.eligible, false);
    assert.match(eligibility.reason, /did not pass/i);
  });

  it("015 missing prerequisite tables classify as not yet applied", () => {
    const fingerprint = {
      fingerprintConfigured: true,
      allPass: false,
      checks: [
        {
          type: "regclass",
          ok: false,
          detail: FINGERPRINT_DETAIL_REFERENCED_RELATION_ABSENT
        },
        {
          type: "column",
          ok: false,
          detail: FINGERPRINT_DETAIL_REFERENCED_RELATION_ABSENT
        }
      ]
    };

    const { fingerprintIndicatesNotYetApplied } = require("./lib/migrationOrphans");
    assert.equal(fingerprintIndicatesNotYetApplied(fingerprint), true);
  });

  describe("020 unique constraint column order (conkey ordinality)", () => {
    it("passes when declared order is (applies_to, route_name) despite physical attnum order", async () => {
      const pairCheck = get020ConstraintColumnOrderCheck();
      assert.ok(pairCheck);
      assert.match(pairCheck.query, /unnest\(c\.conkey\).*ORDINALITY/i);

      const attnameByAttnum = { 2: "route_name", 4: "applies_to" };
      const attnumOrder = Object.keys(attnameByAttnum)
        .map(Number)
        .sort((a, b) => a - b)
        .map((num) => attnameByAttnum[num]);
      assert.deepEqual(attnumOrder, ["route_name", "applies_to"]);

      const result = await runFingerprintCheck(
        create020ColumnOrderQueryable(["applies_to", "route_name"]),
        pairCheck
      );
      assert.equal(result.ok, true);
    });

    it("fails when unique constraint column order is reversed", async () => {
      const pairCheck = get020ConstraintColumnOrderCheck();
      const result = await runFingerprintCheck(
        create020ColumnOrderQueryable(["route_name", "applies_to"]),
        pairCheck
      );
      assert.equal(result.ok, false);
    });

    it("fails when unique constraint uses different columns", async () => {
      const pairCheck = get020ConstraintColumnOrderCheck();
      const result = await runFingerprintCheck(
        create020ColumnOrderQueryable(["applies_to", "status"]),
        pairCheck
      );
      assert.equal(result.ok, false);
    });
  });

  describe("015 source_id foreign key target and ON DELETE", () => {
    it("passes for REFERENCES md_candidate_sources(id) with default NO ACTION", async () => {
      const fkCheck = get015SourceIdForeignKeyCheck();
      assert.ok(fkCheck);
      assert.match(fkCheck.query, /confdeltype = 'a'/);

      const result = await runFingerprintCheck(
        create015ForeignKeyQueryable({
          referencedTable: "md_candidate_sources",
          referencedColumn: "id",
          confdeltype: "a"
        }),
        fkCheck
      );
      assert.equal(result.ok, true);
    });

    it("fails when source_id references a different table", async () => {
      const fkCheck = get015SourceIdForeignKeyCheck();
      const result = await runFingerprintCheck(
        create015ForeignKeyQueryable({
          referencedTable: "rm_candidate_sources",
          referencedColumn: "id",
          confdeltype: "a"
        }),
        fkCheck
      );
      assert.equal(result.ok, false);
    });

    it("fails when ON DELETE is not NO ACTION", async () => {
      const fkCheck = get015SourceIdForeignKeyCheck();
      const result = await runFingerprintCheck(
        create015ForeignKeyQueryable({
          referencedTable: "md_candidate_sources",
          referencedColumn: "id",
          confdeltype: "c"
        }),
        fkCheck
      );
      assert.equal(result.ok, false);
    });
  });

  it("059 index definition check does not query PAN values", () => {
    const checks = getExplicitSeedChecks("059_candidate_registered_pan_unique.sql");
    const defCheck = checks[0];

    assert.ok(defCheck.query);
    assert.doesNotMatch(defCheck.query, /pan_number\s*=/i);
    assert.doesNotMatch(defCheck.query, /SELECT\s+pan/i);
    assert.match(defCheck.query, /pg_get_indexdef/i);
  });

  it("059 partial index mismatch fails fingerprint evaluation", async () => {
    const manifest = getEffectiveManifest(DEFAULT_MIGRATIONS_DIR);
    const queryable = {
      query: async (sql) => {
        const text = String(sql);

        if (text.includes("pg_indexes") && text.includes("indexname")) {
          return { rows: [{ exists: true }] };
        }

        if (text.includes("pg_get_indexdef")) {
          return { rows: [{ exists: false }] };
        }

        if (text.includes("to_regclass")) {
          return { rows: [{ reg: null }] };
        }

        if (text.includes("information_schema")) {
          return { rows: [{ exists: true }] };
        }

        if (text.includes("pg_constraint")) {
          return { rows: [{ exists: true }] };
        }

        return { rows: [{ exists: false }] };
      }
    };

    const evaluation = await evaluateFilenameFingerprints(
      queryable,
      manifest,
      "059_candidate_registered_pan_unique.sql"
    );

    assert.equal(evaluation.allPass, false);
  });
});
