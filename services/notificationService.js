/**
 * Phase 6C-1 — synchronous notification delivery envelope + audit.
 *
 * Production Graph email adapters in index.js are NOT wired here yet.
 * Callers pass an optional deliver() callback when orchestration is added.
 */

const notificationDeliveryRepository = require("../repositories/notificationDeliveryRepository");
const notificationConfigResolver = require("./notificationConfigResolver");

const { DELIVERY_STATUS } = notificationDeliveryRepository;

const NOTIFICATION_CHANNELS = {
  EMAIL: "email",
  IN_APP: "in_app",
  SMS: "sms",
  WHATSAPP: "whatsapp",
  TEAMS: "teams"
};

const SENSITIVE_KEY_PATTERN =
  /(password|passwd|secret|token|jwt|authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|bearer|otp|pin|reset[_-]?token|client[_-]?secret)/i;

const RENDERED_CONTENT_KEY_PATTERN =
  /^(html|body|content|message_body|rendered_body|email_body)$/i;

const REDACTED_VALUE = "[REDACTED]";

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function normalizeCorrelationId(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function sanitizeScalar(value) {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();

    if (/^Bearer\s+/i.test(trimmed)) {
      return REDACTED_VALUE;
    }

    if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(trimmed)) {
      return REDACTED_VALUE;
    }

    return trimmed;
  }

  return value;
}

function sanitizePayload(payload) {
  if (payload === null || payload === undefined) {
    return {};
  }

  if (Array.isArray(payload)) {
    return payload.map((item) => sanitizePayload(item));
  }

  if (typeof payload !== "object") {
    return sanitizeScalar(payload);
  }

  const sanitized = {};

  for (const [key, value] of Object.entries(payload)) {
    if (SENSITIVE_KEY_PATTERN.test(key) || RENDERED_CONTENT_KEY_PATTERN.test(key)) {
      sanitized[key] = REDACTED_VALUE;
      continue;
    }

    if (value && typeof value === "object") {
      sanitized[key] = sanitizePayload(value);
      continue;
    }

    sanitized[key] = sanitizeScalar(value);
  }

  return sanitized;
}

function normalizeSendParams(params = {}) {
  const event = String(params.event || "").trim();
  const recipient = String(params.recipient || "").trim();
  const channel = String(params.channel || "").trim().toLowerCase();
  const templateKey = params.templateKey
    ? String(params.templateKey).trim()
    : null;
  const correlationId = normalizeCorrelationId(
    params.correlationId || params.correlation_id
  );

  if (!event) {
    throw httpError("event is required.", 400);
  }

  if (!recipient) {
    throw httpError("recipient is required.", 400);
  }

  if (!channel) {
    throw httpError("channel is required.", 400);
  }

  return {
    event,
    recipient,
    channel,
    templateKey,
    correlationId,
    payload: sanitizePayload(params.payload || {}),
    deliver: typeof params.deliver === "function" ? params.deliver : null
  };
}

function extractErrorInfo(error) {
  const message = sanitizeScalar(error?.message || "Notification delivery failed.");
  const code =
    error?.code
    || error?.response?.status
    || error?.status
    || "DELIVERY_FAILED";

  return {
    errorCode: String(code),
    errorMessage: String(message).slice(0, 2000)
  };
}

/**
 * @param {import("pg").Pool | import("pg").PoolClient} pool
 * @param {object} params
 * @param {string} params.event
 * @param {string} params.recipient
 * @param {string} params.channel
 * @param {string} [params.templateKey]
 * @param {object} [params.payload] - sanitized before persistence
 * @param {string} [params.correlationId] - idempotency key (enterprise audit convention)
 * @param {() => Promise<void>} [params.deliver] - optional synchronous delivery hook
 */
async function send(pool, params = {}) {
  const normalized = normalizeSendParams(params);

  if (normalized.correlationId) {
    const existing = await notificationDeliveryRepository.findByCorrelationId(
      pool,
      normalized.correlationId
    );

    if (existing) {
      return {
        delivery: existing,
        idempotentReplay: true
      };
    }
  }

  const delivery = await notificationDeliveryRepository.insertDeliveryAttempt(
    pool,
    {
      eventKey: normalized.event,
      recipient: normalized.recipient,
      channel: normalized.channel,
      templateKey: normalized.templateKey,
      correlationId: normalized.correlationId,
      metadata: normalized.payload,
      status: DELIVERY_STATUS.PENDING
    }
  );

  if (!normalized.deliver) {
    return {
      delivery,
      idempotentReplay: false
    };
  }

  try {
    await normalized.deliver();
    const completed = await notificationDeliveryRepository.markDeliverySuccess(
      pool,
      delivery.deliveryId
    );

    return {
      delivery: completed,
      idempotentReplay: false
    };
  } catch (error) {
    const completed = await notificationDeliveryRepository.markDeliveryFailed(
      pool,
      delivery.deliveryId,
      extractErrorInfo(error)
    );

    return {
      delivery: completed,
      idempotentReplay: false,
      error
    };
  }
}

module.exports = {
  NOTIFICATION_CHANNELS,
  DELIVERY_STATUS,
  sanitizePayload,
  send,
  config: notificationConfigResolver
};
