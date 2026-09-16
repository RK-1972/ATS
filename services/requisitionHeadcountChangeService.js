/**
 * Governed post-approval requisition headcount changes.
 */

const { REQUISITION_STATUS, isClosedRequisitionStatus } = require("../constants/requisitionStatus");
const {
  HEADCOUNT_CHANGE_STATUS,
  HEADCOUNT_CHANGE_TYPE,
  isPendingHeadcountChangeStatus
} = require("../constants/headcountChangeStatus");
const { isLegacyDualWriteEnabled } = require("../config/operationalCutover");
const { writeEnterpriseAudit, userContext } = require("./enterpriseAuditService");
const {
  assertRequisitionRequestorOwnerAccess,
  assertCanAssignRecruiters
} = require("./requisitionCapabilityAuth");
const {
  countFilledCandidates,
  countReservedOffers,
  getFulfillmentForRequisition,
  lockRequisitionForUpdate,
  normalizeRequiredHeadcount
} = require("./requisitionFulfillmentService");

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function parseContext(raw) {
  if (raw && typeof raw === "object") {
    return raw;
  }
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return {};
}

function generateHeadcountChangeId() {
  return `HCR-${Date.now()}`;
}

function isHeadcountChangeWorkflowEvent(event = {}) {
  const context = parseContext(event.executionContext);
  const meta = context.meta && typeof context.meta === "object" ? context.meta : {};
  const documentType = String(meta.document_type || "").toUpperCase();
  const instanceId = String(event.instanceId || "");

  return (
    documentType === "HEADCOUNT_CHANGE"
    || Boolean(meta.headcount_change_id)
    || instanceId.startsWith("WF-HC-")
  );
}

function resolveHeadcountChangeId(event = {}) {
  const context = parseContext(event.executionContext);
  const meta = context.meta && typeof context.meta === "object" ? context.meta : {};
  if (meta.headcount_change_id) {
    return String(meta.headcount_change_id).trim();
  }
  const instanceId = String(event.instanceId || "");
  if (instanceId.startsWith("WF-HC-")) {
    return instanceId.replace(/^WF-HC-/, "");
  }
  return null;
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

function mapHeadcountChangeRow(row) {
  if (!row) {
    return null;
  }

  return {
    change_id: row.change_id,
    requisition_code: row.requisition_code,
    old_headcount: Number(row.old_headcount) || 0,
    requested_headcount: Number(row.requested_headcount) || 0,
    change_type: row.change_type,
    reason: row.reason,
    status: row.status,
    requested_by: row.requested_by,
    requested_on: row.requested_on,
    approved_by: row.approved_by,
    approved_on: row.approved_on,
    rejected_by: row.rejected_by,
    rejected_on: row.rejected_on,
    approval_outcome: row.approval_outcome,
    workflow_instance_id: row.workflow_instance_id,
    created_on: row.created_on
  };
}

async function assertCanRequestHeadcountChange(pool, req, requisition) {
  try {
    await assertRequisitionRequestorOwnerAccess(pool, req, requisition);
    return;
  } catch (_ownerError) {
    await assertCanAssignRecruiters(pool, req);
  }
}

async function assertCanViewHeadcountChanges(pool, req, requisition) {
  await assertCanRequestHeadcountChange(pool, req, requisition);
}

async function getCapacityFloor(queryable, requisitionCode) {
  const [reserved, filled] = await Promise.all([
    countReservedOffers(queryable, requisitionCode),
    countFilledCandidates(queryable, requisitionCode)
  ]);

  return Math.max(Number(reserved) || 0, Number(filled) || 0);
}

async function assertValidRequestedHeadcount(
  queryable,
  requisition,
  requestedHeadcount
) {
  const requested = normalizeRequiredHeadcount(requestedHeadcount);
  const current = normalizeRequiredHeadcount(requisition.headcount);

  if (requested === current) {
    throw httpError(
      `Requested headcount (${requested}) must differ from the current approved headcount (${current}).`,
      400
    );
  }

  const floor = await getCapacityFloor(queryable, requisition.requisition_code);
  if (requested < floor) {
    throw httpError(
      `Requested headcount (${requested}) cannot be below current reserved/filled capacity (${floor}).`,
      409
    );
  }

  return requested;
}

async function loadHeadcountChangeById(queryable, changeId) {
  const result = await queryable.query(
    `SELECT *
     FROM rm_headcount_change_history
     WHERE change_id = $1`,
    [changeId]
  );

  return result.rows[0] || null;
}

async function lockHeadcountChangeForUpdate(queryable, changeId) {
  const result = await queryable.query(
    `SELECT *
     FROM rm_headcount_change_history
     WHERE change_id = $1
     FOR UPDATE`,
    [changeId]
  );

  if (!result.rows[0]) {
    throw httpError(`Headcount change request not found: ${changeId}`, 404);
  }

  return result.rows[0];
}

async function getPendingHeadcountChange(queryable, requisitionCode) {
  const result = await queryable.query(
    `SELECT *
     FROM rm_headcount_change_history
     WHERE requisition_code = $1
       AND status = $2
     ORDER BY requested_on DESC
     LIMIT 1`,
    [requisitionCode, HEADCOUNT_CHANGE_STATUS.PENDING]
  );

  return mapHeadcountChangeRow(result.rows[0]);
}

async function listHeadcountChangeHistory(pool, requisitionCode, req) {
  const { loadRequisitionByCode } = require("./recruitmentService");
  const requisition = await loadRequisitionByCode(pool, requisitionCode);

  if (!requisition) {
    throw httpError(`Requisition not found: ${requisitionCode}`, 404);
  }

  await assertCanViewHeadcountChanges(pool, req, requisition);

  const result = await pool.query(
    `SELECT *
     FROM rm_headcount_change_history
     WHERE requisition_code = $1
     ORDER BY requested_on DESC, created_on DESC`,
    [requisitionCode]
  );

  const pending = result.rows.find((row) => isPendingHeadcountChangeStatus(row.status)) || null;
  const fulfillment = await getFulfillmentForRequisition(pool, requisition);

  return {
    requisition_code: requisitionCode,
    current_headcount: normalizeRequiredHeadcount(requisition.headcount),
    pending_change: mapHeadcountChangeRow(pending),
    capacity_floor: Math.max(
      fulfillment.reserved_headcount || 0,
      fulfillment.filled_headcount || 0
    ),
    fulfillment,
    history: result.rows.map(mapHeadcountChangeRow)
  };
}

async function requestHeadcountChange(pool, requisitionCode, payload, req) {
  const user = userContext(req);
  const { loadRequisitionByCode } = require("./recruitmentService");
  const code = String(requisitionCode || "").trim();
  const reason = String(payload?.reason || "").trim();
  const requestedRaw = payload?.requested_headcount ?? payload?.headcount;

  if (!code) {
    throw httpError("requisition_code is required.", 400);
  }

  if (!reason) {
    throw httpError("reason is required for a headcount change request.", 400);
  }

  const requisition = await loadRequisitionByCode(pool, code);
  if (!requisition) {
    throw httpError(`Requisition not found: ${code}`, 404);
  }

  await assertCanRequestHeadcountChange(pool, req, requisition);

  if (requisition.req_status !== REQUISITION_STATUS.APPROVED) {
    throw httpError(
      `Headcount change requests are only allowed for Approved requisitions. Current status: ${requisition.req_status}.`,
      400
    );
  }

  if (isClosedRequisitionStatus(requisition.req_status)) {
    throw httpError(`Requisition ${code} is closed and cannot accept headcount changes.`, 400);
  }

  if (!String(requisition.approval_route_id || "").trim()) {
    throw httpError(
      `Requisition ${code} has no approval route configured for headcount change approval.`,
      400
    );
  }

  const requestedHeadcount = await assertValidRequestedHeadcount(
    pool,
    requisition,
    requestedRaw
  );
  const currentHeadcount = normalizeRequiredHeadcount(requisition.headcount);
  const changeType =
    requestedHeadcount > currentHeadcount
      ? HEADCOUNT_CHANGE_TYPE.INCREASE
      : HEADCOUNT_CHANGE_TYPE.REDUCTION;

  const changeId = generateHeadcountChangeId();
  const workflowInstanceId = `WF-HC-${changeId}`;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const lockedRequisition = await lockRequisitionForUpdate(client, code);
    const pending = await client.query(
      `SELECT change_id
       FROM rm_headcount_change_history
       WHERE requisition_code = $1
         AND status = $2
       LIMIT 1
       FOR UPDATE`,
      [code, HEADCOUNT_CHANGE_STATUS.PENDING]
    );

    if (pending.rows.length) {
      throw httpError(
        `Requisition ${code} already has a pending headcount change request.`,
        409
      );
    }

    await assertValidRequestedHeadcount(client, lockedRequisition, requestedHeadcount);

    const workflowService = require("./workflowService");
    const instance = await workflowService.startWorkflow(
      client,
      "REQUISITION",
      {
        instance_id: workflowInstanceId,
        meta: {
          document_type: "HEADCOUNT_CHANGE",
          headcount_change_id: changeId,
          requisition_id: code,
          old_headcount: currentHeadcount,
          requested_headcount: requestedHeadcount,
          change_type: changeType,
          reason
        },
        department: lockedRequisition.department,
        grade: lockedRequisition.grade
      },
      req
    );

    const employeeCode = req.user?.employee_code
      ? String(req.user.employee_code).trim()
      : user.name;

    await workflowService.createApprovalRouteWorkflowTasks(
      client,
      instance.instanceId,
      lockedRequisition.approval_route_id,
      {
        stageKey: instance.currentStageKey || "approval",
        assignedBy: employeeCode,
        requisitionCode: code
      }
    );

    const inserted = await client.query(
      `INSERT INTO rm_headcount_change_history (
        change_id, requisition_code, old_headcount, requested_headcount,
        change_type, reason, status, requested_by, workflow_instance_id
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING *`,
      [
        changeId,
        code,
        currentHeadcount,
        requestedHeadcount,
        changeType,
        reason,
        HEADCOUNT_CHANGE_STATUS.PENDING,
        user.name,
        instance.instanceId
      ]
    );

    await writeEnterpriseAudit(client, {
      eventType: "RequisitionHeadcountChangeRequested",
      module: "Recruitment Management",
      entity: "Requisition",
      entityId: code,
      action: `Headcount change requested for ${code}: ${currentHeadcount} → ${requestedHeadcount}`,
      previousValue: String(currentHeadcount),
      newValue: String(requestedHeadcount),
      userName: user.name,
      userRole: user.role,
      metadata: {
        change_id: changeId,
        change_type: changeType,
        reason,
        workflow_instance_id: instance.instanceId
      }
    });

    await client.query("COMMIT");

    return {
      change: mapHeadcountChangeRow(inserted.rows[0]),
      toastMessage: `Headcount change request submitted for approval (${changeType}).`
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function applyApprovedHeadcountChange(queryable, changeRow, actorName, req) {
  const user = userContext(req);
  const code = changeRow.requisition_code;
  const requisition = await lockRequisitionForUpdate(queryable, code);
  const approvedOn = new Date();

  await queryable.query(
    `UPDATE rm_requisitions
     SET headcount = $1,
         modified_by = $2,
         modified_on = NOW()
     WHERE requisition_code = $3`,
    [changeRow.requested_headcount, actorName, code]
  );

  if (
    isLegacyDualWriteEnabled() &&
    requisition.req_id &&
    (await tableExists(queryable, "req_mstr"))
  ) {
    await queryable.query(
      `UPDATE req_mstr
       SET openings_count = $1,
           updated_on = CURRENT_TIMESTAMP
       WHERE req_id = $2`,
      [changeRow.requested_headcount, requisition.req_id]
    );
  }

  await queryable.query(
    `UPDATE rm_headcount_change_history
     SET status = $1,
         approved_by = $2,
         approved_on = $3,
         approval_outcome = $4
     WHERE change_id = $5`,
    [
      HEADCOUNT_CHANGE_STATUS.APPROVED,
      actorName,
      approvedOn,
      HEADCOUNT_CHANGE_STATUS.APPROVED,
      changeRow.change_id
    ]
  );

  await writeEnterpriseAudit(queryable, {
    eventType: "RequisitionHeadcountChangeApproved",
    module: "Recruitment Management",
    entity: "Requisition",
    entityId: code,
    action: `Headcount change approved for ${code}: ${changeRow.old_headcount} → ${changeRow.requested_headcount}`,
    previousValue: String(changeRow.old_headcount),
    newValue: String(changeRow.requested_headcount),
    userName: actorName,
    userRole: user.role,
    metadata: {
      change_id: changeRow.change_id,
      change_type: changeRow.change_type,
      workflow_instance_id: changeRow.workflow_instance_id
    }
  });

  return {
    requisition_code: code,
    old_headcount: Number(changeRow.old_headcount),
    new_headcount: Number(changeRow.requested_headcount)
  };
}

async function markHeadcountChangeRejected(queryable, changeRow, actorName, req, comments = "") {
  const user = userContext(req);
  const rejectedOn = new Date();

  await queryable.query(
    `UPDATE rm_headcount_change_history
     SET status = $1,
         rejected_by = $2,
         rejected_on = $3,
         approval_outcome = $4
     WHERE change_id = $5`,
    [
      HEADCOUNT_CHANGE_STATUS.REJECTED,
      actorName,
      rejectedOn,
      HEADCOUNT_CHANGE_STATUS.REJECTED,
      changeRow.change_id
    ]
  );

  await writeEnterpriseAudit(queryable, {
    eventType: "RequisitionHeadcountChangeRejected",
    module: "Recruitment Management",
    entity: "Requisition",
    entityId: changeRow.requisition_code,
    action: `Headcount change rejected for ${changeRow.requisition_code}`,
    previousValue: String(changeRow.old_headcount),
    newValue: String(changeRow.requested_headcount),
    userName: actorName,
    userRole: user.role,
    metadata: {
      change_id: changeRow.change_id,
      comments,
      workflow_instance_id: changeRow.workflow_instance_id
    }
  });

  return {
    change_id: changeRow.change_id,
    requisition_code: changeRow.requisition_code,
    status: HEADCOUNT_CHANGE_STATUS.REJECTED
  };
}

async function handleHeadcountChangeWorkflowCompleted(queryable, event, req) {
  const user = userContext(req);
  const changeId = resolveHeadcountChangeId(event);

  if (!changeId) {
    throw httpError("Headcount change workflow completion missing change id.", 400);
  }

  const changeRow = await lockHeadcountChangeForUpdate(queryable, changeId);

  if (!isPendingHeadcountChangeStatus(changeRow.status)) {
    return {
      businessActionCompleted: true,
      change_id: changeId,
      status: changeRow.status,
      reason: "Headcount change already finalized"
    };
  }

  const applied = await applyApprovedHeadcountChange(
    queryable,
    changeRow,
    user.name,
    req
  );

  return {
    businessActionCompleted: true,
    change_id: changeId,
    status: HEADCOUNT_CHANGE_STATUS.APPROVED,
    ...applied
  };
}

async function handleHeadcountChangeWorkflowRejected(queryable, event, req) {
  const user = userContext(req);
  const changeId = resolveHeadcountChangeId(event);

  if (!changeId) {
    throw httpError("Headcount change workflow rejection missing change id.", 400);
  }

  const changeRow = await lockHeadcountChangeForUpdate(queryable, changeId);

  if (!isPendingHeadcountChangeStatus(changeRow.status)) {
    return {
      businessActionCompleted: true,
      change_id: changeId,
      status: changeRow.status,
      reason: "Headcount change already finalized"
    };
  }

  const result = await markHeadcountChangeRejected(
    queryable,
    changeRow,
    user.name,
    req,
    event.comments || ""
  );

  return {
    businessActionCompleted: true,
    ...result
  };
}

async function handleHeadcountChangeStepActivated(_queryable, _event, _req) {
  return {
    businessActionCompleted: false,
    reason: "Headcount change approval does not alter requisition status on step activation"
  };
}

async function handleHeadcountChangeClarificationRequested(_queryable, _event, _req) {
  return {
    businessActionCompleted: false,
    reason: "Headcount change clarification does not alter requisition status"
  };
}

async function handleHeadcountChangeClarificationSubmitted(_queryable, _event, _req) {
  return {
    businessActionCompleted: false,
    reason: "Headcount change clarification submit does not alter requisition status"
  };
}

module.exports = {
  isHeadcountChangeWorkflowEvent,
  resolveHeadcountChangeId,
  listHeadcountChangeHistory,
  getPendingHeadcountChange,
  requestHeadcountChange,
  handleHeadcountChangeWorkflowCompleted,
  handleHeadcountChangeWorkflowRejected,
  handleHeadcountChangeStepActivated,
  handleHeadcountChangeClarificationRequested,
  handleHeadcountChangeClarificationSubmitted,
  assertValidRequestedHeadcount,
  getCapacityFloor
};
