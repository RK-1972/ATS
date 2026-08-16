const recruitmentService = require("./recruitmentService");
const { buildLifecycleSnapshot } = require("./hiringControlTowerLifecycle");
const { buildExecutiveKpiSnapshot } = require("./hiringControlTowerKpis");
const { buildStageInspectorSnapshot } = require("./hiringControlTowerStageInspector");

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function pickText(...values) {
  for (const value of values) {
    if (value === null || value === undefined) {
      continue;
    }

    const text = String(value).trim();
    if (text) {
      return text;
    }
  }

  return null;
}

function mapRequisitionHeader(row) {
  if (!row) {
    return null;
  }

  return {
    requisition_code: pickText(row.requisition_code),
    position_title: pickText(row.position_title, row.approved_position_title),
    department: pickText(row.department, row.approved_department),
    grade: pickText(row.grade, row.approved_grade),
    req_status: pickText(row.req_status),
    hiring_manager: pickText(row.hiring_manager)
  };
}

function normalizeSearchParams(query = {}) {
  const q = String(query.q || "").trim();
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const pageSize = Math.min(Math.max(parseInt(query.pageSize, 10) || 20, 1), 100);

  return { q, page, pageSize, offset: (page - 1) * pageSize };
}

async function searchRequisitions(pool, query = {}) {
  const { q, page, pageSize, offset } = normalizeSearchParams(query);

  let whereClause = "";
  const params = [pageSize, offset];

  if (q) {
    whereClause = `WHERE (
         r.requisition_code ILIKE '%' || $3 || '%'
         OR COALESCE(r.position_title, p.position_title, '') ILIKE '%' || $3 || '%'
         OR COALESCE(r.department, p.department, '') ILIKE '%' || $3 || '%'
       )`;
    params.push(q);
  }

  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS total
     FROM rm_requisitions r
     LEFT JOIN wp_approved_positions p ON r.approved_position_id = p.position_id
     ${whereClause}`,
    q ? [q] : []
  );

  const result = await pool.query(
    `SELECT
       r.requisition_code,
       r.position_title,
       r.department,
       r.grade,
       r.req_status,
       r.hiring_manager,
       p.position_title AS approved_position_title,
       p.department AS approved_department,
       p.grade AS approved_grade
     FROM rm_requisitions r
     LEFT JOIN wp_approved_positions p ON r.approved_position_id = p.position_id
     ${whereClause}
     ORDER BY r.created_on DESC NULLS LAST, r.req_id DESC
     LIMIT $1 OFFSET $2`,
    params
  );

  const items = result.rows.map(mapRequisitionHeader);

  return {
    items,
    page,
    pageSize,
    total: countResult.rows[0]?.total || 0
  };
}

async function getRequisitionHeader(pool, code) {
  const requisitionCode = String(code || "").trim();

  if (!requisitionCode) {
    throw httpError("Requisition code is required.", 400);
  }

  const row = await recruitmentService.loadRequisitionByCode(pool, requisitionCode);

  if (!row) {
    throw httpError("Requisition not found.", 404);
  }

  return mapRequisitionHeader(row);
}

async function getRequisitionLifecycle(pool, code) {
  const requisitionCode = String(code || "").trim();

  if (!requisitionCode) {
    throw httpError("Requisition code is required.", 400);
  }

  const row = await recruitmentService.loadRequisitionByCode(pool, requisitionCode);

  if (!row) {
    throw httpError("Requisition not found.", 404);
  }

  return buildLifecycleSnapshot(pool, row);
}

async function getExecutiveKpis(pool) {
  return buildExecutiveKpiSnapshot(pool);
}

async function getStageInspector(pool, code, milestoneKey) {
  return buildStageInspectorSnapshot(pool, code, milestoneKey);
}

module.exports = {
  mapRequisitionHeader,
  searchRequisitions,
  getRequisitionHeader,
  getRequisitionLifecycle,
  getExecutiveKpis,
  getStageInspector
};
