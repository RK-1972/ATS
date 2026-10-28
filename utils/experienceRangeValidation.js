/**
 * Shared Talent Demand experience field validation.
 * @param {number|string|null|undefined} experienceMin
 * @param {number|string|null|undefined} experienceMax
 * @returns {string[]} human-readable error messages
 */
function collectExperienceRangeErrors(experienceMin, experienceMax) {
  const errors = [];

  const min =
    experienceMin === "" || experienceMin === null || experienceMin === undefined
      ? null
      : Number(experienceMin);
  const max =
    experienceMax === "" || experienceMax === null || experienceMax === undefined
      ? null
      : Number(experienceMax);

  if (min != null) {
    if (!Number.isFinite(min)) {
      errors.push("experience_min must be a valid number.");
    } else if (min < 0) {
      errors.push("experience_min cannot be negative.");
    }
  }

  if (max != null) {
    if (!Number.isFinite(max)) {
      errors.push("experience_max must be a valid number.");
    } else if (max < 0) {
      errors.push("experience_max cannot be negative.");
    }
  }

  if (
    min != null &&
    max != null &&
    Number.isFinite(min) &&
    Number.isFinite(max) &&
    min > max
  ) {
    errors.push("experience_min cannot be greater than experience_max.");
  }

  return errors;
}

function sanitizeExperienceInput(rawValue) {
  if (rawValue === "" || rawValue === null || rawValue === undefined) {
    return "";
  }

  const text = String(rawValue);
  if (!/^\d*(\.\d*)?$/.test(text) || text.includes("-")) {
    return null;
  }

  return text;
}

module.exports = {
  collectExperienceRangeErrors,
  sanitizeExperienceInput
};
