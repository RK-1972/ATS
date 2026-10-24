const crypto = require("crypto");

const { resolveClientIp } = require("../utils/clientIpResolver");
const { formatUserAgentSummary } = require("../utils/userAgentSummary");
const {
  SESSION_STATUS,
  refreshStaleSessionStatesForHeartbeat
} = require("./applicationSessionService");
const { completeEmployeeLogin } = require("./employeeLoginService");

const TAKEOVER_STATUS = Object.freeze({
  PENDING: "PENDING",
  APPROVED: "APPROVED",
  DENIED: "DENIED",
  EXPIRED: "EXPIRED",
  CANCELLED: "CANCELLED",
  COMPLETED: "COMPLETED"
});

const DEFAULT_TIMEOUT_SECONDS = 120;
const MIN_TIMEOUT_SECONDS = 60;
const MAX_TIMEOUT_SECONDS = 300;

function httpError(message, status = 400, code = null) {
  const error = new Error(message);
  error.status = status;
  if (code) {
    error.code = code;
  }
  return error;
}

function resolveTakeoverTimeoutMs() {
  const raw = Number(process.env.SESSION_TAKEOVER_TIMEOUT_SECONDS);
  if (!Number.isFinite(raw)) {
    return DEFAULT_TIMEOUT_SECONDS * 1000;
  }
  const bounded = Math.min(
    MAX_TIMEOUT_SECONDS,
    Math.max(MIN_TIMEOUT_SECONDS, Math.floor(raw))
  );
  return bounded * 1000;
}

function hashPollToken(token) {
  return crypto.createHash("sha256").update(String(token), "utf8").digest("hex");
}

function generatePollToken() {
  return crypto.randomBytes(32).toString("base64url");
}

async function insertTakeoverEvent(
  client,
  { requestId, employeeCode, eventType, actorSessionId = null, detail = null }
) {
  await client.query(
    `INSERT INTO app_session_takeover_event (
       request_id, employee_code, event_type, actor_session_id, detail
     ) VALUES ($1,$2,$3,$4,$5)`,
    [
      requestId,
      employeeCode,
      eventType,
      actorSessionId,
      detail ? String(detail).slice(0, 256) : null
    ]
  );
}

async function findActiveSessionForEmployee(pool, employeeCode) {
  await refreshStaleSessionStatesForHeartbeat(pool);

  const result = await pool.query(
    `SELECT session_id, employee_code, status, login_at
     FROM app_user_session
     WHERE employee_code = $1
       AND status = $2
     ORDER BY login_at DESC
     LIMIT 1`,
    [String(employeeCode).trim(), SESSION_STATUS.ACTIVE]
  );

  return result.rows[0] || null;
}

async function assertIncumbentSessionStillActive(pool, incumbentSessionId) {
  const result = await pool.query(
    `SELECT session_id, status
     FROM app_user_session
     WHERE session_id = $1::uuid`,
    [String(incumbentSessionId).trim()]
  );

  const row = result.rows[0];
  if (!row || row.status !== SESSION_STATUS.ACTIVE) {
    return false;
  }
  return true;
}

async function cancelPendingForSession(pool, sessionId, { reason = "SESSION_ENDED" } = {}) {
  const id = String(sessionId || "").trim();
  if (!id) {
    return { updated: 0 };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const pending = await client.query(
      `SELECT request_id, employee_code
       FROM app_session_takeover_request
       WHERE incumbent_session_id = $1::uuid
         AND status = $2
       FOR UPDATE`,
      [id, TAKEOVER_STATUS.PENDING]
    );

    if (!pending.rowCount) {
      await client.query("COMMIT");
      return { updated: 0 };
    }

    await client.query(
      `UPDATE app_session_takeover_request
       SET status = $2,
           termination_reason = $3,
           decided_at = COALESCE(decided_at, NOW())
       WHERE incumbent_session_id = $1::uuid
         AND status = $4`,
      [id, TAKEOVER_STATUS.CANCELLED, String(reason).slice(0, 64), TAKEOVER_STATUS.PENDING]
    );

    for (const row of pending.rows) {
      await insertTakeoverEvent(client, {
        requestId: row.request_id,
        employeeCode: row.employee_code,
        eventType: "CANCELLED",
        actorSessionId: id,
        detail: reason
      });
    }

    await client.query("COMMIT");
    return { updated: pending.rowCount };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function cancelPendingForEmployee(pool, employeeCode, { reason = "ACCOUNT_REVOKED" } = {}) {
  const code = String(employeeCode || "").trim();
  if (!code) {
    return { updated: 0 };
  }

  const result = await pool.query(
    `UPDATE app_session_takeover_request
     SET status = $2,
         termination_reason = $3,
         decided_at = COALESCE(decided_at, NOW())
     WHERE employee_code = $1
       AND status = $4
     RETURNING request_id`,
    [code, TAKEOVER_STATUS.CANCELLED, String(reason).slice(0, 64), TAKEOVER_STATUS.PENDING]
  );

  return { updated: result.rowCount };
}

async function expireDueTakeoverRequests(pool, { now = new Date() } = {}) {
  const result = await pool.query(
    `UPDATE app_session_takeover_request
     SET status = $2,
         termination_reason = $3,
         decided_at = COALESCE(decided_at, NOW())
     WHERE status = ANY($4::text[])
       AND expires_at <= $1
     RETURNING request_id, employee_code, incumbent_session_id`,
    [
      now.toISOString(),
      TAKEOVER_STATUS.EXPIRED,
      "TIMEOUT",
      [TAKEOVER_STATUS.PENDING, TAKEOVER_STATUS.APPROVED]
    ]
  );

  for (const row of result.rows) {
    await pool.query(
      `INSERT INTO app_session_takeover_event (
         request_id, employee_code, event_type, actor_session_id, detail
       ) VALUES ($1,$2,$3,$4,$5)`,
      [
        row.request_id,
        row.employee_code,
        "EXPIRED",
        row.incumbent_session_id,
        "TIMEOUT"
      ]
    );
  }

  return { updated: result.rowCount };
}

/**
 * Pending requests whose incumbent session is no longer ACTIVE cannot proceed.
 */
async function cancelOrphanedPendingRequests(pool, employeeCode = null) {
  const values = [TAKEOVER_STATUS.CANCELLED, "SESSION_ENDED", TAKEOVER_STATUS.PENDING];
  const conditions = [
    `r.status = $3`,
    `NOT EXISTS (
       SELECT 1 FROM app_user_session s
       WHERE s.session_id = r.incumbent_session_id
         AND s.status = $4
     )`
  ];
  values.push(SESSION_STATUS.ACTIVE);

  if (employeeCode) {
    values.push(String(employeeCode).trim());
    conditions.push(`r.employee_code = $${values.length}`);
  }

  const result = await pool.query(
    `UPDATE app_session_takeover_request r
     SET status = $1,
         termination_reason = $2,
         decided_at = COALESCE(decided_at, NOW())
     WHERE ${conditions.join(" AND ")}
     RETURNING request_id, employee_code, incumbent_session_id`,
    values
  );

  for (const row of result.rows) {
    await pool.query(
      `INSERT INTO app_session_takeover_event (
         request_id, employee_code, event_type, actor_session_id, detail
       ) VALUES ($1,$2,$3,$4,$5)`,
      [
        row.request_id,
        row.employee_code,
        "CANCELLED",
        row.incumbent_session_id,
        "SESSION_ENDED"
      ]
    );
  }

  return { updated: result.rowCount };
}

async function findApprovedAwaitingCompletion(pool, employeeCode) {
  const result = await pool.query(
    `SELECT request_id
     FROM app_session_takeover_request
     WHERE employee_code = $1
       AND status = $2
     LIMIT 1`,
    [String(employeeCode).trim(), TAKEOVER_STATUS.APPROVED]
  );
  return result.rows[0] || null;
}

function mapInboxRow(row) {
  return {
    request_id: row.request_id,
    status: row.status,
    created_at:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : row.created_at,
    expires_at:
      row.expires_at instanceof Date
        ? row.expires_at.toISOString()
        : row.expires_at,
    requester_ip: row.requester_ip || null,
    requester_user_agent_summary: row.requester_user_agent_summary || null
  };
}

/**
 * After password verification: either complete login or create takeover pending state.
 */
async function resolveLoginAfterPasswordVerified(pool, user, req) {
  const employeeCode = String(user.employee_code || "").trim();

  await expireDueTakeoverRequests(pool);
  await cancelOrphanedPendingRequests(pool, employeeCode);

  const approvedAwaiting = await findApprovedAwaitingCompletion(pool, employeeCode);
  if (approvedAwaiting) {
    return {
      outcome: "TAKEOVER_COMPLETE_REQUIRED",
      message:
        "A sign-in was already approved and must be completed on the requesting device. Try again later if that attempt failed."
    };
  }

  const activeSession = await findActiveSessionForEmployee(pool, employeeCode);

  if (!activeSession) {
    const completed = await completeEmployeeLogin(pool, user, req);
    return { outcome: "SESSION_ISSUED", ...completed };
  }

  const timeoutMs = resolveTakeoverTimeoutMs();
  const expiresAt = new Date(Date.now() + timeoutMs);
  const pollToken = generatePollToken();
  const pollTokenHash = hashPollToken(pollToken);
  const requestId = crypto.randomUUID();

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(
      `UPDATE app_session_takeover_request
       SET status = $2,
           termination_reason = $3,
           decided_at = COALESCE(decided_at, NOW())
       WHERE employee_code = $1
         AND status = ANY($4::text[])`,
      [
        employeeCode,
        TAKEOVER_STATUS.CANCELLED,
        "SUPERSEDED",
        [TAKEOVER_STATUS.PENDING, TAKEOVER_STATUS.APPROVED]
      ]
    );

    await client.query(
      `INSERT INTO app_session_takeover_request (
         request_id, employee_code, incumbent_session_id, status,
         poll_token_hash, requester_ip, requester_user_agent_summary,
         expires_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        requestId,
        employeeCode,
        activeSession.session_id,
        TAKEOVER_STATUS.PENDING,
        pollTokenHash,
        resolveClientIp(req),
        formatUserAgentSummary(req?.headers?.["user-agent"]),
        expiresAt.toISOString()
      ]
    );

    await insertTakeoverEvent(client, {
      requestId,
      employeeCode,
      eventType: "CREATED",
      actorSessionId: activeSession.session_id,
      detail: "PENDING_APPROVAL"
    });

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  return {
    outcome: "TAKEOVER_PENDING",
    pollToken,
    expiresAt: expiresAt.toISOString(),
    pollIntervalSeconds: 2
  };
}

async function getPendingInboxForSession(pool, sessionId) {
  await expireDueTakeoverRequests(pool);

  const id = String(sessionId || "").trim();
  if (!id) {
    return null;
  }

  const stillActive = await assertIncumbentSessionStillActive(pool, id);
  if (!stillActive) {
    await cancelPendingForSession(pool, id, { reason: "SESSION_ENDED" });
    return null;
  }

  const result = await pool.query(
    `SELECT request_id, status, created_at, expires_at,
            requester_ip::text AS requester_ip,
            requester_user_agent_summary
     FROM app_session_takeover_request
     WHERE incumbent_session_id = $1::uuid
       AND status = $2
     ORDER BY created_at DESC
     LIMIT 1`,
    [id, TAKEOVER_STATUS.PENDING]
  );

  if (!result.rows.length) {
    return null;
  }

  return mapInboxRow(result.rows[0]);
}

async function decideTakeover(pool, requestId, decision, req) {
  const normalizedDecision = String(decision || "").trim().toLowerCase();
  if (normalizedDecision !== "accept" && normalizedDecision !== "deny") {
    throw httpError("decision must be accept or deny.", 400);
  }

  const actorSessionId = req.user?.session_id
    ? String(req.user.session_id).trim()
    : "";

  if (!actorSessionId) {
    throw httpError("Authenticated session is required.", 401, "SESSION_INVALID");
  }

  await expireDueTakeoverRequests(pool);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const locked = await client.query(
      `SELECT r.*
       FROM app_session_takeover_request r
       WHERE r.request_id = $1::uuid
       FOR UPDATE`,
      [String(requestId).trim()]
    );

    if (!locked.rowCount) {
      throw httpError("Takeover request not found.", 404);
    }

    const row = locked.rows[0];

    if (row.incumbent_session_id !== actorSessionId) {
      throw httpError(
        "This session is not authorized to decide this takeover request.",
        403
      );
    }

    if (row.status === TAKEOVER_STATUS.APPROVED || row.status === TAKEOVER_STATUS.DENIED) {
      await client.query("COMMIT");
      return {
        idempotent: true,
        status: row.status,
        request_id: row.request_id
      };
    }

    if (row.status !== TAKEOVER_STATUS.PENDING) {
      throw httpError("Takeover request is no longer actionable.", 409);
    }

    if (new Date(row.expires_at).getTime() <= Date.now()) {
      await client.query(
        `UPDATE app_session_takeover_request
         SET status = $2, termination_reason = $3, decided_at = NOW()
         WHERE request_id = $1`,
        [row.request_id, TAKEOVER_STATUS.EXPIRED, "TIMEOUT"]
      );
      await insertTakeoverEvent(client, {
        requestId: row.request_id,
        employeeCode: row.employee_code,
        eventType: "EXPIRED",
        actorSessionId: actorSessionId,
        detail: "TIMEOUT"
      });
      await client.query("COMMIT");
      throw httpError(
        "The takeover request has expired. The existing session remains active.",
        409,
        "SESSION_TAKEOVER_EXPIRED"
      );
    }

    const incumbentActive = await client.query(
      `SELECT session_id FROM app_user_session
       WHERE session_id = $1::uuid AND status = $2`,
      [row.incumbent_session_id, SESSION_STATUS.ACTIVE]
    );

    if (!incumbentActive.rowCount) {
      await client.query(
        `UPDATE app_session_takeover_request
         SET status = $2, termination_reason = $3, decided_at = NOW()
         WHERE request_id = $1`,
        [row.request_id, TAKEOVER_STATUS.CANCELLED, "SESSION_ENDED"]
      );
      await insertTakeoverEvent(client, {
        requestId: row.request_id,
        employeeCode: row.employee_code,
        eventType: "CANCELLED",
        actorSessionId: actorSessionId,
        detail: "SESSION_ENDED"
      });
      await client.query("COMMIT");
      throw httpError("The active session is no longer valid.", 409);
    }

    if (normalizedDecision === "deny") {
      await client.query(
        `UPDATE app_session_takeover_request
         SET status = $2,
             decided_at = NOW(),
             decision_by_session_id = $3::uuid,
             termination_reason = $4
         WHERE request_id = $1`,
        [
          row.request_id,
          TAKEOVER_STATUS.DENIED,
          actorSessionId,
          "DENIED_BY_USER"
        ]
      );
      await insertTakeoverEvent(client, {
        requestId: row.request_id,
        employeeCode: row.employee_code,
        eventType: "DENIED",
        actorSessionId,
        detail: "DENIED_BY_USER"
      });
      await client.query("COMMIT");
      return {
        status: TAKEOVER_STATUS.DENIED,
        request_id: row.request_id
      };
    }

    await client.query(
      `UPDATE app_user_session
       SET status = $2,
           termination_reason = $3,
           logout_at = NOW(),
           last_seen_at = COALESCE(last_seen_at, NOW())
       WHERE session_id = $1::uuid
         AND status = $4`,
      [
        row.incumbent_session_id,
        SESSION_STATUS.REVOKED,
        "TAKEOVER_APPROVED",
        SESSION_STATUS.ACTIVE
      ]
    );

    await client.query(
      `UPDATE app_session_takeover_request
       SET status = $2,
           decided_at = NOW(),
           decision_by_session_id = $3::uuid,
           termination_reason = $4
       WHERE request_id = $1`,
      [row.request_id, TAKEOVER_STATUS.APPROVED, actorSessionId, "APPROVED"]
    );

    await insertTakeoverEvent(client, {
      requestId: row.request_id,
      employeeCode: row.employee_code,
      eventType: "APPROVED",
      actorSessionId,
      detail: "TAKEOVER_APPROVED"
    });

    await client.query("COMMIT");
    return {
      status: TAKEOVER_STATUS.APPROVED,
      request_id: row.request_id
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function pollTakeoverStatus(pool, pollToken) {
  const token = String(pollToken || "").trim();
  if (!token) {
    throw httpError("poll_token is required.", 400);
  }

  await expireDueTakeoverRequests(pool);

  const result = await pool.query(
    `SELECT request_id, status, expires_at, termination_reason, employee_code,
            incumbent_session_id
     FROM app_session_takeover_request
     WHERE poll_token_hash = $1`,
    [hashPollToken(token)]
  );

  if (!result.rows.length) {
    throw httpError("Takeover request not found.", 404);
  }

  const row = result.rows[0];
  const status = row.status;

  if (status === TAKEOVER_STATUS.PENDING) {
    const incumbentOk = await assertIncumbentSessionStillActive(
      pool,
      row.incumbent_session_id
    );
    if (!incumbentOk) {
      await cancelPendingForSession(pool, row.incumbent_session_id, {
        reason: "SESSION_ENDED"
      });
      return {
        status: TAKEOVER_STATUS.CANCELLED,
        message:
          "The active session ended. Sign in again when ready.",
        can_complete: false
      };
    }

    return {
      status: TAKEOVER_STATUS.PENDING,
      message: "Waiting for approval on your other session.",
      expires_at:
        row.expires_at instanceof Date
          ? row.expires_at.toISOString()
          : row.expires_at,
      can_complete: false
    };
  }

  if (status === TAKEOVER_STATUS.APPROVED) {
    return {
      status: TAKEOVER_STATUS.APPROVED,
      message: "Access approved. Completing sign-in…",
      can_complete: true
    };
  }

  if (status === TAKEOVER_STATUS.DENIED) {
    return {
      status: TAKEOVER_STATUS.DENIED,
      message:
        "Sign-in was denied. Your existing session remains active.",
      can_complete: false
    };
  }

  if (status === TAKEOVER_STATUS.EXPIRED) {
    return {
      status: TAKEOVER_STATUS.EXPIRED,
      message:
        "The approval request timed out. Try signing in again later.",
      can_complete: false
    };
  }

  if (status === TAKEOVER_STATUS.COMPLETED) {
    return {
      status: TAKEOVER_STATUS.COMPLETED,
      message: "Sign-in already completed.",
      can_complete: false
    };
  }

  return {
    status,
    message: "This sign-in request is no longer valid.",
    can_complete: false
  };
}

async function completeTakeoverLogin(pool, pollToken, user, req) {
  const token = String(pollToken || "").trim();
  if (!token) {
    throw httpError("poll_token is required.", 400);
  }

  await expireDueTakeoverRequests(pool);

  const client = await pool.connect();
  let row;
  let sessionId;
  let transactionOpen = false;
  try {
    await client.query("BEGIN");
    transactionOpen = true;

    const locked = await client.query(
      `SELECT *
       FROM app_session_takeover_request
       WHERE poll_token_hash = $1
       FOR UPDATE`,
      [hashPollToken(token)]
    );

    if (!locked.rowCount) {
      throw httpError("Takeover request not found.", 404);
    }

    row = locked.rows[0];

    if (row.status === TAKEOVER_STATUS.COMPLETED) {
      throw httpError("Sign-in already completed for this request.", 409);
    }

    if (row.status !== TAKEOVER_STATUS.APPROVED) {
      throw httpError("Takeover request is not approved.", 409);
    }

    if (new Date(row.expires_at).getTime() <= Date.now()) {
      await client.query(
        `UPDATE app_session_takeover_request
         SET status = $2, termination_reason = $3, decided_at = NOW()
         WHERE request_id = $1`,
        [row.request_id, TAKEOVER_STATUS.EXPIRED, "TIMEOUT"]
      );
      throw httpError(
        "The takeover request has expired. Try signing in again.",
        409,
        "SESSION_TAKEOVER_EXPIRED"
      );
    }

    if (String(user.employee_code).trim() !== String(row.employee_code).trim()) {
      throw httpError("Takeover request does not match this account.", 403);
    }

    sessionId = crypto.randomUUID();
    const applicationSessionService = require("./applicationSessionService");

    await applicationSessionService.recordLogin(
      pool,
      {
        sessionId,
        user,
        req,
        queryExecutor: (sql, params) => client.query(sql, params),
        skipReconcile: true
      }
    );

    await client.query(
      `UPDATE app_session_takeover_request
       SET status = $2,
           completed_at = NOW()
       WHERE request_id = $1`,
      [row.request_id, TAKEOVER_STATUS.COMPLETED]
    );

    await insertTakeoverEvent(client, {
      requestId: row.request_id,
      employeeCode: row.employee_code,
      eventType: "COMPLETED",
      detail: "SESSION_ISSUED"
    });

    await client.query("COMMIT");
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) {
      await client.query("ROLLBACK");
    }
    throw error;
  } finally {
    client.release();
  }

  const applicationSessionService = require("./applicationSessionService");
  await applicationSessionService.reconcileSupersededActiveSessions(pool, {
    employeeCode: String(user.employee_code || "").trim(),
    keepSessionId: sessionId
  });

  const { signEmployeeJwt, loadLoginContext, buildLoginSuccessPayload } =
    require("./employeeLoginService");
  const tokenJwt = signEmployeeJwt(user, sessionId);
  const context = await loadLoginContext(pool, user);

  return {
    sessionId,
    body: buildLoginSuccessPayload(user, tokenJwt, context)
  };
}

module.exports = {
  TAKEOVER_STATUS,
  resolveTakeoverTimeoutMs,
  hashPollToken,
  findActiveSessionForEmployee,
  resolveLoginAfterPasswordVerified,
  getPendingInboxForSession,
  decideTakeover,
  pollTakeoverStatus,
  completeTakeoverLogin,
  cancelPendingForSession,
  cancelPendingForEmployee,
  expireDueTakeoverRequests,
  cancelOrphanedPendingRequests,
  findApprovedAwaitingCompletion
};

// Backward-compatible alias for internal callers
const expireDuePendingRequests = expireDueTakeoverRequests;
module.exports.expireDuePendingRequests = expireDuePendingRequests;
