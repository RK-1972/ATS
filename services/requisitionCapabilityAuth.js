/**
 * Enterprise authorization for the Create Requisition capability.
 * Single Work Assignment model: active REQUISITION_REQUESTOR.
 * Shared by workforce create, requisition read, and talent-demand edit/submit.
 */

const workAssignmentService = require("./workAssignmentService");

const REQUISITION_REQUESTOR_CODE = "REQUISITION_REQUESTOR";
const REQUISITION_ASSIGNER_CODE = "REQUISITION_ASSIGNER";

function authError(message) {
  const error = new Error(message);
  error.status = 403;
  return error;
}

/**
 * Allow only when the logged-in user has an ACTIVE Work Assignment
 * representing Create Requisition (REQUISITION_REQUESTOR).
 * Reuses workAssignmentService — no parallel authorization mechanism.
 */
async function assertCanCreateRequisition(pool, req) {
  const employeeCode = req.user?.employee_code
    ? String(req.user.employee_code).trim()
    : "";

  if (!employeeCode) {
    throw authError(
      "Enterprise Access Denied. You are not authorized to create a Requisition."
    );
  }

  const assignments = await workAssignmentService.getEmployeeWorkAssignments(
    pool,
    employeeCode
  );

  const hasCreateRequisition = (assignments || []).some((row) => {
    if (row.is_active !== true) {
      return false;
    }

    if (row.master_is_active === false) {
      return false;
    }

    return (
      String(row.assignment_code || "").trim().toUpperCase() ===
      REQUISITION_REQUESTOR_CODE
    );
  });

  if (!hasCreateRequisition) {
    throw authError(
      "Enterprise Access Denied. You are not authorized to create a Requisition."
    );
  }
}

async function assertHasWorkAssignment(pool, req, assignmentCode, deniedMessage) {
  const employeeCode = req.user?.employee_code
    ? String(req.user.employee_code).trim()
    : "";

  if (!employeeCode) {
    throw authError(deniedMessage);
  }

  const assignments = await workAssignmentService.getEmployeeWorkAssignments(
    pool,
    employeeCode
  );

  const hasAssignment = (assignments || []).some((row) => {
    if (row.is_active !== true) {
      return false;
    }

    if (row.master_is_active === false) {
      return false;
    }

    return (
      String(row.assignment_code || "").trim().toUpperCase() === assignmentCode
    );
  });

  if (!hasAssignment) {
    throw authError(deniedMessage);
  }
}

async function assertCanManageRequisitionAssignments(pool, req) {
  await assertHasWorkAssignment(
    pool,
    req,
    REQUISITION_ASSIGNER_CODE,
    "Enterprise Access Denied. You are not authorized to access TA Lead Workspace."
  );
}

/**
 * Express middleware factory: verifyToken must run first.
 */
function requireRequisitionRequestor(pool) {
  return async function requisitionRequestorMiddleware(req, res, next) {
    try {
      await assertCanCreateRequisition(pool, req);
      next();
    } catch (error) {
      res.status(error.status || 403).json({
        success: false,
        message: error.message || "Enterprise Access Denied."
      });
    }
  };
}

function requireRequisitionAssigner(pool) {
  return async function requisitionAssignerMiddleware(req, res, next) {
    try {
      await assertCanManageRequisitionAssignments(pool, req);
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
  REQUISITION_REQUESTOR_CODE,
  REQUISITION_ASSIGNER_CODE,
  assertCanCreateRequisition,
  assertCanManageRequisitionAssignments,
  requireRequisitionRequestor,
  requireRequisitionAssigner
};
