/**
 * Requisition closure actions — Filled and Cancelled paths.
 */

const { REQUISITION_STATUS } = require("../constants/requisitionStatus");
const { isLegacyDualWriteEnabled } = require("../config/operationalCutover");
const { writeEnterpriseAudit, userContext } = require("./enterpriseAuditService");
const { assertCanAssignRecruiters } = require("./requisitionCapabilityAuth");
const {
  getFulfillmentForRequisition,
  lockRequisitionForUpdate
} = require("./requisitionFulfillmentService");

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function tableExists(queryable, tableName) {
  const result = await queryable.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = $1
     ) AS exists`,
    [tableName]
  );
  return Boolean(result.rows[0]?.exists);
}

async function unpublishRequisitionInTransaction(queryable, requisition, actorName) {
  if (!requisition.candidate_portal_published_at) {
    return requisition;
  }

  const updated = await queryable.query(
    `UPDATE rm_requisitions
     SET candidate_portal_published_at = NULL,
         candidate_portal_published_by = NULL,
         modified_by = $1,
         modified_on = NOW()
     WHERE requisition_code = $2
     RETURNING *`,
    [actorName, requisition.requisition_code]
  );

  return updated.rows[0] || requisition;
}

async function closeRequisitionAsFilled(pool, requisitionCode, req) {
  await assertCanAssignRecruiters(pool, req);
  const user = userContext(req);
  const code = String(requisitionCode || "").trim();

  if (!code) {
    throw httpError("requisition_code is required.", 400);
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const requisition = await lockRequisitionForUpdate(client, code);

    if (requisition.req_status !== REQUISITION_STATUS.APPROVED) {
      throw httpError(
        `Only Approved requisitions can be closed as filled. Current status: ${requisition.req_status}.`,
        400
      );
    }

    const fulfillment = await getFulfillmentForRequisition(client, requisition);

    if (!fulfillment.closure_eligible) {
      throw httpError(
        `Requisition ${code} is not closure eligible. Filled ${fulfillment.filled_headcount} of ${fulfillment.required_headcount} required.`,
        400
      );
    }

    const unpublished = await unpublishRequisitionInTransaction(
      client,
      requisition,
      user.name
    );

    const updated = await client.query(
      `UPDATE rm_requisitions
       SET req_status = $1,
           closed_at = NOW(),
           closed_by = $2,
           closure_reason = NULL,
           modified_by = $2,
           modified_on = NOW()
       WHERE requisition_code = $3
       RETURNING *`,
      [REQUISITION_STATUS.CLOSED_FILLED, user.name, code]
    );

    if (
      isLegacyDualWriteEnabled() &&
      requisition.req_id &&
      (await tableExists(client, "req_mstr"))
    ) {
      await client.query(
        `UPDATE req_mstr
         SET req_status = $1,
             updated_on = CURRENT_TIMESTAMP
         WHERE req_id = $2`,
        [REQUISITION_STATUS.CLOSED_FILLED, requisition.req_id]
      );
    }

    await writeEnterpriseAudit(client, {
      eventType: "RequisitionClosedFilled",
      module: "Recruitment Management",
      entity: "Requisition",
      entityId: code,
      action: `Requisition ${code} closed as filled`,
      previousValue: requisition.req_status,
      newValue: REQUISITION_STATUS.CLOSED_FILLED,
      userName: user.name,
      userRole: user.role,
      metadata: {
        fulfillment,
        portal_unpublished: Boolean(unpublished.candidate_portal_published_at !== requisition.candidate_portal_published_at)
      }
    });

    await client.query("COMMIT");

    return {
      requisition: updated.rows[0],
      fulfillment,
      toastMessage: `Requisition ${code} closed as filled.`
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (_rollbackError) {
      // preserve original
    }
    throw error;
  } finally {
    client.release();
  }
}

async function closeRequisitionAsCancelled(pool, requisitionCode, reason, req) {
  await assertCanAssignRecruiters(pool, req);
  const user = userContext(req);
  const code = String(requisitionCode || "").trim();
  const cancellationReason = String(reason || "").trim();

  if (!code) {
    throw httpError("requisition_code is required.", 400);
  }

  if (!cancellationReason) {
    throw httpError("cancellation_reason is required.", 400);
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const requisition = await lockRequisitionForUpdate(client, code);

    if (requisition.req_status !== REQUISITION_STATUS.APPROVED) {
      throw httpError(
        `Only Approved requisitions can be closed as cancelled. Current status: ${requisition.req_status}.`,
        400
      );
    }

    await unpublishRequisitionInTransaction(client, requisition, user.name);

    const fulfillment = await getFulfillmentForRequisition(client, requisition);

    const updated = await client.query(
      `UPDATE rm_requisitions
       SET req_status = $1,
           closed_at = NOW(),
           closed_by = $2,
           closure_reason = $3,
           modified_by = $2,
           modified_on = NOW()
       WHERE requisition_code = $4
       RETURNING *`,
      [
        REQUISITION_STATUS.CLOSED_CANCELLED,
        user.name,
        cancellationReason,
        code
      ]
    );

    if (
      isLegacyDualWriteEnabled() &&
      requisition.req_id &&
      (await tableExists(client, "req_mstr"))
    ) {
      await client.query(
        `UPDATE req_mstr
         SET req_status = $1,
             updated_on = CURRENT_TIMESTAMP
         WHERE req_id = $2`,
        [REQUISITION_STATUS.CLOSED_CANCELLED, requisition.req_id]
      );
    }

    await writeEnterpriseAudit(client, {
      eventType: "RequisitionClosedCancelled",
      module: "Recruitment Management",
      entity: "Requisition",
      entityId: code,
      action: `Requisition ${code} closed as cancelled`,
      previousValue: requisition.req_status,
      newValue: REQUISITION_STATUS.CLOSED_CANCELLED,
      userName: user.name,
      userRole: user.role,
      metadata: {
        cancellation_reason: cancellationReason,
        fulfillment
      }
    });

    await client.query("COMMIT");

    return {
      requisition: updated.rows[0],
      fulfillment,
      toastMessage: `Requisition ${code} closed as cancelled.`
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (_rollbackError) {
      // preserve original
    }
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  closeRequisitionAsFilled,
  closeRequisitionAsCancelled
};
