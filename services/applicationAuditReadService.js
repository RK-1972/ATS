const enterpriseAuditReadService = require("./enterpriseAuditReadService");
const {
  mapSessionRow,
  refreshStaleSessionStates
} = require("./applicationSessionService");
const { mapScreenRow } = require("./applicationScreenActivityService");

const DEFAULT_HISTORY_WINDOW_DAYS = 15;

function defaultHistoryFromIso() {
  const from = new Date();
  from.setUTCDate(from.getUTCDate() - DEFAULT_HISTORY_WINDOW_DAYS);
  from.setUTCHours(0, 0, 0, 0);
  return from.toISOString();
}

function resolveHistoryFrom(query = {}) {
  const explicit = parseDateBoundary(query.from || query.date_from);
  if (explicit) {
    return explicit;
  }

  return defaultHistoryFromIso();
}

function normalizePagination(query = {}) {
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 50, 1), 200);
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

function parseDateBoundary(value, { endOfDay = false } = {}) {
  if (!value) {
    return null;
  }

  const raw = String(value).trim();
  if (!raw) {
    return null;
  }

  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw) && endOfDay) {
    date.setUTCHours(23, 59, 59, 999);
  }

  return date.toISOString();
}

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function resolveSmartSearchTerm(query = {}) {
  const raw =
    query.search ??
    query.q ??
    query.employee ??
    query.employee_code ??
    query.employeeCode ??
    query.user;

  const term = String(raw || "").trim();
  return term || null;
}

function pushSearchPattern(values, term) {
  values.push(`%${term}%`);
  return values.length;
}

async function listSessions(pool, query = {}) {
  await refreshStaleSessionStates(pool);

  const { page, limit, offset } = normalizePagination(query);
  const conditions = [];
  const values = [];

  const searchTerm = resolveSmartSearchTerm(query);
  if (searchTerm) {
    const idx = pushSearchPattern(values, searchTerm);
    conditions.push(
      `(
        s.employee_code ILIKE $${idx}
        OR s.email_id ILIKE $${idx}
        OR COALESCE(u.full_name, '') ILIKE $${idx}
        OR s.session_id::text ILIKE $${idx}
        OR s.status ILIKE $${idx}
        OR COALESCE(s.source_ip, '') ILIKE $${idx}
      )`
    );
  }

  const status = query.status;
  if (status) {
    values.push(String(status).trim().toUpperCase());
    conditions.push(`s.status = $${values.length}`);
  }

  const from = resolveHistoryFrom(query);
  values.push(from);
  conditions.push(`s.login_at >= $${values.length}`);

  const to = parseDateBoundary(query.to || query.date_to, { endOfDay: true });
  if (to) {
    values.push(to);
    conditions.push(`s.login_at <= $${values.length}`);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS total_count
     FROM app_user_session s
     LEFT JOIN user_mstr u ON u.employee_code = s.employee_code
     ${whereClause}`,
    values
  );

  const limitParam = values.length + 1;
  const offsetParam = values.length + 2;

  const result = await pool.query(
    `SELECT s.session_id, s.employee_code, s.user_id, s.email_id, s.login_at, s.logout_at,
            s.last_seen_at, s.source_ip, s.user_agent_summary, s.status, s.termination_reason,
            u.full_name
     FROM app_user_session s
     LEFT JOIN user_mstr u ON u.employee_code = s.employee_code
     ${whereClause}
     ORDER BY s.login_at DESC
     LIMIT $${limitParam} OFFSET $${offsetParam}`,
    [...values, limit, offset]
  );

  const totalCount = countResult.rows[0]?.total_count || 0;

  return {
    items: result.rows.map(mapSessionRow),
    pagination: { page, limit, total_count: totalCount }
  };
}

async function getSessionById(pool, sessionId) {
  const id = String(sessionId || "").trim();
  if (!id) {
    throw httpError("session_id is required.", 400);
  }

  const result = await pool.query(
    `SELECT s.session_id, s.employee_code, s.user_id, s.email_id, s.login_at, s.logout_at,
            s.last_seen_at, s.source_ip, s.user_agent_summary, s.status, s.termination_reason,
            u.full_name
     FROM app_user_session s
     LEFT JOIN user_mstr u ON u.employee_code = s.employee_code
     WHERE s.session_id = $1`,
    [id]
  );

  if (!result.rows[0]) {
    throw httpError("Session not found.", 404);
  }

  return mapSessionRow(result.rows[0]);
}

async function listScreenActivity(pool, query = {}) {
  const { page, limit, offset } = normalizePagination(query);
  const conditions = [];
  const values = [];

  const searchTerm = resolveSmartSearchTerm(query);
  if (searchTerm) {
    const idx = pushSearchPattern(values, searchTerm);
    conditions.push(
      `(
        a.employee_code ILIKE $${idx}
        OR COALESCE(u.full_name, '') ILIKE $${idx}
        OR a.screen_key ILIKE $${idx}
        OR a.route_template ILIKE $${idx}
        OR a.session_id::text ILIKE $${idx}
        OR a.activity_id ILIKE $${idx}
      )`
    );
  }

  const sessionId = query.session_id || query.sessionId;
  if (sessionId) {
    values.push(String(sessionId).trim());
    conditions.push(`a.session_id = $${values.length}::uuid`);
  }

  const from = resolveHistoryFrom(query);
  values.push(from);
  conditions.push(`a.entered_at >= $${values.length}`);

  const to = parseDateBoundary(query.to || query.date_to, { endOfDay: true });
  if (to) {
    values.push(to);
    conditions.push(`a.entered_at <= $${values.length}`);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS total_count
     FROM app_screen_activity a
     LEFT JOIN user_mstr u ON u.employee_code = a.employee_code
     ${whereClause}`,
    values
  );

  const limitParam = values.length + 1;
  const offsetParam = values.length + 2;

  const result = await pool.query(
    `SELECT a.activity_id, a.session_id, a.employee_code, a.screen_key, a.route_template,
            a.entered_at, a.exited_at, a.last_visible_at, a.duration_seconds, a.metadata,
            u.full_name
     FROM app_screen_activity a
     LEFT JOIN user_mstr u ON u.employee_code = a.employee_code
     ${whereClause}
     ORDER BY a.entered_at DESC
     LIMIT $${limitParam} OFFSET $${offsetParam}`,
    [...values, limit, offset]
  );

  return {
    items: result.rows.map(mapScreenRow),
    pagination: {
      page,
      limit,
      total_count: countResult.rows[0]?.total_count || 0
    }
  };
}

async function listBusinessAudit(pool, query = {}) {
  const enrichedQuery = { ...query };

  const searchTerm = resolveSmartSearchTerm(query);
  if (searchTerm) {
    enrichedQuery.search = searchTerm;
  }

  enrichedQuery.date_from = resolveHistoryFrom(query);
  const to = parseDateBoundary(query.to || query.date_to, { endOfDay: true });
  if (to) {
    enrichedQuery.date_to = to;
  }

  const outcome = query.outcome;
  if (outcome) {
    enrichedQuery.outcome = String(outcome).trim().toLowerCase();
  }

  return enterpriseAuditReadService.listAudits(pool, enrichedQuery);
}

module.exports = {
  listSessions,
  getSessionById,
  listScreenActivity,
  listBusinessAudit,
  resolveSmartSearchTerm
};
