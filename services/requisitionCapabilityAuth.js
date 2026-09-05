/**
 * Enterprise authorization for the Create Requisition capability.
 * Single Work Assignment model: active REQUISITION_REQUESTOR.
 * Shared by workforce create, requisition read, and talent-demand edit/submit.
 */

const workAssignmentService = require("./workAssignmentService");
const { userContext } = require("./enterpriseAuditService");

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
 * rm_requisitions.created_by stores userContext(req).name at creation time
 * (full_name, else email_id). JWT carries employee_code + email_id only.
 */
async function resolveRequisitionRequestorCreatedByKeys(pool, req) {
  const employeeCode = String(req?.user?.employee_code || "").trim();
  const emailId = String(req?.user?.email_id || "").trim();
  const keys = new Set();

  if (employeeCode) {
    keys.add(employeeCode);
  }

  if (emailId) {
    keys.add(emailId);
  }

  const contextName = String(userContext(req).name || "").trim();
  if (contextName && contextName !== "System User") {
    keys.add(contextName);
  }

  if (employeeCode) {
    const nameLookup = await pool.query(
      `SELECT full_name
       FROM user_mstr
       WHERE employee_code = $1
       LIMIT 1`,
      [employeeCode]
    );
    const fullName = String(nameLookup.rows[0]?.full_name || "").trim();
    if (fullName) {
      keys.add(fullName);
    }
  }

  return [...keys].filter(Boolean);
}

async function assertRequisitionRequestorOwnerAccess(pool, req, requisition) {
  const ownerKeys = await resolveRequisitionRequestorCreatedByKeys(pool, req);

  if (!ownerKeys.length) {
    throw authError(
      "Enterprise Access Denied. You are not authorized to view this requisition."
    );
  }

  const createdByKey = String(requisition?.created_by || "").trim();

  if (!createdByKey || !ownerKeys.includes(createdByKey)) {
    throw authError(
      "Enterprise Access Denied. You are not authorized to view this requisition."
    );
  }
}

/**
 * Approval action-context participants: Admin, assigned approver, or requestor owner.
 */
async function assertRequisitionApprovalParticipantAccess(
  pool,
  req,
  requisition,
  options = {}
) {
  const isAdmin = String(req.user?.role_name || "").trim().toLowerCase() === "admin";

  if (isAdmin) {
    return;
  }

  const employeeCode = String(req.user?.employee_code || "").trim();
  const assignee = String(options.assigneeEmployeeCode || "").trim();

  if (assignee && employeeCode && assignee === employeeCode) {
    return;
  }

  await assertRequisitionRequestorOwnerAccess(pool, req, requisition);
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
  resolveRequisitionRequestorCreatedByKeys,
  assertRequisitionRequestorOwnerAccess,
  assertRequisitionApprovalParticipantAccess,
  requireRequisitionRequestor,
  requireRequisitionAssigner
};
