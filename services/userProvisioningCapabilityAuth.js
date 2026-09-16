/**
 * Enterprise authorization for User Administration / provisioning.
 * Pattern: assignment-code checks via workAssignmentService (requisitionCapabilityAuth).
 */

const workAssignmentService = require("./workAssignmentService");
const {
  getProvisionableRolesForAdmin,
  getProvisionableRolesForUserAdministrator,
  PLATFORM_ADMIN_ROLE
} = require("../constants/employeeRoles");

const USER_ADMINISTRATOR_CODE = "USER_ADMINISTRATOR";

const PRIVILEGED_ASSIGNMENT_CODES = new Set([USER_ADMINISTRATOR_CODE]);

const PROVISIONABLE_ROLES_ADMIN = Object.freeze(getProvisionableRolesForAdmin());

const PROVISIONABLE_ROLES_USER_ADMINISTRATOR = Object.freeze(
  getProvisionableRolesForUserAdministrator()
);

function authError(message, status = 403) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function isPlatformAdmin(req) {
  return String(req.user?.role_name || "").trim() === PLATFORM_ADMIN_ROLE;
}

function normalizeAssignmentCode(value) {
  return String(value || "").trim().toUpperCase();
}

async function hasActiveWorkAssignment(pool, employeeCode, assignmentCode) {
  const normalizedCode = normalizeAssignmentCode(assignmentCode);

  if (!employeeCode || !normalizedCode) {
    return false;
  }

  const assignments = await workAssignmentService.getEmployeeWorkAssignments(
    pool,
    String(employeeCode).trim()
  );

  return (assignments || []).some((row) => {
    if (row.is_active !== true) {
      return false;
    }

    if (row.master_is_active === false) {
      return false;
    }

    return normalizeAssignmentCode(row.assignment_code) === normalizedCode;
  });
}

async function isUserAdministrator(pool, req) {
  const employeeCode = req.user?.employee_code
    ? String(req.user.employee_code).trim()
    : "";

  if (!employeeCode) {
    return false;
  }

  return hasActiveWorkAssignment(pool, employeeCode, USER_ADMINISTRATOR_CODE);
}

/**
 * Admin OR active USER_ADMINISTRATOR assignment.
 */
async function assertCanAccessUserAdministration(pool, req) {
  if (isPlatformAdmin(req)) {
    return;
  }

  const allowed = await isUserAdministrator(pool, req);

  if (!allowed) {
    throw authError(
      "Enterprise Access Denied. You are not authorized to access User Administration."
    );
  }
}

/**
 * Admin may provision any supported role; USER_ADMINISTRATOR may not create Admin users.
 */
async function assertCanProvisionUsers(pool, req, { targetRoleName } = {}) {
  await assertCanAccessUserAdministration(pool, req);

  if (isPlatformAdmin(req)) {
    return;
  }

  const roleName = String(targetRoleName || "").trim();

  if (roleName === PLATFORM_ADMIN_ROLE) {
    throw authError(
      "Enterprise Access Denied. User Administrators cannot create or promote Admin users."
    );
  }
}

function assertAssignmentGrantAllowed(req, assignmentCode) {
  const normalizedCode = normalizeAssignmentCode(assignmentCode);

  if (!normalizedCode) {
    throw authError("Work assignment code is required.", 400);
  }

  if (isPlatformAdmin(req)) {
    return;
  }

  if (PRIVILEGED_ASSIGNMENT_CODES.has(normalizedCode)) {
    throw authError(
      "Enterprise Access Denied. Only Platform Admins may grant privileged work assignments."
    );
  }
}

/**
 * Assign/remove employee work assignments for other employees.
 * Platform Admin: full. USER_ADMINISTRATOR: operational only. Others: denied.
 */
async function assertCanManageEmployeeWorkAssignments(pool, req) {
  if (isPlatformAdmin(req)) {
    return;
  }

  const allowed = await isUserAdministrator(pool, req);

  if (!allowed) {
    throw authError(
      "Enterprise Access Denied. You are not authorized to manage employee work assignments."
    );
  }
}

function getProvisionableRoles(req) {
  if (isPlatformAdmin(req)) {
    return [...PROVISIONABLE_ROLES_ADMIN];
  }

  return [...PROVISIONABLE_ROLES_USER_ADMINISTRATOR];
}

function isPrivilegedAssignmentCode(assignmentCode) {
  return PRIVILEGED_ASSIGNMENT_CODES.has(normalizeAssignmentCode(assignmentCode));
}

/**
 * Primary Role change authorization — mirrors provisioning rules; blocks self-change.
 */
async function assertCanChangePrimaryRole(
  pool,
  req,
  { targetEmployeeCode, targetRoleName } = {}
) {
  const actorCode = String(req.user?.employee_code || "").trim();
  const subjectCode = String(targetEmployeeCode || "").trim();

  if (actorCode && subjectCode && actorCode === subjectCode) {
    throw authError("You cannot change your own Primary Role.", 403);
  }

  await assertCanProvisionUsers(pool, req, { targetRoleName });
}

/**
 * Account activate/deactivate — mirrors provisioning rules; blocks self-change.
 * USER_ADMINISTRATOR cannot manage Admin accounts.
 */
async function assertCanChangeUserStatus(pool, req, { targetEmployeeCode } = {}) {
  const actorCode = String(req.user?.employee_code || "").trim();
  const subjectCode = String(targetEmployeeCode || "").trim();

  if (!subjectCode) {
    throw authError("employeeCode is required.", 400);
  }

  if (actorCode && subjectCode && actorCode === subjectCode) {
    throw authError("You cannot change your own account status.", 403);
  }

  await assertCanAccessUserAdministration(pool, req);

  if (isPlatformAdmin(req)) {
    return;
  }

  const targetResult = await pool.query(
    `SELECT role_name
     FROM user_mstr
     WHERE employee_code = $1
     LIMIT 1`,
    [subjectCode]
  );

  const targetRole = String(targetResult.rows[0]?.role_name || "").trim();

  if (!targetResult.rows[0]) {
    throw authError(`User not found: ${subjectCode}`, 404);
  }

  if (targetRole === PLATFORM_ADMIN_ROLE) {
    throw authError(
      "Enterprise Access Denied. User Administrators cannot manage Admin accounts.",
      403
    );
  }
}

function requireUserAdministration(pool) {
  return async function userAdministrationMiddleware(req, res, next) {
    try {
      await assertCanAccessUserAdministration(pool, req);
      next();
    } catch (error) {
      res.status(error.status || 403).json({
        success: false,
        message: error.message || "Enterprise Access Denied."
      });
    }
  };
}

function requireUserProvisioner(pool) {
  return async function userProvisionerMiddleware(req, res, next) {
    try {
      const targetRoleName =
        req.body?.role_name || req.body?.roleName || req.body?.role;

      await assertCanProvisionUsers(pool, req, { targetRoleName });
      next();
    } catch (error) {
      res.status(error.status || 403).json({
        success: false,
        message: error.message || "Enterprise Access Denied."
      });
    }
  };
}

function requirePrimaryRoleChanger(pool) {
  return async function primaryRoleChangerMiddleware(req, res, next) {
    try {
      const targetEmployeeCode = req.params?.employeeCode;
      const targetRoleName =
        req.body?.role_name || req.body?.roleName || req.body?.role;

      await assertCanChangePrimaryRole(pool, req, {
        targetEmployeeCode,
        targetRoleName
      });
      next();
    } catch (error) {
      res.status(error.status || 403).json({
        success: false,
        message: error.message || "Enterprise Access Denied."
      });
    }
  };
}

function requireUserStatusChanger(pool) {
  return async function userStatusChangerMiddleware(req, res, next) {
    try {
      await assertCanChangeUserStatus(pool, req, {
        targetEmployeeCode: req.params?.employeeCode
      });
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
  USER_ADMINISTRATOR_CODE,
  PRIVILEGED_ASSIGNMENT_CODES,
  PROVISIONABLE_ROLES_ADMIN,
  PROVISIONABLE_ROLES_USER_ADMINISTRATOR,
  isPlatformAdmin,
  isPrivilegedAssignmentCode,
  getProvisionableRoles,
  assertCanAccessUserAdministration,
  assertCanProvisionUsers,
  assertAssignmentGrantAllowed,
  assertCanManageEmployeeWorkAssignments,
  assertCanChangePrimaryRole,
  assertCanChangeUserStatus,
  requireUserAdministration,
  requireUserProvisioner,
  requirePrimaryRoleChanger,
  requireUserStatusChanger
};
