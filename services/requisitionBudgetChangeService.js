/**
 * Governed post-approval requisition budget changes.
 */

const { REQUISITION_STATUS, isClosedRequisitionStatus } = require("../constants/requisitionStatus");
const {
  BUDGET_CHANGE_STATUS,
  BUDGET_CHANGE_TYPE,
  isPendingBudgetChangeStatus
} = require("../constants/budgetChangeStatus");
const { writeEnterpriseAudit, userContext } = require("./enterpriseAuditService");
const {
  assertRequisitionRequestorOwnerAccess,
  assertCanAssignRecruiters
} = require("./requisitionCapabilityAuth");
const { lockRequisitionForUpdate } = require("./requisitionFulfillmentService");

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

function generateBudgetChangeId() {
  return `BCR-${Date.now()}`;
}

function normalizeBudget(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) {
    throw httpError("requested_budget must be a valid non-negative number.", 400);
  }
  return amount;
}

function isBudgetChangeWorkflowEvent(event = {}) {
  const context = parseContext(event.executionContext);
  const meta = context.meta && typeof context.meta === "object" ? context.meta : {};
  const documentType = String(meta.document_type || "").toUpperCase();
  const instanceId = String(event.instanceId || "");

  return (
    documentType === "BUDGET_CHANGE"
    || Boolean(meta.budget_change_id)
    || instanceId.startsWith("WF-BC-")
  );
}

function resolveBudgetChangeId(event = {}) {
  const context = parseContext(event.executionContext);
  const meta = context.meta && typeof context.meta === "object" ? context.meta : {};
  if (meta.budget_change_id) {
    return String(meta.budget_change_id).trim();
  }
  const instanceId = String(event.instanceId || "");
  if (instanceId.startsWith("WF-BC-")) {
    return instanceId.replace(/^WF-BC-/, "");
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

function mapBudgetChangeRow(row) {
  if (!row) {
    return null;
  }

  return {
    change_id: row.change_id,
    requisition_code: row.requisition_code,
    old_budget: Number(row.old_budget) || 0,
    requested_budget: Number(row.requested_budget) || 0,
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

async function assertCanRequestBudgetChange(pool, req, requisition) {
  try {
    await assertRequisitionRequestorOwnerAccess(pool, req, requisition);
    return;
  } catch (_ownerError) {
    await assertCanAssignRecruiters(pool, req);
  }
}

async function assertCanViewBudgetChanges(pool, req, requisition) {
  await assertCanRequestBudgetChange(pool, req, requisition);
}

async function getOfferBudgetFloor(queryable, requisitionCode) {
  const result = await queryable.query(
    `SELECT COALESCE(MAX(offered_ctc), 0)::numeric AS floor
     FROM om_offers
     WHERE requisition_code = $1
       AND offer_status NOT IN ('Declined', 'Withdrawn')`,
    [requisitionCode]
  );

  return Number(result.rows[0]?.floor) || 0;
}

async function loadApprovedPositionBudget(queryable, approvedPositionId) {
  if (!approvedPositionId) {
    return null;
  }

  const result = await queryable.query(
    `SELECT position_id, budget_approved, remaining_budget, status
     FROM wp_approved_positions
     WHERE position_id = $1`,
    [approvedPositionId]
  );

  return result.rows[0] || null;
}

async function assertValidRequestedBudget(
  queryable,
  requisition,
  requestedBudget
) {
  const requested = normalizeBudget(requestedBudget);
  const current = normalizeBudget(requisition.budget_approved);

  if (requested === current) {
    throw httpError(
      `Requested budget (${requested}) must differ from the current approved budget (${current}).`,
      400
    );
  }

  if (requested > current) {
    const position = await loadApprovedPositionBudget(
      queryable,
      requisition.approved_position_id
    );

    if (position) {
      const positionBudget = Number(position.budget_approved) || 0;
      if (requested > positionBudget) {
        throw httpError(
          `Requested budget (${requested}) exceeds the linked WFP approved position budget (${positionBudget}). Raise an upstream WFP budget request first.`,
          409
        );
      }
    }
  } else {
    const floor = await getOfferBudgetFloor(queryable, requisition.requisition_code);
    if (requested < floor) {
      throw httpError(
        `Requested budget (${requested}) cannot be below the highest active offer CTC (${floor}).`,
        409
      );
    }
  }

  return requested;
}

async function loadBudgetChangeById(queryable, changeId) {
  const result = await queryable.query(
    `SELECT *
     FROM rm_budget_change_history
     WHERE change_id = $1`,
    [changeId]
  );

  return result.rows[0] || null;
}

async function lockBudgetChangeForUpdate(queryable, changeId) {
  const result = await queryable.query(
    `SELECT *
     FROM rm_budget_change_history
     WHERE change_id = $1
     FOR UPDATE`,
    [changeId]
  );

  if (!result.rows[0]) {
    throw httpError(`Budget change request not found: ${changeId}`, 404);
  }

  return result.rows[0];
}

async function getPendingBudgetChange(queryable, requisitionCode) {
  const result = await queryable.query(
    `SELECT *
     FROM rm_budget_change_history
     WHERE requisition_code = $1
       AND status = $2
     ORDER BY requested_on DESC
     LIMIT 1`,
    [requisitionCode, BUDGET_CHANGE_STATUS.PENDING]
  );

  return mapBudgetChangeRow(result.rows[0]);
}

async function listBudgetChangeHistory(pool, requisitionCode, req) {
  const { loadRequisitionByCode } = require("./recruitmentService");
  const requisition = await loadRequisitionByCode(pool, requisitionCode);

  if (!requisition) {
    throw httpError(`Requisition not found: ${requisitionCode}`, 404);
  }

  await assertCanViewBudgetChanges(pool, req, requisition);

  const result = await pool.query(
    `SELECT *
     FROM rm_budget_change_history
     WHERE requisition_code = $1
     ORDER BY requested_on DESC, created_on DESC`,
    [requisitionCode]
  );

  const pending = result.rows.find((row) => isPendingBudgetChangeStatus(row.status)) || null;
  const offerFloor = await getOfferBudgetFloor(pool, requisitionCode);
  const position = await loadApprovedPositionBudget(
    pool,
    requisition.approved_position_id
  );

  return {
    requisition_code: requisitionCode,
    current_budget: normalizeBudget(requisition.budget_approved),
    wfp_position_budget: position ? Number(position.budget_approved) || 0 : null,
    pending_change: mapBudgetChangeRow(pending),
    offer_budget_floor: offerFloor,
    history: result.rows.map(mapBudgetChangeRow)
  };
}

async function requestBudgetChange(pool, requisitionCode, payload, req) {
  const user = userContext(req);
  const { loadRequisitionByCode } = require("./recruitmentService");
  const code = String(requisitionCode || "").trim();
  const reason = String(payload?.reason || "").trim();
  const requestedRaw = payload?.requested_budget;

  if (!code) {
    throw httpError("requisition_code is required.", 400);
  }

  if (!reason) {
    throw httpError("reason is required for a budget change request.", 400);
  }

  if (requestedRaw === undefined || requestedRaw === null || requestedRaw === "") {
    throw httpError("requested_budget is required.", 400);
  }

  const requisition = await loadRequisitionByCode(pool, code);
  if (!requisition) {
    throw httpError(`Requisition not found: ${code}`, 404);
  }

  await assertCanRequestBudgetChange(pool, req, requisition);

  if (requisition.req_status !== REQUISITION_STATUS.APPROVED) {
    throw httpError(
      `Budget change requests are only allowed for Approved requisitions. Current status: ${requisition.req_status}.`,
      400
    );
  }

  if (isClosedRequisitionStatus(requisition.req_status)) {
    throw httpError(`Requisition ${code} is closed and cannot accept budget changes.`, 400);
  }

  if (!String(requisition.approval_route_id || "").trim()) {
    throw httpError(
      `Requisition ${code} has no approval route configured for budget change approval.`,
      400
    );
  }

  const requestedBudget = await assertValidRequestedBudget(pool, requisition, requestedRaw);
  const currentBudget = normalizeBudget(requisition.budget_approved);
  const changeType =
    requestedBudget > currentBudget
      ? BUDGET_CHANGE_TYPE.INCREASE
      : BUDGET_CHANGE_TYPE.REDUCTION;

  const changeId = generateBudgetChangeId();
  const workflowInstanceId = `WF-BC-${changeId}`;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const lockedRequisition = await lockRequisitionForUpdate(client, code);
    const pending = await client.query(
      `SELECT change_id
       FROM rm_budget_change_history
       WHERE requisition_code = $1
         AND status = $2
       LIMIT 1
       FOR UPDATE`,
      [code, BUDGET_CHANGE_STATUS.PENDING]
    );

    if (pending.rows.length) {
      throw httpError(
        `Requisition ${code} already has a pending budget change request.`,
        409
      );
    }

    await assertValidRequestedBudget(client, lockedRequisition, requestedBudget);

    const workflowService = require("./workflowService");
    const instance = await workflowService.startWorkflow(
      client,
      "REQUISITION",
      {
        instance_id: workflowInstanceId,
        meta: {
          document_type: "BUDGET_CHANGE",
          budget_change_id: changeId,
          requisition_id: code,
          old_budget: currentBudget,
          requested_budget: requestedBudget,
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
      `INSERT INTO rm_budget_change_history (
        change_id, requisition_code, old_budget, requested_budget,
        change_type, reason, status, requested_by, workflow_instance_id
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING *`,
      [
        changeId,
        code,
        currentBudget,
        requestedBudget,
        changeType,
        reason,
        BUDGET_CHANGE_STATUS.PENDING,
        user.name,
        instance.instanceId
      ]
    );

    await writeEnterpriseAudit(client, {
      eventType: "RequisitionBudgetChangeRequested",
      module: "Recruitment Management",
      entity: "Requisition",
      entityId: code,
      action: `Budget change requested for ${code}: ${currentBudget} → ${requestedBudget}`,
      previousValue: String(currentBudget),
      newValue: String(requestedBudget),
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
      change: mapBudgetChangeRow(inserted.rows[0]),
      toastMessage: `Budget change request submitted for approval (${changeType}).`
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function syncApprovedPositionBudget(
  queryable,
  requisition,
  oldBudget,
  newBudget,
  actorName,
  changeRow
) {
  const positionId = requisition.approved_position_id;
  if (!positionId || !(await tableExists(queryable, "wp_approved_positions"))) {
    return null;
  }

  const positionResult = await queryable.query(
    `SELECT position_id, status, budget_approved, remaining_budget
     FROM wp_approved_positions
     WHERE position_id = $1
     FOR UPDATE`,
    [positionId]
  );

  const position = positionResult.rows[0];
  if (!position) {
    return null;
  }

  const delta = newBudget - oldBudget;
  const nextRemaining = Math.max(
    Number(position.remaining_budget || 0) + delta,
    0
  );

  await queryable.query(
    `UPDATE wp_approved_positions
     SET budget_approved = $1,
         remaining_budget = $2,
         modified_by = $3,
         modified_on = NOW()
     WHERE position_id = $4`,
    [newBudget, nextRemaining, actorName, positionId]
  );

  if (await tableExists(queryable, "wp_position_lifecycle")) {
    await queryable.query(
      `INSERT INTO wp_position_lifecycle (
        position_id, event_type, from_status, to_status, actor, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        positionId,
        "BudgetAmended",
        position.status || "Active",
        position.status || "Active",
        actorName,
        JSON.stringify({
          requisition_code: requisition.requisition_code,
          change_id: changeRow.change_id,
          old_budget: oldBudget,
          new_budget: newBudget,
          delta
        })
      ]
    );
  }

  return {
    position_id: positionId,
    budget_approved: newBudget,
    remaining_budget: nextRemaining
  };
}

async function applyApprovedBudgetChange(queryable, changeRow, actorName, req) {
  const user = userContext(req);
  const code = changeRow.requisition_code;
  const requisition = await lockRequisitionForUpdate(queryable, code);
  const approvedOn = new Date();
  const oldBudget = normalizeBudget(changeRow.old_budget);
  const newBudget = normalizeBudget(changeRow.requested_budget);

  await queryable.query(
    `UPDATE rm_requisitions
     SET budget_approved = $1,
         modified_by = $2,
         modified_on = NOW()
     WHERE requisition_code = $3`,
    [newBudget, actorName, code]
  );

  const positionSync = await syncApprovedPositionBudget(
    queryable,
    requisition,
    oldBudget,
    newBudget,
    actorName,
    changeRow
  );

  await queryable.query(
    `UPDATE rm_budget_change_history
     SET status = $1,
         approved_by = $2,
         approved_on = $3,
         approval_outcome = $4
     WHERE change_id = $5`,
    [
      BUDGET_CHANGE_STATUS.APPROVED,
      actorName,
      approvedOn,
      BUDGET_CHANGE_STATUS.APPROVED,
      changeRow.change_id
    ]
  );

  await writeEnterpriseAudit(queryable, {
    eventType: "RequisitionBudgetChangeApproved",
    module: "Recruitment Management",
    entity: "Requisition",
    entityId: code,
    action: `Budget change approved for ${code}: ${oldBudget} → ${newBudget}`,
    previousValue: String(oldBudget),
    newValue: String(newBudget),
    userName: actorName,
    userRole: user.role,
    metadata: {
      change_id: changeRow.change_id,
      change_type: changeRow.change_type,
      workflow_instance_id: changeRow.workflow_instance_id,
      position_sync: positionSync
    }
  });

  return {
    requisition_code: code,
    old_budget: oldBudget,
    new_budget: newBudget,
    position_sync: positionSync
  };
}

async function markBudgetChangeRejected(queryable, changeRow, actorName, req, comments = "") {
  const user = userContext(req);
  const rejectedOn = new Date();

  await queryable.query(
    `UPDATE rm_budget_change_history
     SET status = $1,
         rejected_by = $2,
         rejected_on = $3,
         approval_outcome = $4
     WHERE change_id = $5`,
    [
      BUDGET_CHANGE_STATUS.REJECTED,
      actorName,
      rejectedOn,
      BUDGET_CHANGE_STATUS.REJECTED,
      changeRow.change_id
    ]
  );

  await writeEnterpriseAudit(queryable, {
    eventType: "RequisitionBudgetChangeRejected",
    module: "Recruitment Management",
    entity: "Requisition",
    entityId: changeRow.requisition_code,
    action: `Budget change rejected for ${changeRow.requisition_code}`,
    previousValue: String(changeRow.old_budget),
    newValue: String(changeRow.requested_budget),
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
    status: BUDGET_CHANGE_STATUS.REJECTED
  };
}

async function handleBudgetChangeWorkflowCompleted(queryable, event, req) {
  const user = userContext(req);
  const changeId = resolveBudgetChangeId(event);

  if (!changeId) {
    throw httpError("Budget change workflow completion missing change id.", 400);
  }

  const changeRow = await lockBudgetChangeForUpdate(queryable, changeId);

  if (!isPendingBudgetChangeStatus(changeRow.status)) {
    return {
      businessActionCompleted: true,
      change_id: changeId,
      status: changeRow.status,
      reason: "Budget change already finalized"
    };
  }

  const applied = await applyApprovedBudgetChange(
    queryable,
    changeRow,
    user.name,
    req
  );

  return {
    businessActionCompleted: true,
    change_id: changeId,
    status: BUDGET_CHANGE_STATUS.APPROVED,
    ...applied
  };
}

async function handleBudgetChangeWorkflowRejected(queryable, event, req) {
  const user = userContext(req);
  const changeId = resolveBudgetChangeId(event);

  if (!changeId) {
    throw httpError("Budget change workflow rejection missing change id.", 400);
  }

  const changeRow = await lockBudgetChangeForUpdate(queryable, changeId);

  if (!isPendingBudgetChangeStatus(changeRow.status)) {
    return {
      businessActionCompleted: true,
      change_id: changeId,
      status: changeRow.status,
      reason: "Budget change already finalized"
    };
  }

  const result = await markBudgetChangeRejected(
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

async function handleBudgetChangeStepActivated(_queryable, _event, _req) {
  return {
    businessActionCompleted: false,
    reason: "Budget change approval does not alter requisition status on step activation"
  };
}

async function handleBudgetChangeClarificationRequested(_queryable, _event, _req) {
  return {
    businessActionCompleted: false,
    reason: "Budget change clarification does not alter requisition status"
  };
}

async function handleBudgetChangeClarificationSubmitted(_queryable, _event, _req) {
  return {
    businessActionCompleted: false,
    reason: "Budget change clarification submit does not alter requisition status"
  };
}

module.exports = {
  isBudgetChangeWorkflowEvent,
  resolveBudgetChangeId,
  listBudgetChangeHistory,
  getPendingBudgetChange,
  requestBudgetChange,
  handleBudgetChangeWorkflowCompleted,
  handleBudgetChangeWorkflowRejected,
  handleBudgetChangeStepActivated,
  handleBudgetChangeClarificationRequested,
  handleBudgetChangeClarificationSubmitted,
  assertValidRequestedBudget,
  getOfferBudgetFloor
};
