/**
 * Persistence for notification_deliveries audit rows (Phase 6C-1).
 */

const DELIVERY_STATUS = {
  PENDING: "Pending",
  SUCCESS: "Success",
  FAILED: "Failed"
};

function mapDeliveryRow(row) {
  if (!row) {
    return null;
  }

  return {
    deliveryId: row.delivery_id,
    event: row.event_key,
    recipient: row.recipient,
    channel: row.channel,
    templateKey: row.template_key,
    status: row.status,
    correlationId: row.correlation_id,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    metadata: row.metadata || {},
    attemptedOn: row.attempted_on,
    completedOn: row.completed_on,
    createdOn: row.created_on
  };
}

async function findByCorrelationId(executor, correlationId) {
  const normalized = String(correlationId || "").trim();

  if (!normalized) {
    return null;
  }

  const result = await executor.query(
    `SELECT
       delivery_id,
       event_key,
       recipient,
       channel,
       template_key,
       status,
       correlation_id,
       error_code,
       error_message,
       metadata,
       attempted_on,
       completed_on,
       created_on
     FROM notification_deliveries
     WHERE correlation_id = $1
     LIMIT 1`,
    [normalized]
  );

  return mapDeliveryRow(result.rows[0]);
}

async function insertDeliveryAttempt(executor, payload) {
  const result = await executor.query(
    `INSERT INTO notification_deliveries (
       event_key,
       recipient,
       channel,
       template_key,
       status,
       correlation_id,
       metadata,
       attempted_on
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, NOW())
     RETURNING
       delivery_id,
       event_key,
       recipient,
       channel,
       template_key,
       status,
       correlation_id,
       error_code,
       error_message,
       metadata,
       attempted_on,
       completed_on,
       created_on`,
    [
      payload.eventKey,
      payload.recipient,
      payload.channel,
      payload.templateKey || null,
      payload.status || DELIVERY_STATUS.PENDING,
      payload.correlationId || null,
      JSON.stringify(payload.metadata || {})
    ]
  );

  return mapDeliveryRow(result.rows[0]);
}

async function markDeliverySuccess(executor, deliveryId) {
  const result = await executor.query(
    `UPDATE notification_deliveries
     SET status = $2,
         completed_on = NOW(),
         error_code = NULL,
         error_message = NULL
     WHERE delivery_id = $1
     RETURNING
       delivery_id,
       event_key,
       recipient,
       channel,
       template_key,
       status,
       correlation_id,
       error_code,
       error_message,
       metadata,
       attempted_on,
       completed_on,
       created_on`,
    [deliveryId, DELIVERY_STATUS.SUCCESS]
  );

  return mapDeliveryRow(result.rows[0]);
}

async function markDeliveryFailed(executor, deliveryId, errorInfo = {}) {
  const result = await executor.query(
    `UPDATE notification_deliveries
     SET status = $2,
         completed_on = NOW(),
         error_code = $3,
         error_message = $4
     WHERE delivery_id = $1
     RETURNING
       delivery_id,
       event_key,
       recipient,
       channel,
       template_key,
       status,
       correlation_id,
       error_code,
       error_message,
       metadata,
       attempted_on,
       completed_on,
       created_on`,
    [
      deliveryId,
      DELIVERY_STATUS.FAILED,
      errorInfo.errorCode || null,
      errorInfo.errorMessage || null
    ]
  );

  return mapDeliveryRow(result.rows[0]);
}

module.exports = {
  DELIVERY_STATUS,
  mapDeliveryRow,
  findByCorrelationId,
  insertDeliveryAttempt,
  markDeliverySuccess,
  markDeliveryFailed
};
