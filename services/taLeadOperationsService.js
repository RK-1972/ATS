const { REQUISITION_STATUS } = require("../constants/requisitionStatus");
const { listActiveAtsStageCatalog } = require("./atsStageCatalogService");
const workflowService = require("./workflowService");
const {
  assertCanAccessTaLeadWorkspace,
  assertCanAssignRecruiters,
  assertCanCreateRequisition
} = require("./requisitionCapabilityAuth");
const { getRequisitionQueueCounts } = require("./workforcePlanningService");
const {
  countClosureEligibleRequisitions,
  enrichRequisitionsWithFulfillment
} = require("./requisitionFulfillmentService");

const ATTENTION_QUEUE_LIMIT = 50;

function authError(message, status = 403) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function mapRequisitionOversightRow(row) {
  const fulfillment = row.fulfillment || {};

  return {
    requisition_code: row.requisition_code,
    req_code: row.requisition_code,
    job_title: row.position_title || row.job_title,
    client_name: row.business_unit || row.department || row.client_name,
    department: row.department,
    headcount: row.headcount,
    req_status: row.req_status,
    priority_level: row.priority_level || null,
    created_on: row.created_on,
    assigned_on: row.assigned_on || null,
    fulfillment: {
      required_headcount: fulfillment.required_headcount ?? row.headcount ?? 0,
      filled_headcount: fulfillment.filled_headcount ?? 0,
      reserved_headcount: fulfillment.reserved_headcount ?? 0,
      remaining_headcount: fulfillment.remaining_headcount ?? 0,
      closure_eligible: Boolean(fulfillment.closure_eligible)
    }
  };
}

function normalizeStageSql(column, hrInterviewDisplayName = null) {
  const hrInterviewClause = hrInterviewDisplayName
    ? `WHEN LOWER(COALESCE(${column}, '')) LIKE '%hr interview%' THEN '${hrInterviewDisplayName.replace(/'/g, "''")}'
    `
    : "";

  return `CASE
    WHEN LOWER(COALESCE(${column}, '')) LIKE '%applied%' THEN 'Applied'
    WHEN LOWER(COALESCE(${column}, '')) LIKE '%screen%' THEN 'Screening'
    ${hrInterviewClause}WHEN LOWER(COALESCE(${column}, '')) ~ '(l1|level 1|technical)' THEN 'L1 Interview'
    WHEN LOWER(COALESCE(${column}, '')) ~ '(l2|level 2)' THEN 'L2 Interview'
    WHEN LOWER(COALESCE(${column}, '')) LIKE '%client%' THEN 'Client Interview'
    WHEN LOWER(COALESCE(${column}, '')) LIKE '%offer%' THEN 'Offer'
    WHEN LOWER(COALESCE(${column}, '')) LIKE '%join%' THEN 'Joined'
    ELSE 'Applied'
  END`;
}

function buildEmptyPipelineStageCounts(catalogStages = []) {
  const counts = {};

  catalogStages.forEach((stage) => {
    counts[stage.display_name] = 0;
  });

  return counts;
}

async function countApprovedRequisitions(pool) {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS total
     FROM rm_requisitions
     WHERE UPPER(COALESCE(req_status, '')) = $1`,
    [REQUISITION_STATUS.APPROVED.toUpperCase()]
  );

  return result.rows[0]?.total ?? 0;
}

async function countApprovedWithoutRecruiter(pool) {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS total
     FROM rm_requisitions r
     WHERE UPPER(COALESCE(r.req_status, '')) = $1
       AND NOT EXISTS (
         SELECT 1
         FROM rm_recruiter_assignments a
         WHERE a.requisition_code = r.requisition_code
           AND a.is_active = TRUE
       )`,
    [REQUISITION_STATUS.APPROVED.toUpperCase()]
  );

  return result.rows[0]?.total ?? 0;
}

async function listRecruiterWorkloadSummary(pool) {
  const result = await pool.query(
    `SELECT
       a.recruiter_code,
       u.full_name,
       COUNT(DISTINCT a.requisition_code)::int AS active_requisitions,
       COUNT(m.mapping_id)::int AS active_candidates
     FROM rm_recruiter_assignments a
     LEFT JOIN user_mstr u ON u.employee_code = a.recruiter_code
     LEFT JOIN rm_candidate_mappings m
       ON m.requisition_code = a.requisition_code
      AND m.is_active = TRUE
     WHERE a.is_active = TRUE
     GROUP BY a.recruiter_code, u.full_name
     ORDER BY active_candidates DESC, u.full_name NULLS LAST, a.recruiter_code`
  );

  return result.rows.map((row) => ({
    recruiter_code: row.recruiter_code,
    full_name: row.full_name,
    active_requisitions: row.active_requisitions,
    active_candidates: row.active_candidates
  }));
}

async function listPipelineStageCounts(pool) {
  const catalogStages = await listActiveAtsStageCatalog(pool);
  const counts = buildEmptyPipelineStageCounts(catalogStages);
  const hrInterviewStage = catalogStages.find(
    (stage) => stage.stage_code === "HR_INTERVIEW"
      || stage.display_name === "HR Interview"
  );

  const stageSql = normalizeStageSql(
    "m.stage_name",
    hrInterviewStage?.display_name || null
  );
  const result = await pool.query(
    `SELECT ${stageSql} AS stage, COUNT(*)::int AS count
     FROM rm_candidate_mappings m
     INNER JOIN rm_requisitions r
       ON r.requisition_code = m.requisition_code
     WHERE m.is_active = TRUE
       AND UPPER(COALESCE(r.req_status, '')) = $1
     GROUP BY 1
     ORDER BY count DESC, stage ASC`,
    [REQUISITION_STATUS.APPROVED.toUpperCase()]
  );

  result.rows.forEach((row) => {
    if (counts[row.stage] !== undefined) {
      counts[row.stage] = Number(row.count) || 0;
    }
  });

  return counts;
}

async function buildOperationsSummary(pool, req) {
  await assertCanAccessTaLeadWorkspace(pool, req);

  const summary = {
    requisitions: null,
    approvals: { pending: 0 },
    workforce: null,
    recruiter_workload: null,
    pipeline_stages: null
  };

  try {
    const approvals = await workflowService.getMyActiveApprovals(pool, req);
    summary.approvals = { pending: approvals.length };
  } catch (_error) {
    summary.approvals = { pending: 0 };
  }

  try {
    await assertCanAssignRecruiters(pool, req);
    const approved = await countApprovedRequisitions(pool);
    const withoutRecruiter = await countApprovedWithoutRecruiter(pool);

    summary.requisitions = {
      approved,
      without_recruiter: withoutRecruiter,
      closure_eligible: await countClosureEligibleRequisitions(pool)
    };
    summary.recruiter_workload = await listRecruiterWorkloadSummary(pool);
    summary.pipeline_stages = await listPipelineStageCounts(pool);
  } catch (_error) {
    summary.requisitions = null;
    summary.recruiter_workload = null;
    summary.pipeline_stages = null;
  }

  try {
    await assertCanCreateRequisition(pool, req);
    summary.workforce = {
      requisition_queue_counts: await getRequisitionQueueCounts(pool, req)
    };
  } catch (_error) {
    summary.workforce = null;
  }

  return summary;
}

async function resolveRecruiterOversightTarget(pool, recruiterCode) {
  const normalizedCode = String(recruiterCode || "").trim();

  if (!normalizedCode) {
    throw authError("Recruiter code is required.", 400);
  }

  const result = await pool.query(
    `SELECT employee_code, full_name, role_name
     FROM user_mstr
     WHERE employee_code = $1
       AND COALESCE(is_active, TRUE) = TRUE
     LIMIT 1`,
    [normalizedCode]
  );

  if (!result.rows[0]) {
    throw authError("Recruiter not found.", 404);
  }

  return result.rows[0];
}

async function listRecruiterPipelineStageCounts(pool, recruiterCode) {
  const catalogStages = await listActiveAtsStageCatalog(pool);
  const counts = buildEmptyPipelineStageCounts(catalogStages);
  const hrInterviewStage = catalogStages.find(
    (stage) => stage.stage_code === "HR_INTERVIEW"
      || stage.display_name === "HR Interview"
  );

  const stageSql = normalizeStageSql(
    "m.stage_name",
    hrInterviewStage?.display_name || null
  );
  const result = await pool.query(
    `SELECT ${stageSql} AS stage, COUNT(*)::int AS count
     FROM rm_candidate_mappings m
     INNER JOIN rm_requisitions r
       ON r.requisition_code = m.requisition_code
     INNER JOIN rm_recruiter_assignments a
       ON a.requisition_code = m.requisition_code
      AND a.is_active = TRUE
     WHERE m.is_active = TRUE
       AND a.recruiter_code = $1
       AND UPPER(COALESCE(r.req_status, '')) = $2
     GROUP BY 1
     ORDER BY count DESC, stage ASC`,
    [recruiterCode, REQUISITION_STATUS.APPROVED.toUpperCase()]
  );

  result.rows.forEach((row) => {
    if (counts[row.stage] !== undefined) {
      counts[row.stage] = Number(row.count) || 0;
    }
  });

  return counts;
}

async function getRecruiterOversightSummary(pool, req, recruiterCode) {
  await assertCanAssignRecruiters(pool, req);

  const recruiter = await resolveRecruiterOversightTarget(pool, recruiterCode);
  const normalizedCode = recruiter.employee_code;

  const requisitionResult = await pool.query(
    `SELECT DISTINCT r.*,
       a.assigned_on
     FROM rm_requisitions r
     INNER JOIN rm_recruiter_assignments a
       ON a.requisition_code = r.requisition_code
     WHERE a.recruiter_code = $1
       AND a.is_active = TRUE
       AND r.req_status = ANY($2::text[])
     ORDER BY a.assigned_on DESC NULLS LAST, r.created_on DESC`,
    [
      normalizedCode,
      [
        REQUISITION_STATUS.APPROVED,
        REQUISITION_STATUS.CLOSED_FILLED,
        REQUISITION_STATUS.CLOSED_CANCELLED
      ]
    ]
  );

  const enrichedRequisitions = await enrichRequisitionsWithFulfillment(
    pool,
    requisitionResult.rows
  );

  const activeCandidateResult = await pool.query(
    `SELECT COUNT(m.mapping_id)::int AS total
     FROM rm_candidate_mappings m
     INNER JOIN rm_recruiter_assignments a
       ON a.requisition_code = m.requisition_code
      AND a.is_active = TRUE
     INNER JOIN rm_requisitions r
       ON r.requisition_code = m.requisition_code
     WHERE a.recruiter_code = $1
       AND m.is_active = TRUE
       AND UPPER(COALESCE(r.req_status, '')) = $2`,
    [normalizedCode, REQUISITION_STATUS.APPROVED.toUpperCase()]
  );

  const activeRequisitions = enrichedRequisitions.filter(
    (row) => row.req_status === REQUISITION_STATUS.APPROVED
  );

  return {
    recruiter: {
      recruiter_code: recruiter.employee_code,
      full_name: recruiter.full_name,
      role_name: recruiter.role_name
    },
    active_requisitions: activeRequisitions.length,
    active_candidates: activeCandidateResult.rows[0]?.total ?? 0,
    requisitions: enrichedRequisitions.map(mapRequisitionOversightRow),
    pipeline_stages: await listRecruiterPipelineStageCounts(pool, normalizedCode)
  };
}

async function listApprovedWithoutRecruiterRequisitions(pool) {
  const result = await pool.query(
    `SELECT
       r.requisition_code,
       r.position_title,
       r.business_unit,
       r.department,
       r.headcount,
       r.priority_level,
       r.created_on
     FROM rm_requisitions r
     WHERE UPPER(COALESCE(r.req_status, '')) = $1
       AND NOT EXISTS (
         SELECT 1
         FROM rm_recruiter_assignments a
         WHERE a.requisition_code = r.requisition_code
           AND a.is_active = TRUE
       )
     ORDER BY r.created_on DESC NULLS LAST
     LIMIT $2`,
    [REQUISITION_STATUS.APPROVED.toUpperCase(), ATTENTION_QUEUE_LIMIT]
  );

  return result.rows.map((row) => ({
    requisition_code: row.requisition_code,
    req_code: row.requisition_code,
    job_title: row.position_title,
    client_name: row.business_unit || row.department,
    department: row.department,
    headcount: row.headcount,
    priority_level: row.priority_level,
    created_on: row.created_on
  }));
}

async function listClosureEligibleRequisitions(pool) {
  const result = await pool.query(
    `SELECT r.*
     FROM rm_requisitions r
     WHERE r.req_status = $1
     ORDER BY r.created_on DESC NULLS LAST
     LIMIT $2`,
    [REQUISITION_STATUS.APPROVED, ATTENTION_QUEUE_LIMIT * 4]
  );

  if (!result.rows.length) {
    return [];
  }

  const enriched = await enrichRequisitionsWithFulfillment(pool, result.rows);

  return enriched
    .filter((row) => row.fulfillment?.closure_eligible === true)
    .slice(0, ATTENTION_QUEUE_LIMIT)
    .map(mapRequisitionOversightRow);
}

async function getAttentionQueues(pool, req) {
  await assertCanAssignRecruiters(pool, req);

  return {
    without_recruiter: await listApprovedWithoutRecruiterRequisitions(pool),
    closure_eligible: await listClosureEligibleRequisitions(pool)
  };
}

module.exports = {
  buildOperationsSummary,
  countApprovedRequisitions,
  countApprovedWithoutRecruiter,
  listRecruiterWorkloadSummary,
  listPipelineStageCounts,
  getRecruiterOversightSummary,
  getAttentionQueues,
  listApprovedWithoutRecruiterRequisitions,
  listClosureEligibleRequisitions
};
