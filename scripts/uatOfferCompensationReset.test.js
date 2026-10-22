const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  isIncompleteCompensationMetadata,
  AWAITING_LETTER_STATUS
} = require("../services/uatOfferCompensationResetService");
const offerLetterValidation = require("../services/offerLetterValidation");
const { GENERATED_LETTER_STATUS } = require("../repositories/offerLetterRepository");

describe("uatOfferCompensationResetService", () => {
  it("detects incomplete compensation metadata", () => {
    assert.equal(isIncompleteCompensationMetadata(null), true);
    assert.equal(
      isIncompleteCompensationMetadata({
        compensation_snapshot: { structureId: "S1" },
        compensation_annual_ctc: 100,
        compensation_structure_id: "S1"
      }),
      false
    );
    assert.equal(
      isIncompleteCompensationMetadata({
        compensation_snapshot: null,
        compensation_annual_ctc: 100,
        compensation_structure_id: "S1"
      }),
      true
    );
  });

  it("blocks generated PDF access after letter reverted to awaiting", () => {
    const row = {
      offer_status: "Approved",
      letter_status: AWAITING_LETTER_STATUS
    };

    assert.throws(() => {
      offerLetterValidation.assertGeneratedLetterAccess(row);
    }, /Generated offer letter is not available/);
  });

  it("allows generated PDF access only for generated letter status", () => {
    const row = {
      offer_status: "Approved",
      letter_status: GENERATED_LETTER_STATUS
    };

    offerLetterValidation.assertGeneratedLetterAccess(row);
  });
});
