/**
 * REGISTERED candidate integrity rules (Batch 1).
 * PAN format, contact requirements, duplicate PAN, immutability.
 */

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const MOBILE_REGEX = /^\+?[0-9][0-9\s-]{8,18}[0-9]$/;

const PAN_REGEX = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;

const DUPLICATE_REGISTERED_PAN_MESSAGE =
  "A candidate profile already exists for this PAN. Sign in to the candidate portal to update your existing profile.";

function createValidationError(message, status = 400, code = null) {
  const error = new Error(message);
  error.status = status;
  if (code) {
    error.code = code;
  }
  return error;
}

function normalizePan(value) {
  const pan = String(value || "").trim().toUpperCase();
  return pan || null;
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeMobile(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function validatePanFormat(pan) {
  const normalized = normalizePan(pan);

  if (!normalized) {
    return { valid: false, message: "pan_number is required." };
  }

  if (!PAN_REGEX.test(normalized)) {
    return {
      valid: false,
      message: "Invalid PAN format. Example: ABCDE1234F"
    };
  }

  return { valid: true, pan: normalized };
}

function validateRegisteredContactFields({ email_id, mobile_number }) {
  const errors = [];
  const email = normalizeEmail(email_id);
  const mobile = normalizeMobile(mobile_number);

  if (!email) {
    errors.push("email_id is required.");
  } else if (!EMAIL_REGEX.test(email)) {
    errors.push("A valid email_id is required.");
  }

  if (!mobile) {
    errors.push("mobile_number is required.");
  } else if (!MOBILE_REGEX.test(mobile)) {
    errors.push("Enter a valid mobile number.");
  }

  return errors;
}

function validateForRegisteredStatus({ email_id, mobile_number, pan_number }) {
  const errors = validateRegisteredContactFields({
    email_id,
    mobile_number
  });

  const panCheck = validatePanFormat(pan_number);

  if (!panCheck.valid) {
    errors.push(panCheck.message);
  }

  return errors;
}

function assertPanImmutable(existingPan, incomingPan) {
  const existing = normalizePan(existingPan);
  const incoming = normalizePan(incomingPan);

  if (!existing) {
    return incoming;
  }

  if (incoming && incoming !== existing) {
    throw createValidationError(
      "PAN cannot be changed after candidate registration.",
      400
    );
  }

  return existing;
}

async function findRegisteredCandidateByPan(
  queryable,
  pan,
  excludeCandidateId = null
) {
  const normalized = normalizePan(pan);

  if (!normalized) {
    return null;
  }

  const params = [normalized];
  let excludeClause = "";

  if (
    excludeCandidateId !== null &&
    excludeCandidateId !== undefined &&
    String(excludeCandidateId).trim() !== ""
  ) {
    params.push(Number(excludeCandidateId));
    excludeClause = "AND candidate_id <> $2";
  }

  const result = await queryable.query(
    `
    SELECT candidate_id, candidate_code, candidate_status, pan_number
    FROM cand_mstr
    WHERE UPPER(TRIM(pan_number)) = $1
      AND UPPER(TRIM(candidate_status)) = 'REGISTERED'
      ${excludeClause}
    LIMIT 1
    `,
    params
  );

  return result.rows[0] || null;
}

async function assertNoDuplicateRegisteredPan(
  queryable,
  pan,
  excludeCandidateId = null
) {
  const duplicate = await findRegisteredCandidateByPan(
    queryable,
    pan,
    excludeCandidateId
  );

  if (duplicate) {
    throw createValidationError(
      DUPLICATE_REGISTERED_PAN_MESSAGE,
      409,
      "DUPLICATE_REGISTERED_PAN"
    );
  }
}

function isRegisteredStatus(status) {
  return String(status || "").trim().toUpperCase() === "REGISTERED";
}

module.exports = {
  EMAIL_REGEX,
  MOBILE_REGEX,
  PAN_REGEX,
  DUPLICATE_REGISTERED_PAN_MESSAGE,
  normalizePan,
  normalizeEmail,
  normalizeMobile,
  validatePanFormat,
  validateRegisteredContactFields,
  validateForRegisteredStatus,
  assertPanImmutable,
  findRegisteredCandidateByPan,
  assertNoDuplicateRegisteredPan,
  isRegisteredStatus,
  createValidationError
};
