/**
 * Canonical TA Lead operator for verification fixtures.
 * Product treats both `TA Lead` and `TA Leader` as TA Lead workspace operators
 * (see requisitionCapabilityAuth.TA_LEAD_ROLES). Prefer `TA Lead` when both exist.
 */
async function resolveTaLeadOperatorUser(pool, options = {}) {
  const { requireNonPanelMember = false } = options;

  const panelFilter = requireNonPanelMember
    ? `AND NOT EXISTS (
         SELECT 1
         FROM interview_panel_mstr ipm
         WHERE ipm.is_active = true
           AND (
             ipm.employee_code = user_mstr.employee_code
             OR ipm.user_id = user_mstr.user_id
           )
       )`
    : "";

  const result = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name, secondary_role
     FROM user_mstr
     WHERE role_name IN ('TA Lead', 'TA Leader')
       AND COALESCE(is_active, TRUE) = TRUE
       ${panelFilter}
     ORDER BY CASE role_name WHEN 'TA Lead' THEN 0 ELSE 1 END, user_id ASC
     LIMIT 1`
  );
  return result.rows[0] || null;
}

module.exports = {
  resolveTaLeadOperatorUser
};
