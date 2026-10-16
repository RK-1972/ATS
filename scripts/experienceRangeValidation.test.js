const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const {
  collectExperienceRangeErrors
} = require("../utils/experienceRangeValidation");

describe("experienceRangeValidation", () => {
  it("rejects negative minimum and maximum experience", () => {
    const errors = collectExperienceRangeErrors(-1, -2);
    assert.ok(errors.some((message) => /experience_min cannot be negative/.test(message)));
    assert.ok(errors.some((message) => /experience_max cannot be negative/.test(message)));
  });

  it("accepts zero and valid non-negative experience values", () => {
    assert.deepEqual(collectExperienceRangeErrors(0, 0), []);
    assert.deepEqual(collectExperienceRangeErrors(0, 5), []);
    assert.deepEqual(collectExperienceRangeErrors("", ""), []);
  });

  it("rejects min greater than max", () => {
    const errors = collectExperienceRangeErrors(8, 2);
    assert.deepEqual(errors, ["experience_min cannot be greater than experience_max."]);
  });
});
