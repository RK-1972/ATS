const crypto = require("crypto");
const jwt = require("jsonwebtoken");

const workAssignmentService = require("./workAssignmentService");
const workspaceResolverService = require("./workspaceResolverService");
const hiringManagerIdentityService = require("./hiringManagerIdentityService");
const applicationSessionService = require("./applicationSessionService");

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function loadLoginContext(pool, user) {
  let workAssignments = [];
  let workAssignmentStatus = "NO_ASSIGNMENTS";
  let workspace = {};

  try {
    const employeeAssignments = await workAssignmentService.getEmployeeWorkAssignments(
      pool,
      user.employee_code
    );

    workAssignments = (employeeAssignments || [])
      .filter((row) => row.is_active === true)
      .map((row) => ({
        assignment_code: row.assignment_code,
        assignment_name: row.assignment_name
      }));

    workAssignmentStatus =
      workAssignments.length > 0 ? "LOADED" : "NO_ASSIGNMENTS";
  } catch (workAssignmentError) {
    console.error("[login] Failed to load work assignments", {
      employee_code: user.employee_code,
      message: workAssignmentError.message
    });
    workAssignments = [];
    workAssignmentStatus = "SERVICE_UNAVAILABLE";
  }

  try {
    const resolved = await workspaceResolverService.resolveWorkspace(
      pool,
      user.employee_code
    );
    workspace = resolved?.workspace || {};
  } catch (workspaceError) {
    console.error("[login] Failed to resolve workspace", {
      employee_code: user.employee_code,
      message: workspaceError.message
    });
    workspace = {};
  }

  try {
    await hiringManagerIdentityService.resolveBoundHiringManager(pool, {
      user: {
        employee_code: user.employee_code,
        email_id: user.email_id
      }
    });
    workspace = {
      ...workspace,
      showHiringManagerWorkspace: true
    };
  } catch (_hmBindingError) {
    // HM workspace visibility requires a bound hiring_manager_mstr profile.
  }

  if (user.role_name === "TA Lead" || user.role_name === "TA Leader") {
    workspace = {
      ...workspace,
      showTaLeadWorkspace: true
    };
  }

  return {
    workAssignments,
    workAssignmentStatus,
    workspace
  };
}

function signEmployeeJwt(user, sessionId) {
  if (!process.env.JWT_SECRET) {
    throw httpError("Login Error", 500);
  }

  return jwt.sign(
    {
      user_id: user.user_id,
      employee_code: user.employee_code,
      email_id: user.email_id,
      role_name: user.role_name,
      secondary_role: user.secondary_role,
      session_id: sessionId
    },
    process.env.JWT_SECRET,
    { expiresIn: "8h" }
  );
}

function buildLoginSuccessPayload(user, token, context) {
  return {
    success: true,
    message: "Login Successful",
    token,
    user: {
      user_id: user.user_id,
      employee_code: user.employee_code,
      full_name: user.full_name,
      email_id: user.email_id,
      role_name: user.role_name,
      secondary_role: user.secondary_role
    },
    work_assignments: context.workAssignments,
    work_assignment_status: context.workAssignmentStatus,
    workspace: context.workspace
  };
}

/**
 * Issue a new employee JWT and record ACTIVE session audit row.
 */
async function completeEmployeeLogin(pool, user, req, { sessionId: providedSessionId } = {}) {
  const sessionId = providedSessionId || crypto.randomUUID();
  const token = signEmployeeJwt(user, sessionId);

  try {
    await applicationSessionService.recordLogin(pool, {
      sessionId,
      user,
      req
    });
  } catch (sessionAuditError) {
    console.error("[login] Session audit record failed", {
      user_id: user.user_id,
      session_id: sessionId,
      message: sessionAuditError.message
    });
    throw httpError("Login Error", 500);
  }

  const context = await loadLoginContext(pool, user);
  return {
    sessionId,
    body: buildLoginSuccessPayload(user, token, context)
  };
}

module.exports = {
  loadLoginContext,
  signEmployeeJwt,
  buildLoginSuccessPayload,
  completeEmployeeLogin
};
