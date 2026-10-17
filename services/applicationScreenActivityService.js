const crypto = require("crypto");

const MAX_BATCH_SIZE = 25;
const MAX_SCREEN_KEY_LENGTH = 120;
const MAX_ROUTE_LENGTH = 255;

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function isIsoTimestamp(value) {
  if (!value) {
    return false;
  }

  const date = new Date(value);
  return !Number.isNaN(date.getTime());
}

function sanitizeScreenKey(value) {
  const key = String(value || "").trim();
  if (!key || key.length > MAX_SCREEN_KEY_LENGTH) {
    return null;
  }

  if (/[?#]/.test(key)) {
    return null;
  }

  return key;
}

function sanitizeRouteTemplate(value) {
  const route = String(value || "").trim();
  if (!route || route.length > MAX_ROUTE_LENGTH) {
    return null;
  }

  if (route.includes("?")) {
    return route.split("?")[0].slice(0, MAX_ROUTE_LENGTH);
  }

  return route;
}

function computeDurationSeconds(enteredAt, exitedAt, lastVisibleAt) {
  const start = new Date(enteredAt);
  if (Number.isNaN(start.getTime())) {
    return null;
  }

  const endRaw = exitedAt || lastVisibleAt;
  if (!endRaw) {
    return null;
  }

  const end = new Date(endRaw);
  if (Number.isNaN(end.getTime()) || end.getTime() < start.getTime()) {
    return null;
  }

  return Math.max(0, Math.round((end.getTime() - start.getTime()) / 1000));
}

function validateEvent(raw = {}, actorEmployeeCode) {
  const screenKey = sanitizeScreenKey(raw.screen_key || raw.screenKey);
  const routeTemplate = sanitizeRouteTemplate(raw.route_template || raw.routeTemplate);

  if (!screenKey || !routeTemplate) {
    throw httpError("Each screen event requires a valid screen_key and route_template.", 400);
  }

  const enteredAt = raw.entered_at || raw.enteredAt;
  if (!isIsoTimestamp(enteredAt)) {
    throw httpError("Screen event entered_at must be a valid ISO timestamp.", 400);
  }

  const exitedAt = raw.exited_at || raw.exitedAt || null;
  const lastVisibleAt = raw.last_visible_at || raw.lastVisibleAt || null;

  if (exitedAt && !isIsoTimestamp(exitedAt)) {
    throw httpError("Screen event exited_at must be a valid ISO timestamp when provided.", 400);
  }

  if (lastVisibleAt && !isIsoTimestamp(lastVisibleAt)) {
    throw httpError("Screen event last_visible_at must be a valid ISO timestamp when provided.", 400);
  }

  const sessionId = raw.session_id || raw.sessionId;
  const normalizedSessionId = sessionId ? String(sessionId).trim() : null;

  const durationSeconds =
    raw.duration_seconds ?? raw.durationSeconds ??
    computeDurationSeconds(enteredAt, exitedAt, lastVisibleAt);

  return {
    activity_id: `scr-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
    session_id: normalizedSessionId,
    employee_code: actorEmployeeCode,
    screen_key: screenKey,
    route_template: routeTemplate,
    entered_at: new Date(enteredAt).toISOString(),
    exited_at: exitedAt ? new Date(exitedAt).toISOString() : null,
    last_visible_at: lastVisibleAt ? new Date(lastVisibleAt).toISOString() : null,
    duration_seconds: durationSeconds,
    metadata: {
      visibility: raw.visibility || null
    }
  };
}

async function ingestBatch(pool, req, events = []) {
  if (!Array.isArray(events) || !events.length) {
    throw httpError("At least one screen activity event is required.", 400);
  }

  if (events.length > MAX_BATCH_SIZE) {
    throw httpError(`Screen activity batch cannot exceed ${MAX_BATCH_SIZE} events.`, 400);
  }

  const actorCode = String(req.user?.employee_code || "").trim();
  if (!actorCode) {
    throw httpError("Authenticated employee_code is required.", 401);
  }

  const jwtSessionId = req.user?.session_id
    ? String(req.user.session_id).trim()
    : null;

  const normalized = events.map((event) => {
    const row = validateEvent(event, actorCode);

    if (row.session_id && jwtSessionId && row.session_id !== jwtSessionId) {
      throw httpError("Screen activity session_id must match the authenticated session.", 403);
    }

    if (!row.session_id && jwtSessionId) {
      row.session_id = jwtSessionId;
    }

    return row;
  });

  for (const row of normalized) {
    await pool.query(
      `INSERT INTO app_screen_activity (
         activity_id, session_id, employee_code, screen_key, route_template,
         entered_at, exited_at, last_visible_at, duration_seconds, metadata
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        row.activity_id,
        row.session_id,
        row.employee_code,
        row.screen_key,
        row.route_template,
        row.entered_at,
        row.exited_at,
        row.last_visible_at,
        row.duration_seconds,
        JSON.stringify(row.metadata)
      ]
    );
  }

  return { accepted: normalized.length };
}

function mapScreenRow(row) {
  const fullName = row.full_name ? String(row.full_name).trim() : "";

  return {
    activity_id: row.activity_id,
    session_id: row.session_id,
    employee_code: row.employee_code,
    full_name: fullName || null,
    screen_key: row.screen_key,
    route_template: row.route_template,
    entered_at:
      row.entered_at instanceof Date ? row.entered_at.toISOString() : row.entered_at,
    exited_at:
      row.exited_at instanceof Date ? row.exited_at.toISOString() : row.exited_at,
    last_visible_at:
      row.last_visible_at instanceof Date
        ? row.last_visible_at.toISOString()
        : row.last_visible_at,
    duration_seconds: row.duration_seconds,
    metadata: row.metadata || {}
  };
}

module.exports = {
  MAX_BATCH_SIZE,
  validateEvent,
  ingestBatch,
  mapScreenRow,
  sanitizeScreenKey,
  sanitizeRouteTemplate
};
