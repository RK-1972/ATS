const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const {
  assertOptionalStrictlyPositiveNumber
} = require("../utils/nonNegativeNumericValidation");

describe("offer negotiation numeric validation", () => {
  it("allows blank optional counter_ctc", () => {
    assert.equal(assertOptionalStrictlyPositiveNumber("", "Counter CTC"), null);
    assert.equal(assertOptionalStrictlyPositiveNumber(null, "Counter CTC"), null);
  });

  it("rejects negative counter_ctc", () => {
    assert.throws(
      () => assertOptionalStrictlyPositiveNumber(-50000, "Counter CTC"),
      (error) => {
        assert.equal(error.status, 400);
        assert.match(error.message, /greater than 0/i);
        return true;
      }
    );
  });

  it("accepts positive counter_ctc", () => {
    assert.equal(
      assertOptionalStrictlyPositiveNumber(1800000, "Counter CTC"),
      1800000
    );
  });
});
