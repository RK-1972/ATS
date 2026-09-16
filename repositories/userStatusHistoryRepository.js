/**
 * Append-only account status history for user_mstr.is_active.
 */

const STATUS_ACTIVE = "Active";
const STATUS_INACTIVE = "Inactive";

function normalizeStatus(value) {
  const normalized = String(value || "").trim();
  if (normalized === STATUS_ACTIVE || normalized === STATUS_INACTIVE) {
    return normalized;
  }
  return null;
}

function statusFromBoolean(isActive) {
  return isActive === true ? STATUS_ACTIVE : STATUS_INACTIVE;
}

function normalizeHistoryRow(row) {
  return {
    history_id: row.history_id,
    employee_code: row.employee_code,
    previous_status: row.previous_status,
    new_status: row.new_status,
    effective_at: row.effective_at,
    changed_by_employee_code: row.changed_by_employee_code,
    changed_by_name: row.changed_by_name,
    reason: row.reason,
    created_on: row.created_on
  };
}

async function insertStatusHistory(executor, payload = {}) {
  const employeeCode = String(payload.employee_code || "").trim();
  const newStatus = normalizeStatus(payload.new_status);
  const previousStatus = payload.previous_status
    ? normalizeStatus(payload.previous_status)
    : null;
  const changedByEmployeeCode = payload.changed_by_employee_code
    ? String(payload.changed_by_employee_code).trim()
    : null;
  const changedByName = payload.changed_by_name
    ? String(payload.changed_by_name).trim()
    : null;
  const reason = payload.reason ? String(payload.reason).trim() : null;

  if (!employeeCode || !newStatus) {
    throw new Error("employee_code and new_status are required for status history.");
  }

  const result = await executor.query(
    `INSERT INTO user_status_history (
       employee_code,
       previous_status,
       new_status,
       effective_at,
       changed_by_employee_code,
       changed_by_name,
       reason,
       created_on
     ) VALUES ($1, $2, $3, NOW(), $4, $5, $6, NOW())
     RETURNING
       history_id,
       employee_code,
       previous_status,
       new_status,
       effective_at,
       changed_by_employee_code,
       changed_by_name,
       reason,
       created_on`,
    [
      employeeCode,
      previousStatus,
      newStatus,
      changedByEmployeeCode,
      changedByName,
      reason
    ]
  );

  return normalizeHistoryRow(result.rows[0]);
}

async function listStatusHistoryByEmployeeCode(pool, employeeCode) {
  const normalizedCode = String(employeeCode || "").trim();

  const result = await pool.query(
    `SELECT
       history_id,
       employee_code,
       previous_status,
       new_status,
       effective_at,
       changed_by_employee_code,
       changed_by_name,
       reason,
       created_on
     FROM user_status_history
     WHERE employee_code = $1
     ORDER BY effective_at DESC, history_id DESC`,
    [normalizedCode]
  );

  return result.rows.map(normalizeHistoryRow);
}

module.exports = {
  STATUS_ACTIVE,
  STATUS_INACTIVE,
  statusFromBoolean,
  insertStatusHistory,
  listStatusHistoryByEmployeeCode
};
