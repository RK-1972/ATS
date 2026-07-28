/**
 * Enterprise Workspace Resolver.
 * Derives UI workspace visibility from Work Assignment Master metadata
 * (workspace_flag) on the employee's active assignments — no hardcoded codes.
 */

const workAssignmentService = require("./workAssignmentService");

/**
 * Canonical flags used by Login / Workspace Picker / Navigation.
 * Always present for backward compatibility; additional flags may appear
 * from master metadata and are set dynamically.
 */
const DEFAULT_WORKSPACE_FLAGS = Object.freeze({
  showRecruitmentWorkspace: false,
  showApprovalWorkspace: false,
  showInterviewWorkspace: false,
  showRequestWorkspace: false
});

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function isBlank(value) {
  return value === null || value === undefined || String(value).trim() === "";
}

function buildEmptyWorkspace(employeeCode) {
  return {
    employee_code: employeeCode,
    work_assignments: [],
    workspace: { ...DEFAULT_WORKSPACE_FLAGS }
  };
}

/**
 * Build workspace visibility object from assignment rows that include
 * master metadata (workspace_flag, master_is_active).
 */
function resolveWorkspaceFlagsFromAssignments(assignmentRows) {
  const workspace = { ...DEFAULT_WORKSPACE_FLAGS };

  (assignmentRows || []).forEach((row) => {
    if (row.is_active !== true) {
      return;
    }

    if (row.master_is_active === false) {
      return;
    }

    const flag = row.workspace_flag ? String(row.workspace_flag).trim() : "";

    if (!flag) {
      return;
    }

    workspace[flag] = true;
  });

  return workspace;
}

/**
 * Resolve the Enterprise Workspace for an employee from active Work Assignments.
 *
 * @param {object} pool - PostgreSQL pool
 * @param {string} employeeCode
 * @returns {Promise<object>} workspace resolution payload
 */
async function resolveWorkspace(pool, employeeCode) {
  if (isBlank(employeeCode)) {
    throw httpError("employee_code is required.", 400);
  }

  const normalizedEmployeeCode = String(employeeCode).trim();

  const assignments =
    await workAssignmentService.getEmployeeWorkAssignments(
      pool,
      normalizedEmployeeCode
    );

  const activeRows = (assignments || []).filter(
    (row) => row.is_active === true
  );

  const workAssignments = [
    ...new Set(
      activeRows
        .map((row) => String(row.assignment_code || "").trim().toUpperCase())
        .filter((code) => code.length > 0)
    )
  ];

  if (workAssignments.length === 0) {
    return buildEmptyWorkspace(normalizedEmployeeCode);
  }

  return {
    employee_code: normalizedEmployeeCode,
    work_assignments: workAssignments,
    workspace: resolveWorkspaceFlagsFromAssignments(activeRows)
  };
}

module.exports = {
  DEFAULT_WORKSPACE_FLAGS,
  resolveWorkspace,
  resolveWorkspaceFlagsFromAssignments
};
