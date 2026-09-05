/**
 * Enterprise authorization for the Offer Workspace capability.
 * Mirrors workspaceResolverService: active assignment with workspace_flag
 * showOfferWorkspace (e.g. OFFER_RECRUITER).
 */

const workAssignmentService = require("./workAssignmentService");
const { resolveWorkspaceFlagsFromAssignments } = require("./workspaceResolverService");

const OFFER_WORKSPACE_FLAG = "showOfferWorkspace";
const DENIED_MESSAGE =
  "Enterprise Access Denied. You are not authorized to access the Offer Workspace.";

function authError(message) {
  const error = new Error(message);
  error.status = 403;
  return error;
}

/**
 * Allow only when the logged-in user has an active Work Assignment that
 * resolves showOfferWorkspace via master workspace_flag metadata.
 */
async function assertCanAccessOfferWorkspace(pool, req) {
  const employeeCode = req.user?.employee_code
    ? String(req.user.employee_code).trim()
    : "";

  if (!employeeCode) {
    throw authError(DENIED_MESSAGE);
  }

  const assignments = await workAssignmentService.getEmployeeWorkAssignments(
    pool,
    employeeCode
  );
  const workspace = resolveWorkspaceFlagsFromAssignments(assignments);

  if (!workspace[OFFER_WORKSPACE_FLAG]) {
    throw authError(DENIED_MESSAGE);
  }
}

/**
 * Express middleware factory: verifyToken must run first.
 */
function requireOfferWorkspace(pool) {
  return async function offerWorkspaceMiddleware(req, res, next) {
    try {
      await assertCanAccessOfferWorkspace(pool, req);
      next();
    } catch (error) {
      res.status(error.status || 403).json({
        success: false,
        message: error.message || "Enterprise Access Denied."
      });
    }
  };
}

module.exports = {
  OFFER_WORKSPACE_FLAG,
  assertCanAccessOfferWorkspace,
  requireOfferWorkspace
};
