const { writeEnterpriseAudit, userContext } = require("./enterpriseAuditService");

const LIFECYCLE_MODULE = "Employee Lifecycle";

async function recordLifecycleAudit(pool, req, payload) {
  const user = userContext(req);

  return writeEnterpriseAudit(pool, {
    eventType: payload.eventType || "EmployeeLifecycle",
    module: LIFECYCLE_MODULE,
    entity: payload.entity || "Employee",
    entityId: payload.entityId,
    action: payload.action,
    previousValue: payload.previousValue ?? null,
    newValue: payload.newValue ?? null,
    userName: user.name,
    userRole: user.role,
    metadata: {
      source_lifecycle_operation: payload.sourceOperation || null,
      responsibility_category: payload.responsibilityCategory || null,
      affected_employee_code: payload.affectedEmployeeCode || null,
      old_assignee_or_owner: payload.oldAssigneeOrOwner ?? null,
      new_assignee_or_owner: payload.newAssigneeOrOwner ?? null,
      reason: payload.reason ?? null,
      ...(payload.metadata || {})
    }
  });
}

module.exports = {
  recordLifecycleAudit
};
