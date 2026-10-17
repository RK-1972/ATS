/**
 * Application Audit & Session History workspace authorization.
 * Access via active work assignment with showApplicationAuditWorkspace only.
 */

const workAssignmentService = require("./workAssignmentService");
const { resolveWorkspaceFlagsFromAssignments } = require("./workspaceResolverService");

const APPLICATION_AUDIT_WORKSPACE_FLAG = "showApplicationAuditWorkspace";
const DENIED_MESSAGE =
  "Enterprise Access Denied. You are not authorized to access Application Audit & Session History.";

function authError(message) {
  const error = new Error(message);
  error.status = 403;
  return error;
}

async function assertCanAccessApplicationAuditWorkspace(pool, req) {
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

  if (!workspace[APPLICATION_AUDIT_WORKSPACE_FLAG]) {
    throw authError(DENIED_MESSAGE);
  }
}

function requireApplicationAuditWorkspace(pool) {
  return async function applicationAuditWorkspaceMiddleware(req, res, next) {
    try {
      await assertCanAccessApplicationAuditWorkspace(pool, req);
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
  APPLICATION_AUDIT_WORKSPACE_FLAG,
  assertCanAccessApplicationAuditWorkspace,
  requireApplicationAuditWorkspace
};
