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
 * Same predicate as Offer Letter routes (`requireOfferWorkspace`) and POST /api/v1/offers:
 * active employee assignment whose master resolves `showOfferWorkspace`.
 */
async function hasOfferWorkspaceAccess(pool, req) {
  const employeeCode = req.user?.employee_code
    ? String(req.user.employee_code).trim()
    : "";

  if (!employeeCode) {
    return false;
  }

  const assignments = await workAssignmentService.getEmployeeWorkAssignments(
    pool,
    employeeCode
  );
  const workspace = resolveWorkspaceFlagsFromAssignments(assignments);

  return Boolean(workspace[OFFER_WORKSPACE_FLAG]);
}

/**
 * Allow only when the logged-in user has an active Work Assignment that
 * resolves showOfferWorkspace via master workspace_flag metadata.
 */
async function assertCanAccessOfferWorkspace(pool, req) {
  if (!(await hasOfferWorkspaceAccess(pool, req))) {
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

const SUBMIT_CLARIFICATION_DENIED_MESSAGE =
  "Enterprise Access Denied. Only the original offer requestor may submit clarification.";

/**
 * Offer clarification response — original requester (from persisted offer record),
 * Admin, or TA Lead. Does not use recruiter-assignment rules.
 */
async function assertCanSubmitOfferClarification(pool, req, offerId) {
  if (!req?.user) {
    throw authError(DENIED_MESSAGE);
  }

  if (isAdminUser(req) || isTaLeadRole(req)) {
    return;
  }

  const actorCode = String(req.user?.employee_code || "").trim();
  if (!actorCode) {
    throw authError(SUBMIT_CLARIFICATION_DENIED_MESSAGE);
  }

  const offerResult = await pool.query(
    `SELECT offer_id, recruiter_id, created_by
     FROM om_offers
     WHERE offer_id = $1`,
    [offerId]
  );

  if (!offerResult.rows[0]) {
    throw authError(SUBMIT_CLARIFICATION_DENIED_MESSAGE);
  }

  const { resolveOfferRequestorEmployeeCode } = require("./offerWorkflowCompletionService");
  const requestorCode = await resolveOfferRequestorEmployeeCode(
    pool,
    offerResult.rows[0]
  );

  if (!requestorCode || requestorCode !== actorCode) {
    throw authError(SUBMIT_CLARIFICATION_DENIED_MESSAGE);
  }
}

module.exports = {
  OFFER_WORKSPACE_FLAG,
  hasOfferWorkspaceAccess,
  assertCanAccessOfferWorkspace,
  requireOfferWorkspace,
  assertCanWriteOfferRecord,
  assertCanSubmitOfferClarification,
  isAdminUser,
  isTaLeadRole,
  TA_LEAD_ROLES
};
