function normalizePagination(query = {}) {
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 50, 1), 200);
  const offset = (page - 1) * limit;

  return { page, limit, offset };
}

function normalizeMetadata(value) {
  if (!value) {
    return {};
  }

  if (typeof value === "object") {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function mapAuditRow(row) {
  const createdOn = row.created_on;

  return {
    id: row.audit_id,
    timestamp: createdOn instanceof Date ? createdOn.toISOString() : createdOn,
    user: row.user_name,
    role: row.user_role,
    userId: null,
    module: row.module,
    entity: row.entity,
    entityId: row.entity_id,
    action: row.action,
    eventType: row.event_type,
    previousValue: row.previous_value,
    newValue: row.new_value,
    correlationId: row.correlation_id,
    metadata: normalizeMetadata(row.metadata)
  };
}

function buildFilters(query = {}) {
  const conditions = [];
  const values = [];

  if (query.module) {
    values.push(query.module);
    conditions.push(`module = $${values.length}`);
  }

  if (query.entity) {
    values.push(query.entity);
    conditions.push(`entity = $${values.length}`);
  }

  const entityId = query.entityId || query.entity_id;
  if (entityId) {
    values.push(entityId);
    conditions.push(`entity_id = $${values.length}`);
  }

  const eventType = query.eventType || query.event_type;
  if (eventType) {
    values.push(eventType);
    conditions.push(`event_type = $${values.length}`);
  }

  const correlationId = query.correlationId || query.correlation_id;
  if (correlationId) {
    values.push(correlationId);
    conditions.push(`correlation_id = $${values.length}`);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  return { whereClause, values };
}

async function listAudits(pool, query = {}) {
  const { page, limit, offset } = normalizePagination(query);
  const { whereClause, values } = buildFilters(query);

  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS total_count
     FROM md_enterprise_audit
     ${whereClause}`,
    values
  );

  const totalCount = countResult.rows[0]?.total_count || 0;
  const limitParam = values.length + 1;
  const offsetParam = values.length + 2;

  const result = await pool.query(
    `SELECT audit_id, event_type, module, entity, entity_id, action,
            previous_value, new_value, user_name, user_role,
            correlation_id, metadata, created_on
     FROM md_enterprise_audit
     ${whereClause}
     ORDER BY created_on DESC
     LIMIT $${limitParam} OFFSET $${offsetParam}`,
    [...values, limit, offset]
  );

  return {
    items: result.rows.map(mapAuditRow),
    pagination: {
      page,
      limit,
      total_count: totalCount
    }
  };
}

module.exports = {
  listAudits,
  mapAuditRow
};
