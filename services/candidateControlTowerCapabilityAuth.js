/**
 * Centralized Candidate Control Tower workspace authorization.
 * Access via active work assignment with showCandidateControlTowerWorkspace only.
 */

const workAssignmentService = require("./workAssignmentService");
const { resolveWorkspaceFlagsFromAssignments } = require("./workspaceResolverService");

const CANDIDATE_CONTROL_TOWER_WORKSPACE_FLAG = "showCandidateControlTowerWorkspace";
const DENIED_MESSAGE =
  "Enterprise Access Denied. You are not authorized to access the Candidate Control Tower.";

function authError(message) {
  const error = new Error(message);
  error.status = 403;
  return error;
}

async function assertCanAccessCandidateControlTowerWorkspace(pool, req) {
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

  if (!workspace[CANDIDATE_CONTROL_TOWER_WORKSPACE_FLAG]) {
    throw authError(DENIED_MESSAGE);
  }
}

function requireCandidateControlTowerWorkspace(pool) {
  return async function candidateControlTowerWorkspaceMiddleware(req, res, next) {
    try {
      await assertCanAccessCandidateControlTowerWorkspace(pool, req);
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
  CANDIDATE_CONTROL_TOWER_WORKSPACE_FLAG,
  assertCanAccessCandidateControlTowerWorkspace,
  requireCandidateControlTowerWorkspace
};
