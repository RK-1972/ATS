const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

function normalizeOptionalAmount(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const amount = Number(value);
  if (!Number.isFinite(amount)) {
    const error = new Error("Amount must be a valid number.");
    error.status = 400;
    throw error;
  }

  if (amount < 0) {
    const error = new Error("Amount cannot be negative.");
    error.status = 400;
    throw error;
  }

  return amount;
}

describe("approval policy amount normalization", () => {
  it("rejects negative min_amount values", () => {
    assert.throws(
      () => normalizeOptionalAmount(-100),
      (error) => {
        assert.equal(error.status, 400);
        assert.match(error.message, /cannot be negative/i);
        return true;
      }
    );
  });

  it("allows blank optional amounts", () => {
    assert.equal(normalizeOptionalAmount(""), null);
    assert.equal(normalizeOptionalAmount(null), null);
  });

  it("allows zero amounts", () => {
    assert.equal(normalizeOptionalAmount(0), 0);
  });
});
