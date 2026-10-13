/**
 * Enterprise authorization for the Offer Workspace capability.
 * Mirrors workspaceResolverService: active assignment with workspace_flag
 * showOfferWorkspace (e.g. OFFER_RECRUITER).
 */

const workAssignmentService = require("./workAssignmentService");
const { resolveWorkspaceFlagsFromAssignments } = require("./workspaceResolverService");

const OFFER_WORKSPACE_FLAG = "showOfferWorkspace";
const DENIED_MESSAGE =
  "Enterprise Access Denied. You are not authorized to access the Offer Workspace.";
const WRITE_DENIED_MESSAGE =
  "Enterprise Access Denied. You are not authorized to modify this offer.";

const TA_LEAD_ROLES = new Set(["TA Lead", "TA Leader"]);
const ADMIN_ROLE = "Admin";

function authError(message) {
  const error = new Error(message);
  error.status = 403;
  return error;
}

function isAdminUser(req) {
  return String(req?.user?.role_name || "").trim() === ADMIN_ROLE;
}

function isTaLeadRole(req) {
  return TA_LEAD_ROLES.has(String(req?.user?.role_name || "").trim());
}

function resolveOfferActorIdentity(req) {
  const employeeCode = String(req?.user?.employee_code || "").trim();
  const displayName = String(
    req?.user?.full_name || req?.user?.email_id || ""
  ).trim();
  return { employeeCode, displayName };
}

/**
 * Write access for offer correction/discard (Phase A foundation):
 * Admin, TA Lead / TA Leader, or recruiter assigned to the offer requisition.
 */
async function assertCanWriteOfferRecord(pool, req, offerId) {
  if (!req?.user) {
    throw authError(WRITE_DENIED_MESSAGE);
  }

  if (isAdminUser(req) || isTaLeadRole(req)) {
    return;
  }

  const { employeeCode } = resolveOfferActorIdentity(req);

  if (!employeeCode) {
    throw authError(WRITE_DENIED_MESSAGE);
  }

  const result = await pool.query(
    `SELECT o.offer_id
     FROM om_offers o
     WHERE o.offer_id = $1
       AND o.requisition_code IS NOT NULL
       AND EXISTS (
         SELECT 1
         FROM rm_recruiter_assignments a
         WHERE a.recruiter_code = $2
           AND a.is_active = TRUE
           AND a.requisition_code = o.requisition_code
       )
     LIMIT 1`,
    [offerId, employeeCode]
  );

  if (!result.rows.length) {
    throw authError(WRITE_DENIED_MESSAGE);
  }
}

/**
 * Allow only when the logged-in user has an active Work Assignment that
 * resolves showOfferWorkspace via master workspace_flag metadata.
 */
async function assertCanAccessOfferWorkspace(pool, req) {
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

  if (!workspace[OFFER_WORKSPACE_FLAG]) {
    throw authError(DENIED_MESSAGE);
  }
}

/**
 * Express middleware factory: verifyToken must run first.
 */
function requireOfferWorkspace(pool) {
  return async function offerWorkspaceMiddleware(req, res, next) {
    try {
      await assertCanAccessOfferWorkspace(pool, req);
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
  OFFER_WORKSPACE_FLAG,
  assertCanAccessOfferWorkspace,
  requireOfferWorkspace,
  assertCanWriteOfferRecord,
  isAdminUser,
  isTaLeadRole,
  TA_LEAD_ROLES
};
