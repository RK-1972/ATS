/**
 * Append-only Primary Role history for user_mstr.role_name.
 */

function normalizeHistoryRow(row) {
  return {
    history_id: row.history_id,
    employee_code: row.employee_code,
    previous_role_name: row.previous_role_name,
    new_role_name: row.new_role_name,
    effective_at: row.effective_at,
    changed_by_employee_code: row.changed_by_employee_code,
    changed_by_name: row.changed_by_name,
    reason: row.reason,
    created_on: row.created_on
  };
}

/**
 * Insert a role history row. Caller must run inside an open transaction when atomicity is required.
 *
 * @param {object} executor - pg Pool or Client
 * @param {object} payload
 * @returns {Promise<object>}
 */
async function insertRoleHistory(executor, payload = {}) {
  const employeeCode = String(payload.employee_code || "").trim();
  const newRoleName = String(payload.new_role_name || "").trim();
  const previousRoleName = payload.previous_role_name
    ? String(payload.previous_role_name).trim()
    : null;
  const changedByEmployeeCode = payload.changed_by_employee_code
    ? String(payload.changed_by_employee_code).trim()
    : null;
  const changedByName = payload.changed_by_name
    ? String(payload.changed_by_name).trim()
    : null;
  const reason = payload.reason ? String(payload.reason).trim() : null;

  const result = await executor.query(
    `INSERT INTO user_role_history (
       employee_code,
       previous_role_name,
       new_role_name,
       effective_at,
       changed_by_employee_code,
       changed_by_name,
       reason,
       created_on
     ) VALUES ($1, $2, $3, NOW(), $4, $5, $6, NOW())
     RETURNING
       history_id,
       employee_code,
       previous_role_name,
       new_role_name,
       effective_at,
       changed_by_employee_code,
       changed_by_name,
       reason,
       created_on`,
    [
      employeeCode,
      previousRoleName,
      newRoleName,
      changedByEmployeeCode,
      changedByName,
      reason
    ]
  );

  return normalizeHistoryRow(result.rows[0]);
}

/**
 * List role history for an employee, newest effective_at first.
 *
 * @param {object} pool
 * @param {string} employeeCode
 * @returns {Promise<object[]>}
 */
async function listRoleHistoryByEmployeeCode(pool, employeeCode) {
  const normalizedCode = String(employeeCode || "").trim();

  const result = await pool.query(
    `SELECT
       history_id,
       employee_code,
       previous_role_name,
       new_role_name,
       effective_at,
       changed_by_employee_code,
       changed_by_name,
       reason,
       created_on
     FROM user_role_history
     WHERE employee_code = $1
     ORDER BY effective_at DESC, history_id DESC`,
    [normalizedCode]
  );

  return result.rows.map(normalizeHistoryRow);
}

module.exports = {
  insertRoleHistory,
  listRoleHistoryByEmployeeCode
};
