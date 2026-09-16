/**
 * Hiring Manager identity resolution — binds logged-in users to hiring_manager_mstr
 * via employee_code (preferred) with email bridge for unbackfilled master rows.
 */

const {
  listCandidateMappingsForRequisitions
} = require("./legacyPipelineReadService");

function httpError(message, status = 403) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function tableHasColumn(pool, tableName, columnName) {
  const result = await pool.query(
    `SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
        AND column_name = $2
    ) AS exists`,
    [tableName, columnName]
  );

  return result.rows[0]?.exists === true;
}

function resolveEmployeeCode(req) {
  return String(req.user?.employee_code || "").trim();
}

/**
 * Resolve the active hiring_manager_mstr row for the authenticated user.
 * Never accepts client-supplied HM identifiers.
 */
async function resolveBoundHiringManager(pool, req) {
  const employeeCode = resolveEmployeeCode(req);

  if (!employeeCode) {
    throw httpError("Authenticated employee_code is required.", 401);
  }

  const hasEmployeeCodeColumn = await tableHasColumn(
    pool,
    "hiring_manager_mstr",
    "employee_code"
  );

  if (hasEmployeeCodeColumn) {
    const byEmployeeCode = await pool.query(
      `SELECT *
       FROM hiring_manager_mstr
       WHERE is_active = TRUE
         AND employee_code = $1
       ORDER BY hiring_manager_id ASC
       LIMIT 1`,
      [employeeCode]
    );

    if (byEmployeeCode.rows[0]) {
      return byEmployeeCode.rows[0];
    }
  }

  const byEmailBridge = await pool.query(
    `SELECT hm.*
     FROM hiring_manager_mstr hm
     INNER JOIN user_mstr u
       ON u.employee_code = $1
     WHERE hm.is_active = TRUE
       AND COALESCE(u.is_active, TRUE) = TRUE
       AND hm.email_id IS NOT NULL
       AND u.email_id IS NOT NULL
       AND LOWER(TRIM(hm.email_id)) = LOWER(TRIM(u.email_id))
       AND (
         $2::boolean = FALSE
         OR hm.employee_code IS NULL
         OR hm.employee_code = u.employee_code
       )
     ORDER BY hm.hiring_manager_id ASC
     LIMIT 1`,
    [employeeCode, hasEmployeeCodeColumn]
  );

  if (byEmailBridge.rows[0]) {
    return byEmailBridge.rows[0];
  }

  throw httpError(
    "Enterprise Access Denied. No active Hiring Manager profile is bound to this user.",
    403
  );
}

/**
 * List enterprise requisitions assigned to the resolved Hiring Manager.
 * Uses rm_requisitions as SoR; includes legacy rows matched by master name when req FK is null.
 */
function mapHmRequisitionRow(row) {
  return {
    req_id: row.req_id,
    req_code: row.requisition_code,
    requisition_code: row.requisition_code,
    client_name: row.business_unit || row.department,
    project_name: row.department,
    job_title: row.position_title,
    job_description: null,
    primary_skill: row.primary_skill,
    secondary_skill: null,
    experience_min: null,
    experience_max: null,
    openings_count: row.headcount,
    work_location: row.location,
    employment_type: row.employment_type,
    priority_level: "High",
    req_status: row.req_status,
    recruiter_id: null,
    hiring_manager: row.hiring_manager,
    hiring_manager_id: row.hiring_manager_id,
    target_date: null,
    created_by: row.created_by,
    created_on: row.created_on,
    updated_on: row.modified_on
  };
}

async function loadHmOwnedRequisitionRows(pool, hiringManager) {
  const managerName = String(hiringManager.hiring_manager_name || "").trim();

  const result = await pool.query(
    `SELECT r.*
     FROM rm_requisitions r
     WHERE r.hiring_manager_id = $1
        OR (
          r.hiring_manager_id IS NULL
          AND $2 <> ''
          AND LOWER(TRIM(COALESCE(r.hiring_manager, ''))) = LOWER($2)
        )
     ORDER BY r.created_on DESC NULLS LAST, r.req_id DESC NULLS LAST`,
    [hiringManager.hiring_manager_id, managerName]
  );

  return result.rows;
}

async function resolveHmRequisitionScope(pool, req, filter = {}) {
  const hiringManager = await resolveBoundHiringManager(pool, req);
  const ownedRows = await loadHmOwnedRequisitionRows(pool, hiringManager);
  const filterCode = String(filter.requisition_code || "").trim();
  const filterReqIdRaw = filter.req_id;
  const filterReqId =
    filterReqIdRaw === undefined || filterReqIdRaw === null || filterReqIdRaw === ""
      ? null
      : parseInt(filterReqIdRaw, 10);

  if (filterReqId !== null && Number.isNaN(filterReqId)) {
    throw httpError("Invalid requisition identifier.", 400);
  }

  if (!filterCode && filterReqId === null) {
    return {
      hiringManager,
      ownedRows,
      requisitionCodes: ownedRows
        .map((row) => String(row.requisition_code || "").trim())
        .filter(Boolean),
      reqIds: ownedRows
        .map((row) => row.req_id)
        .filter((value) => value !== null && value !== undefined)
    };
  }

  const ownedMatch = ownedRows.find((row) => {
    const codeMatches = !filterCode || row.requisition_code === filterCode;
    const idMatches = filterReqId === null || row.req_id === filterReqId;
    return codeMatches && idMatches;
  });

  if (!ownedMatch) {
    throw httpError(
      "Requisition not found or not assigned to this Hiring Manager.",
      404
    );
  }

  return {
    hiringManager,
    ownedRows: [ownedMatch],
    requisitionCodes: ownedMatch.requisition_code
      ? [String(ownedMatch.requisition_code).trim()]
      : [],
    reqIds:
      ownedMatch.req_id !== null && ownedMatch.req_id !== undefined
        ? [ownedMatch.req_id]
        : []
  };
}

async function listMyHmRequisitions(pool, req) {
  const hiringManager = await resolveBoundHiringManager(pool, req);
  const ownedRows = await loadHmOwnedRequisitionRows(pool, hiringManager);
  return ownedRows.map(mapHmRequisitionRow);
}

function mapHmCandidateRow(row) {
  return {
    map_id: row.map_id,
    mapping_id: row.mapping_id,
    candidate_id: row.candidate_id,
    candidate_code: row.candidate_code,
    first_name: row.first_name,
    last_name: row.last_name,
    email_id: row.email_id,
    mobile_number: row.mobile_number,
    primary_skill: row.primary_skill,
    total_experience: row.total_experience,
    req_id: row.req_id,
    req_code: row.req_code,
    requisition_code: row.req_code,
    job_title: row.job_title,
    client_name: row.client_name,
    project_name: row.project_name,
    stage_name: row.stage_name,
    source_type: row.source_type,
    recruiter_id: row.recruiter_id,
    applied_date: row.applied_date,
    remarks: row.remarks
  };
}

async function listMyHmCandidates(pool, req, filter = {}) {
  const scope = await resolveHmRequisitionScope(pool, req, filter);

  const rows = await listCandidateMappingsForRequisitions(pool, {
    requisitionCodes: scope.requisitionCodes,
    reqIds: scope.reqIds
  });

  return rows.map(mapHmCandidateRow);
}

module.exports = {
  resolveBoundHiringManager,
  resolveHmRequisitionScope,
  listMyHmRequisitions,
  listMyHmCandidates
};
