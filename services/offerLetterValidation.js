const {
  GENERATED_LETTER_STATUS,
  PENDING_LETTER_STATUSES
} = require("../repositories/offerLetterRepository");

const AWAITING_LETTER_STATUS = PENDING_LETTER_STATUSES[0];

const PRE_APPROVAL_OFFER_STATUSES = new Set([
  "Draft",
  "Pending Approval",
  "Declined",
  "Withdrawn"
]);

function createValidationError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function normalizeOfferStatus(row) {
  return String(row?.offer_status || "").trim();
}

function normalizeLetterStatus(row) {
  return String(row?.letter_status || row?.status || "").trim();
}

function isPreApprovalOfferStatus(offerStatus) {
  return PRE_APPROVAL_OFFER_STATUSES.has(String(offerStatus || "").trim());
}

function isPostApprovalOfferStatus(offerStatus) {
  const status = String(offerStatus || "").trim();
  return Boolean(status) && !isPreApprovalOfferStatus(status);
}

function isAwaitingLetterWorkflow(row) {
  return normalizeLetterStatus(row) === AWAITING_LETTER_STATUS;
}

function isGeneratedLetterWorkflow(row) {
  return normalizeLetterStatus(row) === GENERATED_LETTER_STATUS;
}

function isOfferLetterWorkspaceEligible(row) {
  if (!row) {
    return false;
  }

  if (isAwaitingLetterWorkflow(row) || isGeneratedLetterWorkflow(row)) {
    return true;
  }

  return isPostApprovalOfferStatus(normalizeOfferStatus(row));
}

function assertOfferLetterWorkspaceEligible(row) {
  if (!row) {
    throw createValidationError("Offer not found.", 404);
  }

  if (isOfferLetterWorkspaceEligible(row)) {
    return;
  }

  throw createValidationError(
    "Offer is not eligible for offer letter operations.",
    400
  );
}

function assertAwaitingLetterOperations(row) {
  assertOfferLetterWorkspaceEligible(row);

  if (isGeneratedLetterWorkflow(row)) {
    throw createValidationError("Offer letter has already been generated.", 400);
  }

  if (!isAwaitingLetterWorkflow(row)) {
    throw createValidationError(
      "Offer must be in the Awaiting Letters queue before generating an offer letter.",
      400
    );
  }
}

function assertGeneratedLetterAccess(row) {
  if (!row) {
    throw createValidationError("Offer not found.", 404);
  }

  if (!isGeneratedLetterWorkflow(row)) {
    throw createValidationError("Generated offer letter is not available.", 404);
  }

  assertOfferLetterWorkspaceEligible(row);
}

module.exports = {
  AWAITING_LETTER_STATUS,
  PRE_APPROVAL_OFFER_STATUSES,
  isPreApprovalOfferStatus,
  isPostApprovalOfferStatus,
  isAwaitingLetterWorkflow,
  isGeneratedLetterWorkflow,
  isOfferLetterWorkspaceEligible,
  assertOfferLetterWorkspaceEligible,
  assertAwaitingLetterOperations,
  assertGeneratedLetterAccess
};
