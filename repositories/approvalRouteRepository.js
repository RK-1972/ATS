/**
 * Approval Route Management — database operations only.
 * Tables: approval_route_mstr, approval_route_step, approval_route_policy
 */

function normalizeOptionalText(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const text = String(value).trim();
  return text ? text : null;
}

function normalizeOptionalAmount(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const amount = Number(value);
  if (!Number.isFinite(amount)) {
    const error = new Error("Amount must be a valid number.");
    error.status = 400;
    throw error;
  }

  return amount;
}

function mapPolicyRow(row) {
  if (!row) {
    return null;
  }

  return {
    policy_id: row.policy_id,
    route_id: row.route_id,
    route_name: row.route_name ?? null,
    route_status: row.route_status ?? null,
    route_applies_to: row.route_applies_to ?? null,
    department: row.department,
    designation: row.designation,
    grade: row.grade,
    min_amount: row.min_amount !== null && row.min_amount !== undefined
      ? Number(row.min_amount)
      : null,
    max_amount: row.max_amount !== null && row.max_amount !== undefined
      ? Number(row.max_amount)
      : null,
    is_active: Boolean(row.is_active),
    effective_from: row.effective_from,
    effective_to: row.effective_to,
    created_by: row.created_by,
    created_on: row.created_on,
    updated_by: row.updated_by,
    updated_on: row.updated_on
  };
}

async function getApprovalRoutes(pool, appliesTo = null) {
  const result = await pool.query(
    `SELECT
       route_id,
       route_name,
       description,
       applies_to,
       status,
       effective_from,
       max_approval_days,
       created_by,
       created_on,
       updated_by,
       updated_on
     FROM approval_route_mstr
     WHERE (
       $1::text IS NULL
       OR LOWER(TRIM(applies_to)) = LOWER(TRIM($1))
       OR UPPER(REGEXP_REPLACE(TRIM(applies_to), '[^A-Za-z0-9]+', '_', 'g'))
          = UPPER(REGEXP_REPLACE(TRIM($1), '[^A-Za-z0-9]+', '_', 'g'))
       OR UPPER(SPLIT_PART(REGEXP_REPLACE(TRIM(applies_to), '[^A-Za-z0-9]+', '_', 'g'), '_', 1))
          = UPPER(SPLIT_PART(REGEXP_REPLACE(TRIM($1), '[^A-Za-z0-9]+', '_', 'g'), '_', 1))
     )
     ORDER BY route_name`,
    [appliesTo ? String(appliesTo).trim() : null]
  );

  return result.rows;
}

async function getApprovalRoute(pool, routeId) {
  const result = await pool.query(
    `SELECT
       route_id,
       route_name,
       description,
       applies_to,
       status,
       effective_from,
       max_approval_days,
       created_by,
       created_on,
       updated_by,
       updated_on
     FROM approval_route_mstr
     WHERE route_id = $1`,
    [routeId]
  );

  return result.rows[0] || null;
}

async function getApprovalRouteSteps(pool, routeId) {
  const result = await pool.query(
    `SELECT
       step_id,
       route_id,
       step_no,
       approver_employee_code,
       approval_type,
       comments_required,
       allow_reject,
       allow_return,
       stop_if_rejected,
       sequence_no
     FROM approval_route_step
     WHERE route_id = $1
     ORDER BY sequence_no`,
    [routeId]
  );

  return result.rows;
}

/**
 * Match active, effective routes by document type (mstr.applies_to) + policy criteria.
 * NULL policy criteria columns are wildcards.
 * documentType matches applies_to exactly (case-insensitive) or by canonical token
 * (non-alphanumerics → underscore; first token also accepted,
 * e.g. REQUISITION ↔ Requisition, BUDGET ↔ Budget Approval).
 */
async function findMatchingActiveRoutes(pool, documentType, criteria = {}) {
  const result = await pool.query(
    `SELECT DISTINCT
       r.route_id,
       r.route_name
     FROM approval_route_policy p
     INNER JOIN approval_route_mstr r
       ON r.route_id = p.route_id
     WHERE p.is_active = TRUE
       AND LOWER(TRIM(r.status)) = 'active'
       AND (
         LOWER(TRIM(r.applies_to)) = LOWER(TRIM($1))
         OR UPPER(REGEXP_REPLACE(TRIM(r.applies_to), '[^A-Za-z0-9]+', '_', 'g'))
            = UPPER(REGEXP_REPLACE(TRIM($1), '[^A-Za-z0-9]+', '_', 'g'))
         OR UPPER(SPLIT_PART(REGEXP_REPLACE(TRIM(r.applies_to), '[^A-Za-z0-9]+', '_', 'g'), '_', 1))
            = UPPER(SPLIT_PART(REGEXP_REPLACE(TRIM($1), '[^A-Za-z0-9]+', '_', 'g'), '_', 1))
       )
       AND (r.effective_from IS NULL OR r.effective_from <= CURRENT_DATE)
       AND p.effective_from <= CURRENT_DATE
       AND (p.effective_to IS NULL OR p.effective_to >= CURRENT_DATE)
       AND (
         p.department IS NULL
         OR (
           $2::text IS NOT NULL
           AND LOWER(TRIM(p.department)) = LOWER(TRIM($2))
         )
       )
       AND (
         p.designation IS NULL
         OR (
           $3::text IS NOT NULL
           AND LOWER(TRIM(p.designation)) = LOWER(TRIM($3))
         )
       )
       AND (
         p.grade IS NULL
         OR (
           $4::text IS NOT NULL
           AND LOWER(TRIM(p.grade)) = LOWER(TRIM($4))
         )
       )
       AND (
         (
           $5::numeric IS NULL
           AND p.min_amount IS NULL
           AND p.max_amount IS NULL
         )
         OR (
           $5::numeric IS NOT NULL
           AND (p.min_amount IS NULL OR $5::numeric >= p.min_amount)
           AND (p.max_amount IS NULL OR $5::numeric <= p.max_amount)
         )
       )
     ORDER BY r.route_id`,
    [
      documentType,
      criteria.department ?? null,
      criteria.designation ?? null,
      criteria.grade ?? null,
      criteria.amount ?? null
    ]
  );

  return result.rows;
}

/**
 * Same matching rules as findMatchingActiveRoutes, but returns policy rows
 * (for audit snapshot). Does not alter route resolution behaviour.
 */
async function findMatchingActivePolicies(pool, documentType, criteria = {}) {
  const result = await pool.query(
    `SELECT
       p.policy_id,
       p.route_id,
       r.route_name,
       r.applies_to AS route_applies_to,
       p.department,
       p.designation,
       p.grade,
       p.min_amount,
       p.max_amount,
       p.is_active,
       p.effective_from,
       p.effective_to
     FROM approval_route_policy p
     INNER JOIN approval_route_mstr r
       ON r.route_id = p.route_id
     WHERE p.is_active = TRUE
       AND LOWER(TRIM(r.status)) = 'active'
       AND (
         LOWER(TRIM(r.applies_to)) = LOWER(TRIM($1))
         OR UPPER(REGEXP_REPLACE(TRIM(r.applies_to), '[^A-Za-z0-9]+', '_', 'g'))
            = UPPER(REGEXP_REPLACE(TRIM($1), '[^A-Za-z0-9]+', '_', 'g'))
         OR UPPER(SPLIT_PART(REGEXP_REPLACE(TRIM(r.applies_to), '[^A-Za-z0-9]+', '_', 'g'), '_', 1))
            = UPPER(SPLIT_PART(REGEXP_REPLACE(TRIM($1), '[^A-Za-z0-9]+', '_', 'g'), '_', 1))
       )
       AND (r.effective_from IS NULL OR r.effective_from <= CURRENT_DATE)
       AND p.effective_from <= CURRENT_DATE
       AND (p.effective_to IS NULL OR p.effective_to >= CURRENT_DATE)
       AND (
         p.department IS NULL
         OR (
           $2::text IS NOT NULL
           AND LOWER(TRIM(p.department)) = LOWER(TRIM($2))
         )
       )
       AND (
         p.designation IS NULL
         OR (
           $3::text IS NOT NULL
           AND LOWER(TRIM(p.designation)) = LOWER(TRIM($3))
         )
       )
       AND (
         p.grade IS NULL
         OR (
           $4::text IS NOT NULL
           AND LOWER(TRIM(p.grade)) = LOWER(TRIM($4))
         )
       )
       AND (
         (
           $5::numeric IS NULL
           AND p.min_amount IS NULL
           AND p.max_amount IS NULL
         )
         OR (
           $5::numeric IS NOT NULL
           AND (p.min_amount IS NULL OR $5::numeric >= p.min_amount)
           AND (p.max_amount IS NULL OR $5::numeric <= p.max_amount)
         )
       )
     ORDER BY p.policy_id`,
    [
      documentType,
      criteria.department ?? null,
      criteria.designation ?? null,
      criteria.grade ?? null,
      criteria.amount ?? null
    ]
  );

  return result.rows;
}

async function createApprovalRoute(pool, routeData) {
  const result = await pool.query(
    `INSERT INTO approval_route_mstr (
       route_name,
       description,
       applies_to,
       status,
       effective_from,
       max_approval_days,
       created_by,
       created_on,
       updated_by,
       updated_on
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $7, NOW())
     RETURNING route_id`,
    [
      routeData.route_name,
      routeData.description ?? null,
      routeData.applies_to ?? "Requisition",
      routeData.status ?? "Draft",
      routeData.effective_from ?? null,
      routeData.max_approval_days ?? 3,
      routeData.created_by ?? null
    ]
  );

  return result.rows[0].route_id;
}

async function updateApprovalRoute(pool, routeId, routeData) {
  const result = await pool.query(
    `UPDATE approval_route_mstr
     SET
       route_name = COALESCE($2, route_name),
       description = COALESCE($3, description),
       applies_to = COALESCE($4, applies_to),
       status = COALESCE($5, status),
       effective_from = COALESCE($6, effective_from),
       max_approval_days = COALESCE($7, max_approval_days),
       updated_by = COALESCE($8, updated_by),
       updated_on = NOW()
     WHERE route_id = $1
     RETURNING *`,
    [
      routeId,
      routeData.route_name ?? null,
      routeData.description ?? null,
      routeData.applies_to ?? null,
      routeData.status ?? null,
      routeData.effective_from ?? null,
      routeData.max_approval_days ?? null,
      routeData.updated_by ?? null
    ]
  );

  return result.rows[0] || null;
}

async function replaceApprovalRouteSteps(pool, routeId, steps) {
  const client = await pool.connect();
  const orderedSteps = Array.isArray(steps)
    ? [...steps].sort(
        (a, b) => Number(a.sequence_no || 0) - Number(b.sequence_no || 0)
      )
    : [];

  try {
    await client.query("BEGIN");

    await client.query(
      `DELETE FROM approval_route_step
       WHERE route_id = $1`,
      [routeId]
    );

    const inserted = [];

    for (const step of orderedSteps) {
      const result = await client.query(
        `INSERT INTO approval_route_step (
           route_id,
           step_no,
           approver_employee_code,
           approval_type,
           comments_required,
           allow_reject,
           allow_return,
           stop_if_rejected,
           sequence_no
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [
          routeId,
          step.step_no,
          step.approver_employee_code ?? null,
          step.approval_type ?? "Approval Required",
          Boolean(step.comments_required),
          step.allow_reject === undefined ? true : Boolean(step.allow_reject),
          step.allow_return === undefined ? true : Boolean(step.allow_return),
          step.stop_if_rejected === undefined
            ? true
            : Boolean(step.stop_if_rejected),
          step.sequence_no
        ]
      );
      inserted.push(result.rows[0]);
    }

    await client.query("COMMIT");
    return inserted;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (_rollbackError) {
      // ignore rollback failures
    }
    throw error;
  } finally {
    client.release();
  }
}

async function getApprovalRoutePolicies(pool) {
  const result = await pool.query(
    `SELECT
       p.policy_id,
       p.route_id,
       r.route_name,
       r.status AS route_status,
       r.applies_to AS route_applies_to,
       p.department,
       p.designation,
       p.grade,
       p.min_amount,
       p.max_amount,
       p.is_active,
       p.effective_from,
       p.effective_to,
       p.created_by,
       p.created_on,
       p.updated_by,
       p.updated_on
     FROM approval_route_policy p
     INNER JOIN approval_route_mstr r
       ON r.route_id = p.route_id
     ORDER BY p.policy_id DESC`
  );

  return result.rows.map(mapPolicyRow);
}

async function getApprovalRoutePolicy(pool, policyId) {
  const result = await pool.query(
    `SELECT
       p.policy_id,
       p.route_id,
       r.route_name,
       r.status AS route_status,
       r.applies_to AS route_applies_to,
       p.department,
       p.designation,
       p.grade,
       p.min_amount,
       p.max_amount,
       p.is_active,
       p.effective_from,
       p.effective_to,
       p.created_by,
       p.created_on,
       p.updated_by,
       p.updated_on
     FROM approval_route_policy p
     INNER JOIN approval_route_mstr r
       ON r.route_id = p.route_id
     WHERE p.policy_id = $1`,
    [policyId]
  );

  return mapPolicyRow(result.rows[0] || null);
}

function buildPolicyWriteValues(policyData, actor) {
  const minAmount = normalizeOptionalAmount(policyData.min_amount);
  const maxAmount = normalizeOptionalAmount(policyData.max_amount);

  if (
    minAmount !== null
    && maxAmount !== null
    && maxAmount < minAmount
  ) {
    const error = new Error(
      "max_amount must be greater than or equal to min_amount."
    );
    error.status = 400;
    throw error;
  }

  const effectiveFrom =
    policyData.effective_from
      ? String(policyData.effective_from).slice(0, 10)
      : new Date().toISOString().slice(0, 10);
  const effectiveTo = policyData.effective_to
    ? String(policyData.effective_to).slice(0, 10)
    : null;

  if (effectiveTo && effectiveTo < effectiveFrom) {
    const error = new Error(
      "effective_to must be on or after effective_from."
    );
    error.status = 400;
    throw error;
  }

  return {
    route_id: policyData.route_id,
    department: normalizeOptionalText(policyData.department),
    designation: normalizeOptionalText(policyData.designation),
    grade: normalizeOptionalText(policyData.grade),
    min_amount: minAmount,
    max_amount: maxAmount,
    is_active:
      policyData.is_active === undefined
        ? true
        : Boolean(policyData.is_active),
    effective_from: effectiveFrom,
    effective_to: effectiveTo,
    actor: actor || null
  };
}

async function createApprovalRoutePolicy(pool, policyData) {
  if (
    policyData.route_id === null
    || policyData.route_id === undefined
    || String(policyData.route_id).trim() === ""
  ) {
    const error = new Error("route_id is required.");
    error.status = 400;
    throw error;
  }

  const route = await getApprovalRoute(pool, policyData.route_id);
  if (!route) {
    const error = new Error("Approval route not found.");
    error.status = 404;
    throw error;
  }

  const values = buildPolicyWriteValues(policyData, policyData.created_by);

  const result = await pool.query(
    `INSERT INTO approval_route_policy (
       route_id,
       department,
       designation,
       grade,
       min_amount,
       max_amount,
       is_active,
       effective_from,
       effective_to,
       created_by,
       created_on,
       updated_by,
       updated_on
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), $10, NOW())
     RETURNING policy_id`,
    [
      values.route_id,
      values.department,
      values.designation,
      values.grade,
      values.min_amount,
      values.max_amount,
      values.is_active,
      values.effective_from,
      values.effective_to,
      values.actor
    ]
  );

  return getApprovalRoutePolicy(pool, result.rows[0].policy_id);
}

async function updateApprovalRoutePolicy(pool, policyId, policyData) {
  const existing = await getApprovalRoutePolicy(pool, policyId);
  if (!existing) {
    return null;
  }

  const nextRouteId =
    policyData.route_id !== undefined && policyData.route_id !== null
      ? policyData.route_id
      : existing.route_id;

  const route = await getApprovalRoute(pool, nextRouteId);
  if (!route) {
    const error = new Error("Approval route not found.");
    error.status = 404;
    throw error;
  }

  const merged = {
    route_id: nextRouteId,
    department:
      policyData.department !== undefined
        ? policyData.department
        : existing.department,
    designation:
      policyData.designation !== undefined
        ? policyData.designation
        : existing.designation,
    grade:
      policyData.grade !== undefined ? policyData.grade : existing.grade,
    min_amount:
      policyData.min_amount !== undefined
        ? policyData.min_amount
        : existing.min_amount,
    max_amount:
      policyData.max_amount !== undefined
        ? policyData.max_amount
        : existing.max_amount,
    is_active:
      policyData.is_active !== undefined
        ? policyData.is_active
        : existing.is_active,
    effective_from:
      policyData.effective_from !== undefined
        ? policyData.effective_from
        : existing.effective_from,
    effective_to:
      policyData.effective_to !== undefined
        ? policyData.effective_to
        : existing.effective_to,
    created_by: policyData.updated_by
  };

  const values = buildPolicyWriteValues(merged, policyData.updated_by);

  await pool.query(
    `UPDATE approval_route_policy
     SET
       route_id = $2,
       department = $3,
       designation = $4,
       grade = $5,
       min_amount = $6,
       max_amount = $7,
       is_active = $8,
       effective_from = $9,
       effective_to = $10,
       updated_by = $11,
       updated_on = NOW()
     WHERE policy_id = $1`,
    [
      policyId,
      values.route_id,
      values.department,
      values.designation,
      values.grade,
      values.min_amount,
      values.max_amount,
      values.is_active,
      values.effective_from,
      values.effective_to,
      values.actor
    ]
  );

  return getApprovalRoutePolicy(pool, policyId);
}

async function setApprovalRoutePolicyActive(pool, policyId, isActive, updatedBy) {
  const existing = await getApprovalRoutePolicy(pool, policyId);
  if (!existing) {
    return null;
  }

  await pool.query(
    `UPDATE approval_route_policy
     SET
       is_active = $2,
       updated_by = $3,
       updated_on = NOW()
     WHERE policy_id = $1`,
    [policyId, Boolean(isActive), updatedBy || null]
  );

  return getApprovalRoutePolicy(pool, policyId);
}

module.exports = {
  getApprovalRoutes,
  getApprovalRoute,
  getApprovalRouteSteps,
  findMatchingActiveRoutes,
  findMatchingActivePolicies,
  createApprovalRoute,
  updateApprovalRoute,
  replaceApprovalRouteSteps,
  getApprovalRoutePolicies,
  getApprovalRoutePolicy,
  createApprovalRoutePolicy,
  updateApprovalRoutePolicy,
  setApprovalRoutePolicyActive
};
