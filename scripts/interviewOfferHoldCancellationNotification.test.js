const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  buildOfferHoldCancelCorrelationId
} = require("../services/interviewNotificationService");

describe("offer-hold interview cancellation notifications", () => {
  it("builds per-recipient correlation ids for idempotent delivery", () => {
    const a = buildOfferHoldCancelCorrelationId(
      42,
      "INT-1",
      "alice@example.com"
    );
    const b = buildOfferHoldCancelCorrelationId(
      42,
      "INT-1",
      "alice@example.com"
    );
    const c = buildOfferHoldCancelCorrelationId(
      42,
      "INT-1",
      "bob@example.com"
    );

    assert.equal(a, b);
    assert.notEqual(a, c);
    assert.match(a, /^offer-hold-cancel-/);
  });
});
