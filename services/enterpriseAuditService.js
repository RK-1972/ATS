const crypto = require("crypto");

function buildAuditId() {
  return `audit-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
}

function enrichMetadata(payload = {}) {
  const metadata = { ...(payload.metadata || {}) };

  if (payload.employeeCode && !metadata.employee_code) {
    metadata.employee_code = String(payload.employeeCode).trim();
  }

  if (payload.outcome && !metadata.outcome) {
    metadata.outcome = String(payload.outcome).trim().toLowerCase();
  }

  return metadata;
}

async function writeEnterpriseAudit(pool, payload) {
  const auditId = buildAuditId();
  const metadata = enrichMetadata(payload);

  await pool.query(
    `INSERT INTO md_enterprise_audit (
      audit_id, event_type, module, entity, entity_id,
      action, previous_value, new_value, user_name, user_role,
      correlation_id, metadata
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      auditId,
      payload.eventType,
      payload.module,
      payload.entity,
      payload.entityId,
      payload.action,
      payload.previousValue ?? null,
      payload.newValue ?? null,
      payload.userName,
      payload.userRole,
      payload.correlationId || null,
      JSON.stringify(metadata)
    ]
  );

  return auditId;
}

function userContext(req) {
  return {
    name: req.user?.full_name || req.user?.email_id || "System User",
    role: req.user?.role_name || "Admin",
    id: req.user?.user_id || null,
    employeeCode: req.user?.employee_code
      ? String(req.user.employee_code).trim()
      : null
  };
}

module.exports = {
  writeEnterpriseAudit,
  userContext,
  buildAuditId
};
