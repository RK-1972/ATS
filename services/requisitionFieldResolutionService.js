/**
 * Server-side resolution for Talent Demand approved position and approval route.
 * Reuses list/eligibility rules from recruitmentService and policy resolver from budget submit.
 */

const approvalRouteResolverService = require("./approvalRouteResolverService");
const approvalRouteRepository = require("../repositories/approvalRouteRepository");

const REQUISITION_DOCUMENT_TYPE = "REQUISITION";

const ELIGIBLE_POSITIONS_SQL = `
  SELECT
    p.position_id,
    p.position_title,
    p.department,
    p.grade,
    p.headcount,
    p.status,
    p.remaining_budget,
    p.expiry_date,
    p.budget_approved
  FROM wp_approved_positions p
  WHERE LOWER(COALESCE(p.status, 'active')) = 'active'
    AND NOT EXISTS (
      SELECT 1
      FROM rm_requisitions r
      WHERE r.approved_position_id = p.position_id
    )
  ORDER BY p.position_title ASC, p.position_id ASC
`;

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function isBlank(value) {
  return value === null || value === undefined || String(value).trim() === "";
}

async function loadApprovedPosition(queryable, positionId) {
  const result = await queryable.query(
    "SELECT * FROM wp_approved_positions WHERE position_id = $1",
    [positionId]
  );
  return result.rows[0] || null;
}

async function listEligibleApprovedPositions(queryable) {
  const result = await queryable.query(ELIGIBLE_POSITIONS_SQL);
  return result.rows;
}

async function findRequisitionForPosition(queryable, positionId) {
  const result = await queryable.query(
    `SELECT requisition_code
     FROM rm_requisitions
     WHERE approved_position_id = $1
     ORDER BY created_on ASC
     LIMIT 1`,
    [positionId]
  );
  return result.rows[0] || null;
}

/**
 * Validate a caller-supplied approved position without replacing it when valid.
 * Preserves catalogue-linked requisitions (position already consumed by the same code).
 */
async function assertApprovedPositionSelectable(
  queryable,
  positionId,
  options = {}
) {
  const existingRequisitionCode = options.existingRequisitionCode || null;
  const position = await loadApprovedPosition(queryable, positionId);

  if (!position) {
    throw httpError(`Approved position not found: ${positionId}`, 404);
  }

  if (position.status === "Fully Utilized") {
    throw httpError("Approved position budget is fully utilized.", 400);
  }

  const linked = await findRequisitionForPosition(queryable, positionId);
  if (linked) {
    if (
      existingRequisitionCode &&
      String(linked.requisition_code) === String(existingRequisitionCode)
    ) {
      return position;
    }

    throw httpError(
      `A requisition already exists for approved position ${positionId}: ${linked.requisition_code}. One Approved Position creates exactly one Requisition.`,
      409
    );
  }

  return position;
}

/**
 * Resolve approved_position_id for draft submit.
 * - Uses requested id when provided and valid.
 * - Auto-selects only when exactly one eligible position exists.
 */
async function resolveApprovedPositionId(queryable, options = {}) {
  const requestedId = !isBlank(options.requestedApprovedPositionId)
    ? String(options.requestedApprovedPositionId).trim()
    : null;
  const existingRequisitionCode = options.existingRequisitionCode || null;

  if (requestedId) {
    return (
      await assertApprovedPositionSelectable(queryable, requestedId, {
        existingRequisitionCode
      })
    ).position_id;
  }

  const eligible = await listEligibleApprovedPositions(queryable);

  if (eligible.length === 0) {
    throw httpError(
      "No approved position is available for requisition creation. Raise and approve workforce budget demand, or use an approved position that does not yet have a requisition.",
      400
    );
  }

  if (eligible.length > 1) {
    throw httpError(
      "Multiple approved positions are available. Select an Approved Position before submitting.",
      400
    );
  }

  return eligible[0].position_id;
}

function buildRouteCriteriaFromPosition(position) {
  return {
    department: position.department || null,
    designation: position.position_title || null,
    grade: position.grade || null,
    amount:
      position.budget_approved != null && position.budget_approved !== ""
        ? Number(position.budget_approved)
        : null
  };
}

/**
 * Resolve requisition approval route via approval_route_policy (document type REQUISITION).
 */
async function resolveRequisitionApprovalRouteId(queryable, approvedPositionId) {
  const position = await loadApprovedPosition(queryable, approvedPositionId);

  if (!position) {
    throw httpError(`Approved position not found: ${approvedPositionId}`, 404);
  }

  const criteria = buildRouteCriteriaFromPosition(position);

  return approvalRouteResolverService.resolveApprovalRoute(
    queryable,
    REQUISITION_DOCUMENT_TYPE,
    criteria
  );
}

/**
 * Existing operational requisition submit (catalogue-complete path).
 * Preserves a stored approval_route_id — no policy re-resolution after create.
 * Resolves from policy only when the row has no route (typical catalogue create).
 */
async function resolveApprovalRouteIdForRequisitionSubmit(
  queryable,
  requisition
) {
  const storedRouteId = requisition?.approval_route_id;

  if (!isBlank(storedRouteId)) {
    return storedRouteId;
  }

  const approvedPositionId = requisition?.approved_position_id;

  if (isBlank(approvedPositionId)) {
    throw httpError(
      "approved_position_id is required to resolve an approval route.",
      400
    );
  }

  return resolveRequisitionApprovalRouteId(queryable, approvedPositionId);
}

async function describeApprovalRoute(queryable, routeId) {
  const route = await approvalRouteRepository.getApprovalRoute(queryable, routeId);
  return {
    approval_route_id: routeId,
    approval_route_name: route?.route_name || null
  };
}

/**
 * Resolve both fields for draft submit / preview.
 */
async function resolveTalentDemandFields(queryable, options = {}) {
  const approvedPositionId = await resolveApprovedPositionId(queryable, {
    requestedApprovedPositionId: options.requestedApprovedPositionId,
    existingRequisitionCode: options.existingRequisitionCode
  });

  const position =
    (await loadApprovedPosition(queryable, approvedPositionId)) || {};

  const approvalRouteId = await resolveRequisitionApprovalRouteId(
    queryable,
    approvedPositionId
  );

  const routeMeta = await describeApprovalRoute(queryable, approvalRouteId);

  const eligible = await listEligibleApprovedPositions(queryable);
  const positionSelectionRequired =
    eligible.length > 1 && isBlank(options.requestedApprovedPositionId);

  return {
    approved_position_id: approvedPositionId,
    approved_position_title: position.position_title || null,
    approved_position_department: position.department || null,
    approved_position_grade: position.grade || null,
    approval_route_id: approvalRouteId,
    approval_route_name: routeMeta.approval_route_name,
    position_selection_required: positionSelectionRequired,
    eligible_position_count: eligible.length
  };
}

/**
 * Read-only preview for Talent Demand UI (requestor-safe).
 */
async function buildTalentDemandFieldResolutionPreview(pool, query = {}) {
  const requestedId = !isBlank(query.approved_position_id)
    ? String(query.approved_position_id).trim()
    : null;
  const requisitionCode = !isBlank(query.requisition_code)
    ? String(query.requisition_code).trim()
    : null;

  let fixedPositionId = requestedId;

  if (requisitionCode) {
    const reqRow = await pool.query(
      `SELECT approved_position_id
       FROM rm_requisitions
       WHERE requisition_code = $1`,
      [requisitionCode]
    );
    const fromReq = reqRow.rows[0]?.approved_position_id;
    if (fromReq) {
      fixedPositionId = String(fromReq).trim();
    }
  }

  const eligible = await listEligibleApprovedPositions(pool);

  if (fixedPositionId) {
    await assertApprovedPositionSelectable(pool, fixedPositionId, {
      existingRequisitionCode: requisitionCode
    });

    const approvalRouteId = await resolveRequisitionApprovalRouteId(
      pool,
      fixedPositionId
    );
    const position = await loadApprovedPosition(pool, fixedPositionId);
    const routeMeta = await describeApprovalRoute(pool, approvalRouteId);

    return {
      approved_position_id: fixedPositionId,
      approved_position_title: position?.position_title || null,
      approved_position_department: position?.department || null,
      approved_position_grade: position?.grade || null,
      approval_route_id: approvalRouteId,
      approval_route_name: routeMeta.approval_route_name,
      position_selection_required: false,
      position_locked: Boolean(requisitionCode || fixedPositionId),
      eligible_position_count: eligible.length
    };
  }

  if (eligible.length === 1) {
    const autoId = eligible[0].position_id;
    const approvalRouteId = await resolveRequisitionApprovalRouteId(pool, autoId);
    const routeMeta = await describeApprovalRoute(pool, approvalRouteId);

    return {
      approved_position_id: autoId,
      approved_position_title: eligible[0].position_title,
      approved_position_department: eligible[0].department,
      approved_position_grade: eligible[0].grade,
      approval_route_id: approvalRouteId,
      approval_route_name: routeMeta.approval_route_name,
      position_selection_required: false,
      position_locked: false,
      eligible_position_count: 1
    };
  }

  if (eligible.length === 0) {
    return {
      approved_position_id: null,
      approval_route_id: null,
      approval_route_name: null,
      position_selection_required: false,
      position_locked: false,
      eligible_position_count: 0
    };
  }

  return {
    approved_position_id: null,
    approval_route_id: null,
    approval_route_name: null,
    position_selection_required: true,
    position_locked: false,
    eligible_position_count: eligible.length,
    eligible_positions: eligible.map((row) => ({
      position_id: row.position_id,
      position_title: row.position_title,
      department: row.department,
      grade: row.grade
    }))
  };
}

module.exports = {
  REQUISITION_DOCUMENT_TYPE,
  listEligibleApprovedPositions,
  assertApprovedPositionSelectable,
  resolveApprovedPositionId,
  resolveRequisitionApprovalRouteId,
  resolveApprovalRouteIdForRequisitionSubmit,
  resolveTalentDemandFields,
  buildTalentDemandFieldResolutionPreview,
  buildRouteCriteriaFromPosition
};
