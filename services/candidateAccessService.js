/**
 * Enterprise candidate read visibility — mirrors scoped list endpoints:
 *   GET /my-candidates-list  → PIPELINE + owner_employee_code = caller
 *   GET /available-candidates → candidate_container = TALENT_POOL
 * Admin retains unrestricted read access.
 */

const {
  isCandidateInIntakeReviewQueue
} = require("./candidatePortalProfileService");

function httpError(message, status = 403) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function isAdminUser(req) {
  return String(req.user?.role_name || "").trim() === "Admin";
}

function resolveEmployeeCode(req) {
  return String(req.user?.employee_code || "").trim();
}

function normalizeContainer(value) {
  return String(value || "PIPELINE").trim().toUpperCase();
}

function isRecruiterUser(req) {
  const roleName = String(req.user?.role_name || "").trim();
  const secondaryRole = String(req.user?.secondary_role || "").trim();

  return roleName === "Recruiter" || secondaryRole === "Recruiter";
}

function canReadCandidateRow(row, req) {
  if (!row) {
    return false;
  }

  if (isAdminUser(req)) {
    return true;
  }

  const employeeCode = resolveEmployeeCode(req);

  if (!employeeCode) {
    return false;
  }

  const container = normalizeContainer(row.candidate_container);

  if (container === "TALENT_POOL") {
    return true;
  }

  if (container === "PIPELINE") {
    return String(row.owner_employee_code || "").trim() === employeeCode;
  }

  return false;
}

async function canReviewDraftCandidateRow(pool, row, req) {
  if (!row) {
    return false;
  }

  if (String(row.candidate_status || "").trim().toUpperCase() !== "DRAFT") {
    return false;
  }

  if (String(row.owner_employee_code || "").trim()) {
    return false;
  }

  if (!isRecruiterUser(req)) {
    return false;
  }

  return await isCandidateInIntakeReviewQueue(pool, row.candidate_id);
}

async function loadCandidateAccessRow(pool, candidateId) {
  const result = await pool.query(
    `SELECT candidate_id, candidate_container, owner_employee_code, candidate_status
     FROM cand_mstr
     WHERE candidate_id = $1`,
    [candidateId]
  );

  return result.rows[0] || null;
}

async function assertCandidateReadAccess(pool, req, candidateId) {
  const accessRow = await loadCandidateAccessRow(pool, candidateId);

  if (!accessRow) {
    throw httpError("Candidate not found.", 404);
  }

  if (canReadCandidateRow(accessRow, req)) {
    return accessRow;
  }

  if (await canReviewDraftCandidateRow(pool, accessRow, req)) {
    return accessRow;
  }

  throw httpError(
    "Enterprise Access Denied. You are not authorized to view this candidate.",
    403
  );
}

async function listAuthorizedCandidateMasters(pool, req) {
  if (isAdminUser(req)) {
    const result = await pool.query(
      `SELECT *
       FROM cand_mstr
       ORDER BY candidate_id DESC`
    );
    return result.rows;
  }

  const employeeCode = resolveEmployeeCode(req);

  if (!employeeCode) {
    throw httpError("Authenticated employee_code is required.", 401);
  }

  const result = await pool.query(
    `SELECT *
     FROM cand_mstr cm
     WHERE UPPER(COALESCE(cm.candidate_container, 'PIPELINE')) = 'TALENT_POOL'
        OR (
          UPPER(COALESCE(cm.candidate_container, 'PIPELINE')) = 'PIPELINE'
          AND cm.owner_employee_code = $1
        )
     ORDER BY cm.candidate_id DESC`,
    [employeeCode]
  );

  return result.rows;
}

module.exports = {
  isAdminUser,
  isRecruiterUser,
  canReadCandidateRow,
  canReviewDraftCandidateRow,
  assertCandidateReadAccess,
  listAuthorizedCandidateMasters
};
