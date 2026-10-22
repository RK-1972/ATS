const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveAuthoritativeAnnualCtc,
  amountsMatch,
  hasCompleteCompensationMetadata
} = require("../services/compensationCalculationService");

describe("compensationCalculationService helpers", () => {
  it("uses offered_ctc when request matches", () => {
    const value = resolveAuthoritativeAnnualCtc({ offered_ctc: 1200000 }, 1200000);
    assert.equal(value, 1200000);
  });

  it("rejects mismatched requested CTC", () => {
    assert.throws(() => {
      resolveAuthoritativeAnnualCtc({ offered_ctc: 1200000 }, 1000000);
    });
  });

  it("detects complete compensation metadata", () => {
    assert.equal(
      hasCompleteCompensationMetadata({
        compensation_snapshot: { structureId: "S1" },
        compensation_annual_ctc: 100,
        compensation_structure_id: "S1"
      }),
      true
    );
    assert.equal(
      hasCompleteCompensationMetadata({
        compensation_snapshot: null,
        compensation_annual_ctc: 100,
        compensation_structure_id: "S1"
      }),
      false
    );
  });

  it("matches amounts within tolerance", () => {
    assert.equal(amountsMatch(100, 100.005), true);
    assert.equal(amountsMatch(100, 101), false);
  });
});
