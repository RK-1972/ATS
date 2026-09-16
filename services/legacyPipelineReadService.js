/**
 * Legacy pipeline list endpoints — read through rm_candidate_mappings first,
 * with deduplicated fallback to candidate_req_map for unbackfilled history.
 */

async function tableExists(pool, tableName) {
  const result = await pool.query(
    `SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = $1
    ) AS exists`,
    [tableName]
  );

  return result.rows[0]?.exists === true;
}

async function resolveRecruiterScopeIds(pool, employeeCode) {
  const normalizedCode = String(employeeCode || "").trim();
  if (!normalizedCode) {
    return [];
  }

  const result = await pool.query(
    `SELECT employee_code, full_name, email_id
     FROM user_mstr
     WHERE employee_code = $1
     LIMIT 1`,
    [normalizedCode]
  );

  const row = result.rows[0] || {};
  const identifiers = new Set([normalizedCode]);

  if (row.full_name) {
    identifiers.add(String(row.full_name).trim());
  }

  if (row.email_id) {
    identifiers.add(String(row.email_id).trim());
  }

  return Array.from(identifiers).filter(Boolean);
}

const LEGACY_FALLBACK_NOT_IN_ENTERPRISE = `
  NOT EXISTS (
    SELECT 1
    FROM rm_candidate_mappings e
    WHERE e.is_active = true
      AND (
        (e.map_id IS NOT NULL AND e.map_id = l.map_id)
        OR (
          e.candidate_id = l.candidate_id
          AND e.req_id IS NOT NULL
          AND l.req_id IS NOT NULL
          AND e.req_id = l.req_id
        )
      )
  )
`;

async function listPipelineDetails(pool, options = {}) {
  const { roleName, recruiterScopeIds = [] } = options;
  const hasLegacyMap = await tableExists(pool, "candidate_req_map");
  const recruiterFilter =
    roleName === "Recruiter" && recruiterScopeIds.length
      ? `AND c.recruiter_id = ANY($1::text[])`
      : "";
  const params =
    roleName === "Recruiter" && recruiterScopeIds.length
      ? [recruiterScopeIds]
      : [];

  const legacyUnion = hasLegacyMap
    ? `
      UNION ALL
      SELECT
        l.map_id,
        l.candidate_id,
        l.req_id,
        NULL::varchar AS requisition_code,
        l.recruiter_id,
        l.stage_name,
        l.source_type,
        l.applied_date AS applied_sort
      FROM candidate_req_map l
      WHERE l.is_active = true
        AND ${LEGACY_FALLBACK_NOT_IN_ENTERPRISE}
    `
    : "";

  const query = `
    WITH combined AS (
      SELECT
        m.map_id,
        m.candidate_id,
        m.req_id,
        m.requisition_code,
        m.recruiter_id,
        m.stage_name,
        m.source_type,
        m.applied_on AS applied_sort
      FROM rm_candidate_mappings m
      WHERE m.is_active = true
      ${legacyUnion}
    )
    SELECT
      c.map_id,
      cm.candidate_code,
      cm.first_name,
      cm.last_name,
      COALESCE(rr.requisition_code, rm.req_code) AS req_code,
      COALESCE(rr.position_title, rm.job_title) AS job_title,
      COALESCE(rr.business_unit, rm.client_name) AS client_name,
      COALESCE(rr.department, rm.project_name) AS project_name,
      c.stage_name,
      c.source_type,
      c.recruiter_id,
      c.applied_sort AS applied_date
    FROM combined c
    LEFT JOIN cand_mstr cm ON cm.candidate_id = c.candidate_id
    LEFT JOIN rm_requisitions rr
      ON rr.requisition_code = c.requisition_code
      OR (c.requisition_code IS NULL AND c.req_id IS NOT NULL AND rr.req_id = c.req_id)
    LEFT JOIN req_mstr rm ON rm.req_id = c.req_id
    WHERE 1 = 1
    ${recruiterFilter}
    ORDER BY c.applied_sort DESC NULLS LAST
  `;

  const result = await pool.query(query, params);
  return result.rows;
}

async function listMyCandidatesList(pool, employeeCode) {
  const hasLegacyMap = await tableExists(pool, "candidate_req_map");
  const legacyJoin = hasLegacyMap
    ? `
      LEFT JOIN candidate_req_map lcrm
        ON lcrm.candidate_id = cm.candidate_id
       AND lcrm.is_active = true
       AND em.mapping_id IS NULL
      LEFT JOIN req_mstr rm
        ON rm.req_id = COALESCE(em.req_id, lcrm.req_id)
    `
    : `
      LEFT JOIN req_mstr rm
        ON rm.req_id = em.req_id
    `;

  const legacySelect = hasLegacyMap
    ? `
      COALESCE(em.stage_name, lcrm.stage_name) AS stage_name,
      COALESCE(em.source_type, lcrm.source_type) AS source_type,
      COALESCE(em.applied_on, lcrm.applied_date) AS applied_date,
      COALESCE(rr.requisition_code, rm.req_code) AS req_code,
      COALESCE(rr.position_title, rm.job_title) AS job_title
    `
    : `
      em.stage_name,
      em.source_type,
      em.applied_on AS applied_date,
      rr.requisition_code AS req_code,
      rr.position_title AS job_title
    `;

  const query = `
    SELECT
      cm.candidate_id,
      cm.candidate_code,
      cm.first_name,
      cm.last_name,
      cm.email_id,
      cm.mobile_number,
      cm.primary_skill,
      cm.total_experience,
      ${legacySelect}
    FROM cand_mstr cm
    LEFT JOIN rm_candidate_mappings em
      ON em.candidate_id = cm.candidate_id
     AND em.is_active = true
    LEFT JOIN rm_requisitions rr
      ON rr.requisition_code = em.requisition_code
    ${legacyJoin}
    WHERE cm.candidate_container = 'PIPELINE'
      AND cm.owner_employee_code = $1
    ORDER BY applied_date DESC NULLS LAST
  `;

  const result = await pool.query(query, [employeeCode]);
  return result.rows;
}

async function listCandidatesByReq(pool, reqId) {
  const hasLegacyMap = await tableExists(pool, "candidate_req_map");
  const legacyUnion = hasLegacyMap
    ? `
      UNION ALL
      SELECT
        l.map_id,
        l.stage_name,
        l.source_type,
        l.applied_date AS applied_date,
        l.remarks,
        l.recruiter_id,
        l.candidate_id,
        l.req_id,
        NULL::varchar AS requisition_code
      FROM candidate_req_map l
      WHERE l.req_id = $1::int
        AND l.is_active = true
        AND ${LEGACY_FALLBACK_NOT_IN_ENTERPRISE}
    `
    : "";

  const query = `
    WITH combined AS (
      SELECT
        m.map_id,
        m.stage_name,
        m.source_type,
        m.applied_on AS applied_date,
        m.remarks,
        m.recruiter_id,
        m.candidate_id,
        m.req_id,
        m.requisition_code
      FROM rm_candidate_mappings m
      WHERE m.is_active = true
        AND m.req_id = $1::int
      ${legacyUnion}
    )
    SELECT
      c.map_id,
      c.stage_name,
      c.source_type,
      c.applied_date,
      c.remarks,
      c.recruiter_id,
      cm.candidate_id,
      cm.candidate_code,
      cm.first_name,
      cm.last_name,
      cm.email_id,
      cm.mobile_number,
      COALESCE(rr.req_id, rm.req_id) AS req_id,
      COALESCE(rr.requisition_code, rm.req_code) AS req_code,
      COALESCE(rr.position_title, rm.job_title) AS job_title
    FROM combined c
    LEFT JOIN cand_mstr cm ON cm.candidate_id = c.candidate_id
    LEFT JOIN rm_requisitions rr
      ON rr.requisition_code = c.requisition_code
      OR (c.requisition_code IS NULL AND c.req_id IS NOT NULL AND rr.req_id = c.req_id)
    LEFT JOIN req_mstr rm ON rm.req_id = c.req_id
    ORDER BY c.applied_date DESC NULLS LAST
  `;

  const result = await pool.query(query, [reqId]);
  return result.rows;
}

function buildAppliedOnDateFilter(period) {
  if (period === "today") {
    return "AND applied_on::date = CURRENT_DATE";
  }

  if (period === "week") {
    return "AND applied_on >= date_trunc('week', CURRENT_DATE)";
  }

  if (period === "month") {
    return "AND applied_on >= date_trunc('month', CURRENT_DATE)";
  }

  if (period === "quarter") {
    return "AND applied_on >= date_trunc('quarter', CURRENT_DATE)";
  }

  if (period === "year") {
    return "AND applied_on >= date_trunc('year', CURRENT_DATE)";
  }

  return "";
}

function buildAppliedDateDateFilter(period) {
  if (period === "today") {
    return "AND applied_date::date = CURRENT_DATE";
  }

  if (period === "week") {
    return "AND applied_date >= date_trunc('week', CURRENT_DATE)";
  }

  if (period === "month") {
    return "AND applied_date >= date_trunc('month', CURRENT_DATE)";
  }

  if (period === "quarter") {
    return "AND applied_date >= date_trunc('quarter', CURRENT_DATE)";
  }

  if (period === "year") {
    return "AND applied_date >= date_trunc('year', CURRENT_DATE)";
  }

  return "";
}

async function countPipelineRecords(pool, period = "month") {
  const hasLegacyMap = await tableExists(pool, "candidate_req_map");
  const enterpriseDateFilter = buildAppliedOnDateFilter(period);
  const legacyDateFilter = buildAppliedDateDateFilter(period);

  const legacyUnion = hasLegacyMap
    ? `
      UNION ALL
      SELECT l.map_id
      FROM candidate_req_map l
      WHERE l.is_active = true
        ${legacyDateFilter}
        AND ${LEGACY_FALLBACK_NOT_IN_ENTERPRISE}
    `
    : "";

  const query = `
    WITH combined AS (
      SELECT m.map_id
      FROM rm_candidate_mappings m
      WHERE m.is_active = true
      ${enterpriseDateFilter}
      ${legacyUnion}
    )
    SELECT COUNT(*)::int AS pipeline_records
    FROM combined
  `;

  const result = await pool.query(query);
  return result.rows[0]?.pipeline_records || 0;
}

async function listCandidateMappingsForRequisitions(
  pool,
  { requisitionCodes = [], reqIds = [] } = {}
) {
  const codes = Array.from(
    new Set(
      (requisitionCodes || [])
        .map((value) => String(value).trim())
        .filter(Boolean)
    )
  );
  const ids = Array.from(
    new Set(
      (reqIds || [])
        .map((value) => parseInt(value, 10))
        .filter((value) => !Number.isNaN(value))
    )
  );

  if (!codes.length && !ids.length) {
    return [];
  }

  const hasLegacyMap = await tableExists(pool, "candidate_req_map");
  const scopeConditions = [];
  const params = [];
  let paramIndex = 1;

  if (codes.length) {
    scopeConditions.push(`m.requisition_code = ANY($${paramIndex}::varchar[])`);
    params.push(codes);
    paramIndex += 1;
  }

  if (ids.length) {
    scopeConditions.push(
      `(m.req_id IS NOT NULL AND m.req_id = ANY($${paramIndex}::int[]))`
    );
    params.push(ids);
    paramIndex += 1;
  }

  const legacyReqParam = paramIndex;
  const legacyUnion =
    hasLegacyMap && ids.length
      ? `
      UNION ALL
      SELECT
        l.map_id,
        NULL::int AS mapping_id,
        l.candidate_id,
        l.req_id,
        NULL::varchar AS requisition_code,
        l.stage_name,
        l.source_type,
        l.applied_date AS applied_sort,
        l.remarks,
        l.recruiter_id
      FROM candidate_req_map l
      WHERE l.is_active = true
        AND l.req_id = ANY($${legacyReqParam}::int[])
        AND ${LEGACY_FALLBACK_NOT_IN_ENTERPRISE}
    `
      : "";

  if (hasLegacyMap && ids.length) {
    params.push(ids);
    paramIndex += 1;
  }

  const query = `
    WITH combined AS (
      SELECT
        m.map_id,
        m.mapping_id,
        m.candidate_id,
        m.req_id,
        m.requisition_code,
        m.stage_name,
        m.source_type,
        m.applied_on AS applied_sort,
        m.remarks,
        m.recruiter_id
      FROM rm_candidate_mappings m
      WHERE m.is_active = true
        AND (${scopeConditions.join(" OR ")})
      ${legacyUnion}
    )
    SELECT DISTINCT ON (c.map_id)
      c.map_id,
      c.mapping_id,
      c.candidate_id,
      c.stage_name,
      c.source_type,
      c.applied_sort AS applied_date,
      c.remarks,
      c.recruiter_id,
      cm.candidate_code,
      cm.first_name,
      cm.last_name,
      cm.email_id,
      cm.mobile_number,
      cm.primary_skill,
      cm.total_experience,
      COALESCE(rr.req_id, rm.req_id, c.req_id) AS req_id,
      COALESCE(rr.requisition_code, rm.req_code, c.requisition_code) AS req_code,
      COALESCE(rr.position_title, rm.job_title) AS job_title,
      COALESCE(rr.business_unit, rm.client_name) AS client_name,
      COALESCE(rr.department, rm.project_name) AS project_name
    FROM combined c
    LEFT JOIN cand_mstr cm ON cm.candidate_id = c.candidate_id
    LEFT JOIN rm_requisitions rr
      ON rr.requisition_code = c.requisition_code
      OR (c.requisition_code IS NULL AND c.req_id IS NOT NULL AND rr.req_id = c.req_id)
    LEFT JOIN req_mstr rm ON rm.req_id = c.req_id
    ORDER BY c.map_id, c.applied_sort DESC NULLS LAST
  `;

  const result = await pool.query(query, params);
  return result.rows;
}

module.exports = {
  listPipelineDetails,
  listMyCandidatesList,
  listCandidatesByReq,
  listCandidateMappingsForRequisitions,
  countPipelineRecords,
  resolveRecruiterScopeIds
};
