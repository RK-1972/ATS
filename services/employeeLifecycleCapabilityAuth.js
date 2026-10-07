/**
 * Authorization for employee lifecycle / responsibility clearance (V1).
 */

const { PLATFORM_ADMIN_ROLE } = require("../constants/employeeRoles");
const { assertCanAccessUserAdministration } = require("./userProvisioningCapabilityAuth");

const TA_LEAD_ROLES = new Set(["TA Lead", "TA Leader"]);

function authError(message, status = 403) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function isPlatformAdmin(req) {
  return String(req.user?.role_name || "").trim() === PLATFORM_ADMIN_ROLE;
}

function isTaLeadRole(req) {
  return TA_LEAD_ROLES.has(String(req.user?.role_name || "").trim());
}

/**
 * Admin, USER_ADMINISTRATOR assignment, or TA Lead / TA Leader.
 */
async function assertCanManageEmployeeLifecycle(pool, req) {
  if (isPlatformAdmin(req) || isTaLeadRole(req)) {
    return;
  }

  await assertCanAccessUserAdministration(pool, req);
}

module.exports = {
  assertCanManageEmployeeLifecycle,
  isPlatformAdmin,
  isTaLeadRole
};
