const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const {
  collectExperienceRangeErrors,
  sanitizeExperienceInput
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
    assert.deepEqual(collectExperienceRangeErrors(null, undefined), []);
  });

  it("rejects malformed numeric strings on save and submit paths", () => {
    const minErrors = collectExperienceRangeErrors("6-", "");
    assert.ok(minErrors.some((message) => /experience_min must be a valid number/.test(message)));

    const maxErrors = collectExperienceRangeErrors("", "2.5.1");
    assert.ok(maxErrors.some((message) => /experience_max must be a valid number/.test(message)));
  });

  it("rejects min greater than max", () => {
    const errors = collectExperienceRangeErrors(8, 2);
    assert.deepEqual(errors, ["experience_min cannot be greater than experience_max."]);
  });
});

describe("sanitizeExperienceInput", () => {
  it("rejects malformed negative syntax and invalid characters", () => {
    assert.equal(sanitizeExperienceInput("6-"), null);
    assert.equal(sanitizeExperienceInput("-3"), null);
    assert.equal(sanitizeExperienceInput("abc"), null);
  });

  it("allows empty optional input and legitimate decimals", () => {
    assert.equal(sanitizeExperienceInput(""), "");
    assert.equal(sanitizeExperienceInput(null), "");
    assert.equal(sanitizeExperienceInput("2.5"), "2.5");
    assert.equal(sanitizeExperienceInput("0"), "0");
  });
});
