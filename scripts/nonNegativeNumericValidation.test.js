const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const {
  assertStrictlyPositiveNumber,
  collectNonNegativeNumberErrors,
  collectOpeningsCountErrors,
  collectStrictlyPositiveNumberErrors
} = require("../utils/nonNegativeNumericValidation");

describe("nonNegativeNumericValidation", () => {
  it("rejects negative non-negative quantities", () => {
    const errors = collectNonNegativeNumberErrors("amount", -5, {
      label: "Amount",
      allowBlank: true
    });
    assert.ok(errors.some((message) => /cannot be negative/.test(message)));
  });

  it("allows zero for optional non-negative fields", () => {
    assert.deepEqual(
      collectNonNegativeNumberErrors("amount", 0, {
        label: "Amount",
        allowBlank: true
      }),
      []
    );
  });

  it("allows blank optional non-negative fields", () => {
    assert.deepEqual(
      collectNonNegativeNumberErrors("amount", "", {
        label: "Amount",
        allowBlank: true
      }),
      []
    );
  });

  it("requires strictly positive offer amounts", () => {
    assert.throws(
      () => assertStrictlyPositiveNumber(-100, "Offered CTC"),
      (error) => {
        assert.equal(error.status, 400);
        assert.match(error.message, /greater than 0/i);
        return true;
      }
    );
  });

  it("accepts positive offer amounts", () => {
    assert.equal(assertStrictlyPositiveNumber(1200000, "Offered CTC"), 1200000);
  });

  it("rejects negative and fractional openings counts", () => {
    assert.ok(
      collectOpeningsCountErrors(-2).some((message) =>
        /whole number of at least 1/.test(message)
      )
    );
    assert.ok(
      collectOpeningsCountErrors(1.5).some((message) =>
        /whole number of at least 1/.test(message)
      )
    );
  });

  it("accepts valid openings counts", () => {
    assert.deepEqual(collectOpeningsCountErrors(3), []);
    assert.deepEqual(collectStrictlyPositiveNumberErrors("offered_ctc", 100, { label: "Offered CTC" }), []);
  });

  it("assertOptionalStrictlyPositiveNumber preserves blank optional values", () => {
    const { assertOptionalStrictlyPositiveNumber } = require("../utils/nonNegativeNumericValidation");
    assert.equal(assertOptionalStrictlyPositiveNumber("", "Counter CTC"), null);
  });
});
