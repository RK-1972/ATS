/**
 * Canonical employee role_name values from Platform Configuration
 * (seed/platformConfig.seed.json → role_visibility.roles).
 *
 * Candidate portal accounts are separate and are not employee provisioning roles.
 */
const EMPLOYEE_ROLE_NAMES = Object.freeze([
  "Admin",
  "TA Leader",
  "TA Lead",
  "Recruiter",
  "Hiring Manager",
  "Interviewer"
]);

const PLATFORM_ADMIN_ROLE = "Admin";

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
  getProvisionableRolesForAdmin,
  getProvisionableRolesForUserAdministrator,
  isEmployeeRoleName
};
