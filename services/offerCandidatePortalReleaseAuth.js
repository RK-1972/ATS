/**
 * Authorization for Release Offer → Candidate Portal (RELEASE_OFFER assignment).
 */

const workAssignmentService = require("./workAssignmentService");

const RELEASE_OFFER_CODE = "RELEASE_OFFER";
const DENIED_MESSAGE =
  "Enterprise Access Denied. You are not authorized to release offers to the candidate portal.";

function authError(message, status = 403) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function normalizeCode(value) {
  return String(value || "").trim().toUpperCase();
}

async function hasReleaseOfferAssignment(pool, req) {
  const employeeCode = req.user?.employee_code
    ? String(req.user.employee_code).trim()
    : "";

  if (!employeeCode) {
    return false;
  }

  const assignments = await workAssignmentService.getEmployeeWorkAssignments(
    pool,
    employeeCode
  );

  return (assignments || []).some((row) => {
    if (row.is_active !== true || row.master_is_active === false) {
      return false;
    }

    return normalizeCode(row.assignment_code) === RELEASE_OFFER_CODE;
  });
}

async function assertCanReleaseOfferToCandidatePortal(pool, req) {
  const allowed = await hasReleaseOfferAssignment(pool, req);

  if (!allowed) {
    throw authError(DENIED_MESSAGE);
  }
}

function requireReleaseOfferToCandidatePortal(pool) {
  return async function releaseOfferPortalMiddleware(req, res, next) {
    try {
      await assertCanReleaseOfferToCandidatePortal(pool, req);
      next();
    } catch (error) {
      res.status(error.status || 403).json({
        success: false,
        message: error.message || DENIED_MESSAGE
      });
    }
  };
}

module.exports = {
  RELEASE_OFFER_CODE,
  hasReleaseOfferAssignment,
  assertCanReleaseOfferToCandidatePortal,
  requireReleaseOfferToCandidatePortal
};
