const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const {
  FINGERPRINT_DETAIL_REFERENCED_RELATION_ABSENT,
  FINGERPRINT_DETAIL_COLUMN_MISSING
} = require("./lib/migrationBaseline");
const {
  classifyPendingKind,
  fingerprintIndicatesNotYetApplied
} = require("./lib/migrationOrphans");

describe("pending migration fingerprint classification", () => {
  it("classifies greenfield prerequisite absence as normal_pending", () => {
    const fingerprint = {
      fingerprintConfigured: true,
      allPass: false,
      checks: [
        {
          type: "data",
          ok: false,
          detail: FINGERPRINT_DETAIL_REFERENCED_RELATION_ABSENT
        },
        { type: "regclass", ok: false, detail: null }
      ]
    };

    assert.equal(fingerprintIndicatesNotYetApplied(fingerprint), true);
    assert.equal(
      classifyPendingKind({
        recordedOrphan: false,
        recoveryBlock: false,
        fingerprint
      }),
      "normal_pending"
    );
  });

  it("classifies mixed present and missing evidence as uncertain_partial", () => {
    const fingerprint = {
      fingerprintConfigured: true,
      allPass: false,
      checks: [
        { type: "regclass", ok: true, detail: "public.rm_ats_stage_catalog" },
        {
          type: "data",
          ok: false,
          detail: 0
        }
      ]
    };

    assert.equal(fingerprintIndicatesNotYetApplied(fingerprint), false);
    assert.equal(
      classifyPendingKind({
        recordedOrphan: false,
        recoveryBlock: false,
        fingerprint
      }),
      "uncertain_partial"
    );
  });

  it("classifies failed seed/data evidence with existing schema as uncertain_partial", () => {
    const fingerprint = {
      fingerprintConfigured: true,
      allPass: false,
      checks: [
        {
          type: "exists",
          ok: false,
          detail: false
        }
      ]
    };

    assert.equal(fingerprintIndicatesNotYetApplied(fingerprint), false);
    assert.equal(
      classifyPendingKind({
        recordedOrphan: false,
        recoveryBlock: false,
        fingerprint
      }),
      "uncertain_partial"
    );
  });

  it("classifies all-pass fingerprints without ledger as suspected_orphan", () => {
    const fingerprint = {
      fingerprintConfigured: true,
      allPass: true,
      checks: [{ type: "regclass", ok: true, detail: "public.schema_migrations" }]
    };

    assert.equal(
      classifyPendingKind({
        recordedOrphan: false,
        recoveryBlock: false,
        fingerprint
      }),
      "suspected_orphan"
    );
  });

  it("keeps recovery blocks effective", () => {
    const fingerprint = {
      fingerprintConfigured: true,
      allPass: false,
      checks: [
        {
          type: "data",
          ok: false,
          detail: FINGERPRINT_DETAIL_REFERENCED_RELATION_ABSENT
        }
      ]
    };

    assert.equal(
      classifyPendingKind({
        recordedOrphan: false,
        recoveryBlock: true,
        fingerprint
      }),
      "recovery_blocked"
    );
  });

  it("classifies wrong column characteristics as uncertain_partial", () => {
    const fingerprint = {
      fingerprintConfigured: true,
      allPass: false,
      checks: [
        {
          type: "column_characteristics",
          ok: false,
          detail: "character varying(50)"
        }
      ]
    };

    assert.equal(fingerprintIndicatesNotYetApplied(fingerprint), false);
    assert.equal(
      classifyPendingKind({
        recordedOrphan: false,
        recoveryBlock: false,
        fingerprint
      }),
      "uncertain_partial"
    );
  });

  it("classifies missing column via column_characteristics metadata as not yet applied", () => {
    const fingerprint = {
      fingerprintConfigured: true,
      allPass: false,
      checks: [
        {
          type: "column_characteristics",
          ok: false,
          detail: FINGERPRINT_DETAIL_COLUMN_MISSING
        }
      ]
    };

    assert.equal(fingerprintIndicatesNotYetApplied(fingerprint), true);
    assert.equal(
      classifyPendingKind({
        recordedOrphan: false,
        recoveryBlock: false,
        fingerprint
      }),
      "normal_pending"
    );
  });
});
