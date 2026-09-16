/**
 * Ensures authenticated employee accounts are active in user_mstr.
 * Complements JWT verification — blocks deactivated users from protected APIs.
 */

async function assertEmployeeAccountActive(pool, user = {}) {
  const userId = user.user_id;
  const employeeCode = user.employee_code
    ? String(user.employee_code).trim()
    : "";

  let result;

  if (userId) {
    result = await pool.query(
      `SELECT COALESCE(is_active, TRUE) AS is_active
       FROM user_mstr
       WHERE user_id = $1
       LIMIT 1`,
      [userId]
    );
  } else if (employeeCode) {
    result = await pool.query(
      `SELECT COALESCE(is_active, TRUE) AS is_active
       FROM user_mstr
       WHERE employee_code = $1
       LIMIT 1`,
      [employeeCode]
    );
  } else {
    return false;
  }

  if (!result.rows[0]) {
    return false;
  }

  return result.rows[0].is_active === true;
}

function createRequireActiveEmployee(pool) {
  return async function requireActiveEmployee(req, res, next) {
    try {
      const isActive = await assertEmployeeAccountActive(pool, req.user || {});

      if (!isActive) {
        return res.status(403).json({
          success: false,
          message:
            "Account is inactive. Contact your administrator or sign in again after reactivation."
        });
      }

      return next();
    } catch (error) {
      console.error("Active employee check failed:", error.message);
      return res.status(500).json({
        success: false,
        message: "Internal server error"
      });
    }
  };
}

module.exports = {
  assertEmployeeAccountActive,
  createRequireActiveEmployee
};
