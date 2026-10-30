const {
  buildApplicationVisibilityClause,
  resolveEmployeeCode
} = require("./candidateControlTowerScope");

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function pickText(...values) {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) {
      return text;
    }
  }
  return "";
}

function normalizeListParams(query = {}) {
  const q = String(query.q || query.search || "").trim();
  const owner = String(query.owner || query.recruiter || "").trim();
  const requisition = String(query.requisition || query.requisition_code || "").trim();
  const stage = String(query.stage || query.pipeline_stage || "").trim();
  const interviewStatus = String(query.interview_status || query.interviewStatus || "").trim();
  const offerStatus = String(query.offer_status || query.offerStatus || "").trim();
  const source = String(query.source || query.source_type || "").trim();
  const sortBy = String(query.sortBy || "last_activity").trim();
  const sortDir = String(query.sortDir || query.sort || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const pageSize = Math.min(Math.max(parseInt(query.pageSize, 10) || 20, 1), 100);
  const mappingIdRaw = query.mappingId ?? query.mapping_id;
  const mappingId = mappingIdRaw != null ? parseInt(mappingIdRaw, 10) : null;

  return {
    q,
    owner,
    requisition,
    stage,
    interviewStatus,
    offerStatus,
    source,
    sortBy,
    sortDir,
    page,
    pageSize,
    offset: (page - 1) * pageSize,
    mappingId: Number.isFinite(mappingId) ? mappingId : null
  };
}

const SORT_COLUMNS = Object.freeze({
  candidate: "candidate_sort",
  owner: "owner_sort",
  requisition: "requisition_sort",
  stage: "m.stage_name",
  interview_status: "interview_status_sort",
  offer_status: "offer_status_sort",
  last_activity: "last_activity_sort"
});

function resolveSortColumn(sortBy) {
  return SORT_COLUMNS[sortBy] || SORT_COLUMNS.last_activity;
}

function buildFilterClauses(filters, startIndex) {
  const clauses = [];
  const values = [];
  let idx = startIndex;

  if (filters.mappingId) {
    clauses.push(`m.mapping_id = $${idx}`);
    values.push(filters.mappingId);
    idx += 1;
  }

  if (filters.q) {
    clauses.push(`(
      cm.candidate_code ILIKE '%' || $${idx} || '%'
      OR cm.first_name ILIKE '%' || $${idx} || '%'
      OR cm.last_name ILIKE '%' || $${idx} || '%'
      OR TRIM(COALESCE(cm.first_name, '') || ' ' || COALESCE(cm.last_name, '')) ILIKE '%' || $${idx} || '%'
      OR cm.email_id ILIKE '%' || $${idx} || '%'
      OR CAST(cm.candidate_id AS text) ILIKE '%' || $${idx} || '%'
    )`);
    values.push(filters.q);
    idx += 1;
  }

  if (filters.owner) {
    clauses.push(`(
      COALESCE(owner_u.full_name, '') ILIKE '%' || $${idx} || '%'
      OR COALESCE(owner_u.employee_code, '') ILIKE '%' || $${idx} || '%'
      OR COALESCE(m.recruiter_id, '') ILIKE '%' || $${idx} || '%'
      OR COALESCE(cm.owner_employee_code, '') ILIKE '%' || $${idx} || '%'
    )`);
    values.push(filters.owner);
    idx += 1;
  }

  if (filters.requisition) {
    clauses.push(`(
      m.requisition_code ILIKE '%' || $${idx} || '%'
      OR COALESCE(r.position_title, '') ILIKE '%' || $${idx} || '%'
    )`);
    values.push(filters.requisition);
    idx += 1;
  }

  if (filters.stage) {
    clauses.push(`m.stage_name ILIKE '%' || $${idx} || '%'`);
    values.push(filters.stage);
    idx += 1;
  }

  if (filters.source) {
    clauses.push(`COALESCE(m.source_type, '') ILIKE '%' || $${idx} || '%'`);
    values.push(filters.source);
    idx += 1;
  }

  if (filters.interviewStatus) {
    clauses.push(`COALESCE(latest_iv.interview_status, 'Not Scheduled') ILIKE '%' || $${idx} || '%'`);
    values.push(filters.interviewStatus);
    idx += 1;
  }

  if (filters.offerStatus) {
    clauses.push(`COALESCE(latest_offer.offer_status, 'Not Initiated') ILIKE '%' || $${idx} || '%'`);
    values.push(filters.offerStatus);
    idx += 1;
  }

  return { clauses, values, nextIndex: idx };
}

function applicationSelectFromSql() {
  return `
    FROM rm_candidate_mappings m
    INNER JOIN cand_mstr cm ON cm.candidate_id = m.candidate_id
    LEFT JOIN rm_requisitions r ON r.requisition_code = m.requisition_code
    LEFT JOIN user_mstr owner_u
      ON owner_u.employee_code = COALESCE(
        NULLIF(TRIM(cm.owner_employee_code), ''),
        NULLIF(TRIM(m.recruiter_id), '')
      )
    LEFT JOIN LATERAL (
      SELECT i.interview_status, i.scheduled_on
      FROM im_interviews i
      WHERE (
        (m.map_id IS NOT NULL AND i.map_id = m.map_id)
        OR (
          i.candidate_id = m.candidate_id
          AND (
            i.requisition_code = m.requisition_code
            OR (m.req_id IS NOT NULL AND i.req_id = m.req_id)
          )
        )
      )
      ORDER BY i.scheduled_on DESC NULLS LAST, i.created_on DESC NULLS LAST
      LIMIT 1
    ) latest_iv ON TRUE
    LEFT JOIN LATERAL (
      SELECT o.offer_status
      FROM om_offers o
      WHERE (
        o.mapping_id = m.mapping_id
        OR o.mapping_id = m.map_id
        OR (
          o.candidate_id = m.candidate_id
          AND o.requisition_code = m.requisition_code
        )
      )
      ORDER BY o.modified_on DESC NULLS LAST, o.created_on DESC NULLS LAST
      LIMIT 1
    ) latest_offer ON TRUE
    LEFT JOIN LATERAL (
      SELECT h.changed_on
      FROM rm_pipeline_history h
      WHERE h.mapping_id = m.mapping_id
      ORDER BY h.changed_on DESC NULLS LAST
      LIMIT 1
    ) latest_hist ON TRUE
  `;
}

function mapApplicationRow(row) {
  const firstName = pickText(row.first_name);
  const lastName = pickText(row.last_name);
  const candidateName = pickText(`${firstName} ${lastName}`.trim(), row.preferred_name);

  return {
    mapping_id: row.mapping_id,
    map_id: row.map_id,
    candidate_id: row.candidate_id,
    candidate_code: pickText(row.candidate_code),
    candidate_name: candidateName,
    email_id: pickText(row.email_id),
    mobile_number: pickText(row.mobile_number),
    owner_employee_code: pickText(row.owner_employee_code, row.recruiter_id),
    owner_name: pickText(row.owner_name) || "Unassigned",
    requisition_code: pickText(row.requisition_code),
    position_title: pickText(row.position_title),
    stage_name: pickText(row.stage_name, "Applied"),
    source_type: pickText(row.source_type),
    interview_status: pickText(row.interview_status, "Not Scheduled"),
    offer_status: pickText(row.offer_status, "Not Initiated"),
    last_activity_at: row.last_activity_sort,
    time_in_stage_days: row.time_in_stage_days,
    applied_on: row.applied_on
  };
}

async function buildScopedQueryParts(pool, req, filters) {
  const visibility = await buildApplicationVisibilityClause(pool, req, 1);
  let paramIndex = visibility.nextIndex;

  const filterParts = buildFilterClauses(filters, paramIndex);
  paramIndex = filterParts.nextIndex;

  const params = [...visibility.params, ...filterParts.values];
  const whereParts = ["m.is_active = TRUE", `(${visibility.clause})`];

  if (filterParts.clauses.length) {
    whereParts.push(...filterParts.clauses);
  }

  return {
    whereSql: whereParts.join(" AND "),
    params,
    paramIndex
  };
}

async function searchApplications(pool, req, query = {}) {
  const filters = normalizeListParams(query);
  const { whereSql, params } = await buildScopedQueryParts(pool, req, filters);

  const fromSql = applicationSelectFromSql();
  const sortColumn = resolveSortColumn(filters.sortBy);

  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS total
     ${fromSql}
     WHERE ${whereSql}`,
    params
  );

  const total = countResult.rows[0]?.total || 0;

  const listParams = [...params, filters.pageSize, filters.offset];
  const limitParam = params.length + 1;
  const offsetParam = params.length + 2;

  const listResult = await pool.query(
    `SELECT
       m.mapping_id,
       m.map_id,
       m.candidate_id,
       m.requisition_code,
       m.stage_name,
       m.source_type,
       m.recruiter_id,
       m.applied_on,
       cm.candidate_code,
       cm.first_name,
       cm.last_name,
       cm.preferred_name,
       cm.email_id,
       cm.mobile_number,
       cm.owner_employee_code,
       COALESCE(r.position_title, '') AS position_title,
       owner_u.full_name AS owner_name,
       COALESCE(latest_iv.interview_status, 'Not Scheduled') AS interview_status,
       COALESCE(latest_offer.offer_status, 'Not Initiated') AS offer_status,
       COALESCE(latest_hist.changed_on, m.applied_on, cm.created_on) AS last_activity_sort,
       GREATEST(
         0,
         EXTRACT(
           EPOCH FROM (
             NOW() - COALESCE(latest_hist.changed_on, m.applied_on, cm.created_on)
           )
         ) / 86400.0
       )::int AS time_in_stage_days,
       LOWER(TRIM(COALESCE(cm.first_name, '') || ' ' || COALESCE(cm.last_name, ''))) AS candidate_sort,
       LOWER(COALESCE(owner_u.full_name, cm.owner_employee_code, m.recruiter_id, '')) AS owner_sort,
       LOWER(COALESCE(m.requisition_code, '')) AS requisition_sort,
       LOWER(COALESCE(latest_iv.interview_status, '')) AS interview_status_sort,
       LOWER(COALESCE(latest_offer.offer_status, '')) AS offer_status_sort
     ${fromSql}
     WHERE ${whereSql}
     ORDER BY ${sortColumn} ${filters.sortDir}, m.mapping_id DESC
     LIMIT $${limitParam} OFFSET $${offsetParam}`,
    listParams
  );

  return {
    items: listResult.rows.map(mapApplicationRow),
    page: filters.page,
    pageSize: filters.pageSize,
    total,
    totalPages: Math.max(Math.ceil(total / filters.pageSize), 1)
  };
}

async function getSummaryMetrics(pool, req) {
  const filters = normalizeListParams({});
  const { whereSql, params } = await buildScopedQueryParts(pool, req, filters);
  const fromSql = applicationSelectFromSql();

  const metricsResult = await pool.query(
    `SELECT
       COUNT(*)::int AS active_applications,
       COUNT(DISTINCT m.candidate_id)::int AS unique_candidates,
       COUNT(*) FILTER (
         WHERE TRIM(COALESCE(m.recruiter_id, '')) = ''
       )::int AS unassigned_applications,
       COUNT(*) FILTER (
         WHERE latest_iv.scheduled_on IS NOT NULL
           AND latest_iv.scheduled_on >= NOW()
           AND latest_iv.scheduled_on < NOW() + INTERVAL '7 days'
       )::int AS upcoming_interviews,
       COUNT(*) FILTER (
         WHERE COALESCE(latest_offer.offer_status, '') <> ''
           AND UPPER(latest_offer.offer_status) NOT IN (
             'DECLINED', 'WITHDRAWN', 'ACCEPTED', 'REJECTED'
           )
       )::int AS active_offers
     ${fromSql}
     WHERE ${whereSql}`,
    params
  );

  const row = metricsResult.rows[0] || {};

  return {
    unique_candidates: row.unique_candidates || 0,
    active_applications: row.active_applications || 0,
    unassigned_applications: row.unassigned_applications || 0,
    upcoming_interviews: row.upcoming_interviews || 0,
    active_offers: row.active_offers || 0
  };
}

async function getApplicationDetail(pool, req, mappingId) {
  const parsedId = parseInt(mappingId, 10);

  if (!Number.isFinite(parsedId)) {
    throw httpError("Invalid mapping identifier.", 400);
  }

  const mappingResult = await pool.query(
    `SELECT m.*, cm.candidate_id AS cm_id
     FROM rm_candidate_mappings m
     INNER JOIN cand_mstr cm ON cm.candidate_id = m.candidate_id
     WHERE m.mapping_id = $1 AND m.is_active = TRUE
     LIMIT 1`,
    [parsedId]
  );

  const mapping = mappingResult.rows[0];

  if (!mapping) {
    throw httpError("Application not found.", 404);
  }

  const list = await searchApplications(pool, req, {
    page: 1,
    pageSize: 1,
    mappingId: parsedId
  });

  const match = list.items[0];

  if (!match) {
    throw httpError("Enterprise Access Denied.", 403);
  }

  return match;
}

module.exports = {
  normalizeListParams,
  searchApplications,
  getSummaryMetrics,
  getApplicationDetail
};
