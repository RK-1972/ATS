/**
 * Phase 6C-1 — notification delivery envelope + audit verification.
 * Run: node scripts/verifyPhase6c1NotificationDelivery.js
 */
require("dotenv").config();

const crypto = require("crypto");
const { Pool } = require("pg");
const notificationService = require("../services/notificationService");

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

const { NOTIFICATION_CHANNELS, DELIVERY_STATUS, sanitizePayload } =
  notificationService;

function pass(label) {
  console.log(`PASS: ${label}`);
}

function fail(label, detail) {
  console.error(`FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
  process.exitCode = 1;
}

function skip(label, detail) {
  console.log(`SKIP: ${label}${detail ? ` — ${detail}` : ""}`);
}

async function tableExists(tableName) {
  const result = await pool.query(
    `SELECT EXISTS (
       SELECT 1
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = $1
     ) AS exists`,
    [tableName]
  );

  return Boolean(result.rows[0]?.exists);
}

async function indexExists(indexName) {
  const result = await pool.query(
    `SELECT EXISTS (
       SELECT 1
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND indexname = $1
     ) AS exists`,
    [indexName]
  );

  return Boolean(result.rows[0]?.exists);
}

async function cleanupCorrelationIds(correlationIds = []) {
  if (!correlationIds.length) {
    return;
  }

  await pool.query(
    `DELETE FROM notification_deliveries
     WHERE correlation_id = ANY($1::text[])`,
    [correlationIds]
  );
}

async function verifySchema() {
  if (!(await tableExists("notification_deliveries"))) {
    fail("notification_deliveries table exists");
    return;
  }

  pass("notification_deliveries table exists");

  const requiredIndexes = [
    "uq_notification_deliveries_correlation_id",
    "idx_notification_deliveries_event_attempted",
    "idx_notification_deliveries_recipient",
    "idx_notification_deliveries_status"
  ];

  for (const indexName of requiredIndexes) {
    if (await indexExists(indexName)) {
      pass(`index ${indexName} exists`);
    } else {
      fail(`index ${indexName} exists`);
    }
  }

  const constraintResult = await pool.query(
    `SELECT 1
     FROM pg_constraint
     WHERE conname = 'chk_notification_deliveries_status'
     LIMIT 1`
  );

  if (constraintResult.rows.length) {
    pass("status check constraint exists");
  } else {
    fail("status check constraint exists");
  }
}

async function verifySuccessfulAttempt(correlationId) {
  const result = await notificationService.send(pool, {
    event: "verify.notification.success",
    recipient: "verify-success@example.com",
    channel: NOTIFICATION_CHANNELS.EMAIL,
    templateKey: "VERIFY-SUCCESS",
    correlationId,
    payload: {
      candidate_id: 999001,
      source: "phase6c1-verify"
    },
    deliver: async () => undefined
  });

  if (result.idempotentReplay) {
    fail("successful attempt is not an idempotent replay on first send");
    return;
  }

  if (result.delivery?.status !== DELIVERY_STATUS.SUCCESS) {
    fail("successful attempt status", result.delivery?.status);
    return;
  }

  if (!result.delivery?.completedOn) {
    fail("successful attempt completed_on timestamp missing");
    return;
  }

  pass("service records successful delivery attempt");
}

async function verifyFailedAttempt(correlationId) {
  const result = await notificationService.send(pool, {
    event: "verify.notification.failure",
    recipient: "verify-failure@example.com",
    channel: NOTIFICATION_CHANNELS.EMAIL,
    templateKey: "VERIFY-FAILURE",
    correlationId,
    payload: {
      candidate_id: 999002
    },
    deliver: async () => {
      const error = new Error("Simulated Graph send failure");
      error.code = "GRAPH_SEND_FAILED";
      throw error;
    }
  });

  if (result.delivery?.status !== DELIVERY_STATUS.FAILED) {
    fail("failed attempt status", result.delivery?.status);
    return;
  }

  if (result.delivery?.errorCode !== "GRAPH_SEND_FAILED") {
    fail("failed attempt error_code", result.delivery?.errorCode);
    return;
  }

  if (!result.delivery?.errorMessage?.includes("Simulated Graph send failure")) {
    fail("failed attempt error_message missing detail");
    return;
  }

  pass("service records failed delivery attempt");
}

async function verifySensitivePayloadRedaction(correlationId) {
  const sensitivePayload = {
    candidate_id: 999003,
    password: "Welcome@123",
    reset_token: "abc-reset-token",
    authorization: "Bearer secret-token",
    html: "<p>Rendered body must not persist</p>",
    nested: {
      client_secret: "super-secret",
      note: "safe-value"
    }
  };

  const sanitized = sanitizePayload(sensitivePayload);

  if (
    sanitized.password !== "[REDACTED]"
    || sanitized.reset_token !== "[REDACTED]"
    || sanitized.authorization !== "[REDACTED]"
    || sanitized.html !== "[REDACTED]"
    || sanitized.nested.client_secret !== "[REDACTED]"
  ) {
    fail("sanitizePayload redacts sensitive keys");
    return;
  }

  if (sanitized.nested.note !== "safe-value") {
    fail("sanitizePayload preserves safe nested values");
    return;
  }

  pass("sanitizePayload redacts sensitive fields");

  const result = await notificationService.send(pool, {
    event: "verify.notification.sensitive",
    recipient: "verify-sensitive@example.com",
    channel: NOTIFICATION_CHANNELS.EMAIL,
    templateKey: "VERIFY-SENSITIVE",
    correlationId,
    payload: sensitivePayload,
    deliver: async () => undefined
  });

  const stored = result.delivery?.metadata || {};

  if (
    stored.password !== "[REDACTED]"
    || stored.reset_token !== "[REDACTED]"
    || stored.authorization !== "[REDACTED]"
    || stored.html !== "[REDACTED]"
    || stored.nested?.client_secret !== "[REDACTED]"
  ) {
    fail("persisted metadata redacts sensitive fields");
    return;
  }

  pass("persisted metadata excludes sensitive payload values");
}

async function verifyIdempotency(correlationId) {
  const first = await notificationService.send(pool, {
    event: "verify.notification.idempotent",
    recipient: "verify-idempotent@example.com",
    channel: NOTIFICATION_CHANNELS.EMAIL,
    templateKey: "VERIFY-IDEMPOTENT",
    correlationId,
    payload: { attempt: 1 },
    deliver: async () => undefined
  });

  let deliverCalls = 0;

  const second = await notificationService.send(pool, {
    event: "verify.notification.idempotent",
    recipient: "verify-idempotent@example.com",
    channel: NOTIFICATION_CHANNELS.EMAIL,
    templateKey: "VERIFY-IDEMPOTENT",
    correlationId,
    payload: { attempt: 2 },
    deliver: async () => {
      deliverCalls += 1;
    }
  });

  if (!second.idempotentReplay) {
    fail("duplicate correlation_id returns idempotent replay");
    return;
  }

  if (second.delivery?.deliveryId !== first.delivery?.deliveryId) {
    fail(
      "duplicate correlation_id returns same delivery row",
      `${first.delivery?.deliveryId} vs ${second.delivery?.deliveryId}`
    );
    return;
  }

  if (deliverCalls !== 0) {
    fail("duplicate correlation_id does not re-run deliver()");
    return;
  }

  pass("duplicate correlation_id is deterministic and skips re-delivery");
}

async function verifyPendingWithoutDeliver(correlationId) {
  const result = await notificationService.send(pool, {
    event: "verify.notification.pending",
    recipient: "verify-pending@example.com",
    channel: NOTIFICATION_CHANNELS.EMAIL,
    templateKey: "VERIFY-PENDING",
    correlationId,
    payload: { mode: "audit-only" }
  });

  if (result.delivery?.status !== DELIVERY_STATUS.PENDING) {
    fail("audit-only send remains Pending without deliver()", result.delivery?.status);
    return;
  }

  pass("audit-only send records Pending attempt without deliver()");
}

async function main() {
  const correlationIds = [
    `verify-6c1-success-${crypto.randomBytes(4).toString("hex")}`,
    `verify-6c1-failure-${crypto.randomBytes(4).toString("hex")}`,
    `verify-6c1-sensitive-${crypto.randomBytes(4).toString("hex")}`,
    `verify-6c1-idempotent-${crypto.randomBytes(4).toString("hex")}`,
    `verify-6c1-pending-${crypto.randomBytes(4).toString("hex")}`
  ];

  try {
    if (!(await tableExists("notification_deliveries"))) {
      skip(
        "schema checks",
        "notification_deliveries missing — run npm run migrate:notification-deliveries first"
      );
      return;
    }

    await verifySchema();
    await verifySuccessfulAttempt(correlationIds[0]);
    await verifyFailedAttempt(correlationIds[1]);
    await verifySensitivePayloadRedaction(correlationIds[2]);
    await verifyIdempotency(correlationIds[3]);
    await verifyPendingWithoutDeliver(correlationIds[4]);
  } finally {
    await cleanupCorrelationIds(correlationIds);
    await pool.end();
  }

  if (process.exitCode) {
    console.error("\nPhase 6C-1 notification delivery verification failed.");
    process.exit(process.exitCode);
  }

  console.log("\nPhase 6C-1 notification delivery verification passed.");
}

main().catch((error) => {
  console.error("Verification crashed:", error.message);
  process.exit(1);
});
