/**
 * Row-level scope for Candidate Control Tower list/metrics.
 * Assignment opens the workspace; visibility follows existing enterprise rules.
 */

const candidateAccessService = require("./candidateAccessService");
const { isEnterpriseTalentAdministratorUser } = require("../constants/employeeRoles");
const {
  isTaLeadUser
} = require("./requisitionCapabilityAuth");
const { resolveBoundHiringManager } = require("./hiringManagerIdentityService");

function resolveEmployeeCode(req) {
  return String(req.user?.employee_code || "").trim();
}

function isAdminUser(req) {
  return candidateAccessService.isAdminUser(req);
}

/**
 * Returns SQL boolean expression (using $n placeholders) and params to append.
 * Base alias: m = rm_candidate_mappings, cm = cand_mstr, r = rm_requisitions (optional join).
 */
async function buildApplicationVisibilityClause(pool, req, paramIndex) {
  if (isAdminUser(req)) {
    return { clause: "TRUE", params: [], nextIndex: paramIndex };
  }

  if (isEnterpriseTalentAdministratorUser(req)) {
    return { clause: "TRUE", params: [], nextIndex: paramIndex };
  }

  const employeeCode = resolveEmployeeCode(req);

  if (!employeeCode) {
    return { clause: "FALSE", params: [], nextIndex: paramIndex };
  }

  if (isTaLeadUser(req)) {
    return {
      clause: `EXISTS (
         SELECT 1
         FROM rm_requisitions r_scope
         WHERE r_scope.requisition_code = m.requisition_code
           AND UPPER(COALESCE(r_scope.req_status, '')) = 'APPROVED'
       )`,
      params: [],
      nextIndex: paramIndex
    };
  }

  const roleName = String(req.user?.role_name || "").trim();

  if (roleName === "Hiring Manager") {
    try {
      const hm = await resolveBoundHiringManager(pool, req);
      const hmName = String(hm?.hiring_manager_name || "").trim();

      if (hmName) {
        return {
          clause: `EXISTS (
             SELECT 1
             FROM rm_requisitions r_hm
             WHERE r_hm.requisition_code = m.requisition_code
               AND TRIM(COALESCE(r_hm.hiring_manager, '')) = $${paramIndex}
           )`,
          params: [hmName],
          nextIndex: paramIndex + 1
        };
      }
    } catch (_error) {
      return { clause: "FALSE", params: [], nextIndex: paramIndex };
    }
  }

  const idx = paramIndex;
  const clause = `(
    (
      UPPER(COALESCE(cm.candidate_container, 'PIPELINE')) = 'PIPELINE'
      AND TRIM(COALESCE(cm.owner_employee_code, '')) = $${idx}
    )
    OR EXISTS (
      SELECT 1
      FROM rm_recruiter_assignments a
      WHERE a.recruiter_code = $${idx}
        AND a.is_active = TRUE
        AND (
          a.requisition_code = m.requisition_code
          OR (m.req_id IS NOT NULL AND a.req_id = m.req_id)
        )
    )
  )`;

  return { clause, params: [employeeCode], nextIndex: paramIndex + 1 };
}

module.exports = {
  buildApplicationVisibilityClause,
  isAdminUser,
  resolveEmployeeCode
};
