/**
 * Work Assignment Engine — database operations only.
 * Tables: work_assignment_mstr, employee_work_assignment
 */

const MASTER_COLUMNS = `
  work_assignment_id,
  assignment_code,
  assignment_name,
  business_module,
  description,
  category,
  workspace_route,
  workspace_icon,
  workspace_flag,
  display_order,
  system_defined,
  is_active,
  created_by,
  created_on,
  updated_by,
  updated_on
`;

const EMPLOYEE_COUNT_SELECT = `
  (
    SELECT COUNT(*)::int
    FROM employee_work_assignment ewa
    WHERE ewa.work_assignment_id = wa.work_assignment_id
      AND ewa.is_active = TRUE
  ) AS employees_assigned
`;

async function getAllWorkAssignments(pool) {
  const result = await pool.query(
    `SELECT
       ${MASTER_COLUMNS},
       ${EMPLOYEE_COUNT_SELECT}
     FROM work_assignment_mstr wa
     ORDER BY display_order ASC, assignment_code ASC`
  );

  return result.rows;
}

async function getActiveWorkAssignments(pool) {
  const result = await pool.query(
    `SELECT
       ${MASTER_COLUMNS},
       ${EMPLOYEE_COUNT_SELECT}
     FROM work_assignment_mstr wa
     WHERE is_active = TRUE
     ORDER BY display_order ASC, assignment_code ASC`
  );

  return result.rows;
}

async function getWorkAssignmentById(pool, id) {
  const result = await pool.query(
    `SELECT
       ${MASTER_COLUMNS},
       ${EMPLOYEE_COUNT_SELECT}
     FROM work_assignment_mstr wa
     WHERE work_assignment_id = $1`,
    [id]
  );

  return result.rows[0] || null;
}

async function createWorkAssignment(pool, data) {
  const result = await pool.query(
    `INSERT INTO work_assignment_mstr (
       assignment_code,
       assignment_name,
       business_module,
       description,
       category,
       workspace_route,
       workspace_icon,
       workspace_flag,
       display_order,
       system_defined,
       is_active,
       created_by,
       created_on,
       updated_by,
       updated_on
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), $12, NOW()
     )
     RETURNING *`,
    [
      data.assignment_code,
      data.assignment_name,
      data.business_module,
      data.description ?? null,
      data.category ?? null,
      data.workspace_route ?? null,
      data.workspace_icon ?? null,
      data.workspace_flag ?? null,
      data.display_order === undefined || data.display_order === null
        ? 0
        : Number(data.display_order),
      Boolean(data.system_defined),
      data.is_active === undefined ? true : Boolean(data.is_active),
      data.created_by ?? null
    ]
  );

  return result.rows[0];
}

/**
 * Update master. assignment_code is never updated (immutable business key).
 */
async function updateWorkAssignment(pool, id, data) {
  const result = await pool.query(
    `UPDATE work_assignment_mstr
     SET
       assignment_name = COALESCE($2, assignment_name),
       business_module = COALESCE($3, business_module),
       description = COALESCE($4, description),
       category = COALESCE($5, category),
       workspace_route = COALESCE($6, workspace_route),
       workspace_icon = COALESCE($7, workspace_icon),
       workspace_flag = COALESCE($8, workspace_flag),
       display_order = COALESCE($9, display_order),
       is_active = COALESCE($10, is_active),
       updated_by = COALESCE($11, updated_by),
       updated_on = NOW()
     WHERE work_assignment_id = $1
     RETURNING *`,
    [
      id,
      data.assignment_name ?? null,
      data.business_module ?? null,
      data.description ?? null,
      data.category ?? null,
      data.workspace_route ?? null,
      data.workspace_icon ?? null,
      data.workspace_flag ?? null,
      data.display_order === undefined || data.display_order === null
        ? null
        : Number(data.display_order),
      data.is_active === undefined ? null : Boolean(data.is_active),
      data.updated_by ?? null
    ]
  );

  return result.rows[0] || null;
}

async function setWorkAssignmentActive(pool, id, isActive, updatedBy) {
  const result = await pool.query(
    `UPDATE work_assignment_mstr
     SET
       is_active = $2,
       updated_by = COALESCE($3, updated_by),
       updated_on = NOW()
     WHERE work_assignment_id = $1
     RETURNING *`,
    [id, Boolean(isActive), updatedBy ?? null]
  );

  return result.rows[0] || null;
}

async function deleteWorkAssignment(pool, id) {
  const result = await pool.query(
    `DELETE FROM work_assignment_mstr
     WHERE work_assignment_id = $1
     RETURNING *`,
    [id]
  );

  return result.rows[0] || null;
}

async function countActiveEmployeesForAssignment(pool, workAssignmentId) {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS employees_assigned
     FROM employee_work_assignment
     WHERE work_assignment_id = $1
       AND is_active = TRUE`,
    [workAssignmentId]
  );

  return result.rows[0]?.employees_assigned ?? 0;
}

async function assignWorkAssignment(
  pool,
  employeeCode,
  workAssignmentId,
  effectiveFrom,
  effectiveTo
) {
  const result = await pool.query(
    `INSERT INTO employee_work_assignment (
       employee_code,
       work_assignment_id,
       effective_from,
       effective_to,
       is_active,
       created_on,
       updated_on
     ) VALUES ($1, $2, $3, $4, TRUE, NOW(), NOW())
     RETURNING *`,
    [
      employeeCode,
      workAssignmentId,
      effectiveFrom ?? null,
      effectiveTo ?? null
    ]
  );

  return result.rows[0];
}

async function getEmployeeWorkAssignments(pool, employeeCode) {
  const result = await pool.query(
    `SELECT
       ewa.employee_work_assignment_id,
       ewa.employee_code,
       ewa.work_assignment_id,
       ewa.effective_from,
       ewa.effective_to,
       ewa.is_active,
       ewa.created_by,
       ewa.created_on,
       ewa.updated_by,
       ewa.updated_on,
       wa.assignment_code,
       wa.assignment_name,
       wa.business_module,
       wa.category,
       wa.workspace_route,
       wa.workspace_icon,
       wa.workspace_flag,
       wa.display_order,
       wa.system_defined,
       wa.is_active AS master_is_active
     FROM employee_work_assignment ewa
     INNER JOIN work_assignment_mstr wa
       ON wa.work_assignment_id = ewa.work_assignment_id
     WHERE ewa.employee_code = $1
     ORDER BY wa.display_order ASC, wa.assignment_code ASC, ewa.effective_from`,
    [employeeCode]
  );

  return result.rows;
}

async function removeEmployeeWorkAssignment(pool, employeeWorkAssignmentId) {
  const result = await pool.query(
    `DELETE FROM employee_work_assignment
     WHERE employee_work_assignment_id = $1
     RETURNING *`,
    [employeeWorkAssignmentId]
  );

  return result.rows[0] || null;
}

module.exports = {
  getAllWorkAssignments,
  getActiveWorkAssignments,
  getWorkAssignmentById,
  createWorkAssignment,
  updateWorkAssignment,
  setWorkAssignmentActive,
  deleteWorkAssignment,
  countActiveEmployeesForAssignment,
  assignWorkAssignment,
  getEmployeeWorkAssignments,
  removeEmployeeWorkAssignment
};
