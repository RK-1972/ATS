/**
 * Canonical employee role_name values from Platform Configuration
 * (seed/platformConfig.seed.json → role_visibility.roles).
 *
 * Candidate portal accounts are separate and are not employee provisioning roles.
 */
/** Stable role code (documentation / integrations); stored value is role_name. */
const ENTERPRISE_TALENT_ADMIN_ROLE_CODE = "ENTERPRISE_TALENT_ADMIN";

/** Primary user_mstr.role_name / JWT role_name for Enterprise Talent Administrator. */
const ENTERPRISE_TALENT_ADMIN_ROLE_NAME = "Enterprise Talent Administrator";

const EMPLOYEE_ROLE_NAMES = Object.freeze([
  "Admin",
  "TA Leader",
  "TA Lead",
  "Recruiter",
  "Hiring Manager",
  "Interviewer",
  ENTERPRISE_TALENT_ADMIN_ROLE_NAME
]);

const PLATFORM_ADMIN_ROLE = "Admin";

function isEnterpriseTalentAdministratorUser(req) {
  return (
    String(req.user?.role_name || "").trim() === ENTERPRISE_TALENT_ADMIN_ROLE_NAME
  );
}

function getProvisionableRolesForAdmin() {
  return [...EMPLOYEE_ROLE_NAMES];
}

function getProvisionableRolesForUserAdministrator() {
  return EMPLOYEE_ROLE_NAMES.filter((role) => role !== PLATFORM_ADMIN_ROLE);
}

function isEmployeeRoleName(roleName) {
  const normalized = String(roleName || "").trim();
  return EMPLOYEE_ROLE_NAMES.includes(normalized);
}

module.exports = {
  EMPLOYEE_ROLE_NAMES,
  PLATFORM_ADMIN_ROLE,
  ENTERPRISE_TALENT_ADMIN_ROLE_CODE,
  ENTERPRISE_TALENT_ADMIN_ROLE_NAME,
  getProvisionableRolesForAdmin,
  getProvisionableRolesForUserAdministrator,
  isEmployeeRoleName,
  isEnterpriseTalentAdministratorUser
};
