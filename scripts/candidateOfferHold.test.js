const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const candidateOfferHoldService = require("../services/candidateOfferHoldService");

describe("candidateOfferHoldService scheduling helpers", () => {
  it("treats same-day future time as future interview", () => {
    const reference = new Date("2026-06-15T04:00:00.000Z");
    const row = {
      interview_date: "2026-06-15",
      interview_time: "18:30:00"
    };

    assert.equal(
      candidateOfferHoldService.isFutureOrCurrentInterview(row, reference),
      true
    );
  });

  it("treats past calendar date as not future", () => {
    const reference = new Date("2026-06-15T12:00:00.000Z");
    const row = {
      interview_date: "2026-06-14",
      interview_time: "10:00:00"
    };

    assert.equal(
      candidateOfferHoldService.isFutureOrCurrentInterview(row, reference),
      false
    );
  });
});

describe("candidateOfferHoldService release reason validation", () => {
  it("exposes stable block message for mutations", () => {
    assert.match(
      candidateOfferHoldService.OFFER_HOLD_BLOCK_MESSAGE,
      /Offer Hold/i
    );
  });
});
