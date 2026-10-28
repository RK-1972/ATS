/**
 * Shared validation for business numeric fields that must not be negative.
 */

function parseNumeric(rawValue) {
  if (rawValue === "" || rawValue === null || rawValue === undefined) {
    return null;
  }

  const parsed = Number(rawValue);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function collectNonNegativeNumberErrors(fieldName, rawValue, options = {}) {
  const { allowBlank = true, label = fieldName } = options;
  const errors = [];

  if (allowBlank && (rawValue === "" || rawValue === null || rawValue === undefined)) {
    return errors;
  }

  const parsed = parseNumeric(rawValue);

  if (parsed === null) {
    errors.push(`${label} is required.`);
    return errors;
  }

  if (Number.isNaN(parsed)) {
    errors.push(`${label} must be a valid number.`);
    return errors;
  }

  if (parsed < 0) {
    errors.push(`${label} cannot be negative.`);
  }

  return errors;
}

function collectStrictlyPositiveNumberErrors(fieldName, rawValue, options = {}) {
  const { label = fieldName } = options;
  const errors = [];

  if (rawValue === "" || rawValue === null || rawValue === undefined) {
    errors.push(`${label} is required.`);
    return errors;
  }

  const parsed = parseNumeric(rawValue);

  if (parsed === null || Number.isNaN(parsed)) {
    errors.push(`${label} must be a valid number.`);
    return errors;
  }

  if (parsed <= 0) {
    errors.push(`${label} must be greater than 0.`);
  }

  return errors;
}

function collectOpeningsCountErrors(rawValue, options = {}) {
  const { allowBlank = false } = options;
  const errors = [];

  if (allowBlank && (rawValue === "" || rawValue === null || rawValue === undefined)) {
    return errors;
  }

  const parsed = parseNumeric(rawValue);

  if (parsed === null || Number.isNaN(parsed)) {
    errors.push("openings_count must be a whole number of at least 1.");
    return errors;
  }

  if (!Number.isInteger(parsed) || parsed < 1) {
    errors.push("openings_count must be a whole number of at least 1.");
  }

  return errors;
}

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function assertStrictlyPositiveNumber(rawValue, label) {
  const errors = collectStrictlyPositiveNumberErrors("value", rawValue, { label });
  if (errors.length) {
    throw httpError(errors[0], 400);
  }
  return Number(rawValue);
}

function assertNonNegativeNumber(rawValue, label, options = {}) {
  const errors = collectNonNegativeNumberErrors("value", rawValue, {
    label,
    allowBlank: options.allowBlank !== false
  });
  if (errors.length) {
    throw httpError(errors[0], 400);
  }

  if (rawValue === "" || rawValue === null || rawValue === undefined) {
    return null;
  }

  return Number(rawValue);
}

function assertOptionalStrictlyPositiveNumber(rawValue, label) {
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === "") {
    return null;
  }

  return assertStrictlyPositiveNumber(rawValue, label);
}

module.exports = {
  parseNumeric,
  collectNonNegativeNumberErrors,
  collectStrictlyPositiveNumberErrors,
  collectOpeningsCountErrors,
  assertStrictlyPositiveNumber,
  assertNonNegativeNumber,
  assertOptionalStrictlyPositiveNumber
};
