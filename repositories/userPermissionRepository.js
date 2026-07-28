const ENTERPRISE_PERMISSION_CODES = Object.freeze([
  "RAISE_REQUISITION",
  "RAISE_BUDGET_REQUEST"
]);

function isValidPermissionCode(permissionCode) {
  return ENTERPRISE_PERMISSION_CODES.includes(
    String(permissionCode || "").trim().toUpperCase()
  );
}

/**
 * Returns true when the employee has the given permission enabled.
 */
async function hasPermission(pool, employeeCode, permissionCode) {
  const normalizedCode = String(permissionCode || "").trim().toUpperCase();

  if (!employeeCode || !isValidPermissionCode(normalizedCode)) {
    return false;
  }

  const result = await pool.query(
    `SELECT is_enabled
     FROM user_permission_map
     WHERE employee_code = $1
       AND permission_code = $2
     LIMIT 1`,
    [employeeCode, normalizedCode]
  );

  return Boolean(result.rows[0]?.is_enabled);
}

function normalizePermissionRow(row) {
  return {
    permission_code: row.permission_code,
    is_enabled: Boolean(row.is_enabled)
  };
}

/**
 * Load persisted permissions for an employee.
 */
async function getUserPermissions(pool, employeeCode) {
  const result = await pool.query(
    `SELECT permission_code, is_enabled
     FROM user_permission_map
     WHERE employee_code = $1
     ORDER BY permission_code`,
    [employeeCode]
  );

  return result.rows.map(normalizePermissionRow);
}

/**
 * UPSERT a single employee permission.
 */
async function saveUserPermission(
  executor,
  employeeCode,
  permissionCode,
  isEnabled,
  updatedBy
) {
  const normalizedCode = String(permissionCode || "").trim().toUpperCase();

  if (!isValidPermissionCode(normalizedCode)) {
    const error = new Error(`Invalid permission_code: ${permissionCode}`);
    error.status = 400;
    throw error;
  }

  const result = await executor.query(
    `INSERT INTO user_permission_map (
      employee_code,
      permission_code,
      is_enabled,
      updated_by,
      updated_on
    ) VALUES ($1, $2, $3, $4, NOW())
    ON CONFLICT (employee_code, permission_code)
    DO UPDATE SET
      is_enabled = EXCLUDED.is_enabled,
      updated_by = EXCLUDED.updated_by,
      updated_on = NOW()
    RETURNING permission_code, is_enabled`,
    [employeeCode, normalizedCode, Boolean(isEnabled), updatedBy || null]
  );

  return normalizePermissionRow(result.rows[0]);
}

/**
 * UPSERT multiple permissions for an employee in one transaction.
 */
async function saveUserPermissions(pool, employeeCode, permissions, updatedBy) {
  if (!Array.isArray(permissions) || permissions.length === 0) {
    const error = new Error("At least one permission is required.");
    error.status = 400;
    throw error;
  }

  const client = await pool.connect();
  const saved = [];

  try {
    await client.query("BEGIN");

    for (const permission of permissions) {
      const row = await saveUserPermission(
        client,
        employeeCode,
        permission.permission_code,
        permission.is_enabled,
        updatedBy
      );
      saved.push(row);
    }

    await client.query("COMMIT");
    return saved;
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

module.exports = {
  ENTERPRISE_PERMISSION_CODES,
  isValidPermissionCode,
  hasPermission,
  getUserPermissions,
  saveUserPermission,
  saveUserPermissions
};
