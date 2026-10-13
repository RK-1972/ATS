/**
 * Offer approval workflow safety — cancellation, submission versioning, approve guards.
 * Shared by offerManagementService and workflowService.completeTask.
 */

const {
  isOfferWorkflowEvent,
  resolveOfferId
} = require("./offerWorkflowCompletionService");

const TASK_STATUS_CANCELLED = "Cancelled";
const MIRROR_VERSION_STATUS_PUBLISHED = "Published";
const MIRROR_VERSION_STATUS_SUPERSEDED = "Superseded";
const { assertCanWriteOfferRecord } = require("./offerCapabilityAuth");
const { writeEnterpriseAudit, userContext } = require("./enterpriseAuditService");

const WORKFLOW_STATUS_RUNNING = "Running";
const WORKFLOW_STATUS_PAUSED = "Paused";
const WORKFLOW_STATUS_REJECTED = "Rejected";
const WORKFLOW_STATUS_COMPLETED = "Completed";
const CLARIFICATION_TASK_STATUS = "waiting for clarification";

const SUBMISSION_VERSION_META_KEY = "offer_submission_version";

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function parseExecutionContext(raw) {
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

function readSubmissionVersionFromContext(executionContext) {
  const context = parseExecutionContext(executionContext);
  const meta = context.meta && typeof context.meta === "object" ? context.meta : {};
  const raw = meta[SUBMISSION_VERSION_META_KEY];
  if (raw === null || raw === undefined || raw === "") {
    return null;
  }
  const numeric = Number(raw);
  return Number.isFinite(numeric) ? numeric : null;
}

function buildSubmissionVersionMetaPatch(offerVersion) {
  const version = Number(offerVersion);
  return {
    [SUBMISSION_VERSION_META_KEY]: Number.isFinite(version) ? version : 1
  };
}

function isOfferWorkflowInstanceRow(instanceRow) {
  if (!instanceRow) {
    return false;
  }

  return isOfferWorkflowEvent({
    workflowCode: instanceRow.workflow_code,
    instanceId: instanceRow.instance_id,
    executionContext: instanceRow.execution_context
  });
}

/**
 * Lock offer row and validate it may receive an approval action on the current submission.
 * @returns {object} om_offers row (snake_case)
 */
async function assertOfferApprovalMayProceed(queryable, offerId) {
  const offerResult = await queryable.query(
    `SELECT offer_id, offer_status, version, workflow_instance_id
     FROM om_offers
     WHERE offer_id = $1
     FOR UPDATE`,
    [offerId]
  );

  if (!offerResult.rows[0]) {
    throw httpError(`Offer not found: ${offerId}`, 404);
  }

  const offerRow = offerResult.rows[0];

  if (String(offerRow.offer_status) !== "Pending Approval") {
    throw httpError(
      `Offer is not pending approval (current status: ${offerRow.offer_status}).`,
      409
    );
  }

  if (!offerRow.workflow_instance_id) {
    throw httpError("Offer workflow instance is missing.", 400);
  }

  const instanceResult = await queryable.query(
    `SELECT instance_id, workflow_code, status, execution_context
     FROM wf_instances
     WHERE instance_id = $1
     FOR UPDATE`,
    [offerRow.workflow_instance_id]
  );

  if (!instanceResult.rows[0]) {
    throw httpError(
      `Workflow instance not found: ${offerRow.workflow_instance_id}`,
      404
    );
  }

  const instanceRow = instanceResult.rows[0];

  if (String(instanceRow.status) !== WORKFLOW_STATUS_RUNNING) {
    throw httpError(
      `Workflow instance must be Running to approve (current status: ${instanceRow.status}).`,
      409
    );
  }

  const submissionVersion = readSubmissionVersionFromContext(instanceRow.execution_context);
  const offerVersion = Number(offerRow.version);

  if (
    submissionVersion !== null
    && Number.isFinite(offerVersion)
    && submissionVersion !== offerVersion
  ) {
    throw httpError(
      "This approval task is stale because the offer submission was updated. Refresh and review the latest submission.",
      409
    );
  }

  return { offerRow, instanceRow };
}

/**
 * Cancel pending/waiting approval route tasks and mirror rows; preserve completed history.
 */
async function cancelPendingOfferApprovalWork(
  queryable,
  { offerId, instanceId },
  req = null
) {
  if (!instanceId) {
    throw httpError("workflow instanceId is required to cancel offer approval work.", 400);
  }

  if (req && offerId) {
    await assertCanWriteOfferRecord(queryable, req, offerId);
  }

  await queryable.query(
    `SELECT instance_id
     FROM wf_instances
     WHERE instance_id = $1
     FOR UPDATE`,
    [instanceId]
  );

  if (offerId) {
    await queryable.query(
      `SELECT offer_id
       FROM om_offers
       WHERE offer_id = $1
       FOR UPDATE`,
      [offerId]
    );
  }

  const pendingTasks = await queryable.query(
    `SELECT task_id, status
     FROM wf_tasks
     WHERE instance_id = $1
       AND (
         (
           task_type = 'approval'
           AND title LIKE 'Approval Step %'
           AND LOWER(status) IN ('pending', 'waiting')
         )
         OR (
           LOWER(COALESCE(task_type, '')) = 'clarification'
           AND LOWER(status) IN ('pending', 'waiting', 'waiting for clarification')
         )
       )
     ORDER BY task_id ASC
     FOR UPDATE`,
    [instanceId]
  );

  const cancelledTaskIds = [];

  for (const row of pendingTasks.rows) {
    await queryable.query(
      `UPDATE wf_tasks
       SET status = $2, completed_on = NOW()
       WHERE task_id = $1`,
      [row.task_id, TASK_STATUS_CANCELLED]
    );
    cancelledTaskIds.push(row.task_id);
  }

  if (cancelledTaskIds.length > 0) {
    await queryable.query(
      `UPDATE wf_assignments
       SET active = FALSE
       WHERE task_id = ANY($1::int[])
         AND active = TRUE`,
      [cancelledTaskIds]
    );
  }

  let cancelledApprovalRows = 0;

  if (offerId) {
    const mirrorResult = await queryable.query(
      `UPDATE om_offer_approvals
       SET approval_status = 'Cancelled'
       WHERE offer_id = $1
         AND approval_status IN ('Pending', 'Waiting')
         AND version_status = $2
       RETURNING approval_id`,
      [offerId, MIRROR_VERSION_STATUS_PUBLISHED]
    );
    cancelledApprovalRows = mirrorResult.rows.length;
  }

  return {
    cancelledTaskIds,
    cancelledApprovalRows
  };
}

/**
 * Guard for workflow completeTask on OFFER approval steps.
 */
async function assertOfferApprovalTaskMayComplete(queryable, instanceRow, task) {
  if (!isOfferWorkflowInstanceRow(instanceRow)) {
    return null;
  }

  if (String(task.task_type || "").toLowerCase() !== "approval") {
    return null;
  }

  const offerId = resolveOfferId({
    instanceId: instanceRow.instance_id,
    executionContext: instanceRow.execution_context
  });

  if (!offerId) {
    throw httpError("Offer id missing from workflow context.", 400);
  }

  return assertOfferApprovalMayProceed(queryable, offerId);
}

/**
 * Block correction while workflow clarification is open (paused instance or held task).
 */
async function assertNoOpenOfferClarification(queryable, instanceId) {
  const instanceResult = await queryable.query(
    `SELECT instance_id, status, execution_context
     FROM wf_instances
     WHERE instance_id = $1`,
    [instanceId]
  );

  const instanceRow = instanceResult.rows[0];
  if (!instanceRow) {
    throw httpError(`Workflow instance not found: ${instanceId}`, 404);
  }

  if (String(instanceRow.status) === WORKFLOW_STATUS_PAUSED) {
    throw httpError(
      "Offer correction is blocked until the open clarification is resolved.",
      409
    );
  }

  const context = parseExecutionContext(instanceRow.execution_context);
  const hold = context.clarification;
  if (hold && hold.task_id) {
    const held = await queryable.query(
      `SELECT status FROM wf_tasks WHERE task_id = $1`,
      [hold.task_id]
    );
    const heldStatus = String(held.rows[0]?.status || "").toLowerCase();
    if (heldStatus === CLARIFICATION_TASK_STATUS) {
      throw httpError(
        "Offer correction is blocked until the open clarification is resolved.",
        409
      );
    }
  }

  const openClarificationTasks = await queryable.query(
    `SELECT task_id
     FROM wf_tasks
     WHERE instance_id = $1
       AND LOWER(COALESCE(task_type, '')) = 'clarification'
       AND LOWER(status) NOT IN ('completed', 'cancelled')
     LIMIT 1`,
    [instanceId]
  );

  if (openClarificationTasks.rows.length) {
    throw httpError(
      "Offer correction is blocked until the open clarification is resolved.",
      409
    );
  }
}

/**
 * Lock and validate a pending-approval correction on the current submission version.
 */
async function assertOfferCorrectionMayProceed(queryable, offerId) {
  const offerResult = await queryable.query(
    `SELECT *
     FROM om_offers
     WHERE offer_id = $1
     FOR UPDATE`,
    [offerId]
  );

  if (!offerResult.rows[0]) {
    throw httpError(`Offer not found: ${offerId}`, 404);
  }

  const offerRow = offerResult.rows[0];

  if (String(offerRow.offer_status) !== "Pending Approval") {
    throw httpError(
      `Only pending approval offers may be corrected (current status: ${offerRow.offer_status}).`,
      409
    );
  }

  if (!offerRow.workflow_instance_id) {
    throw httpError("Offer workflow instance is missing.", 400);
  }

  const instanceResult = await queryable.query(
    `SELECT instance_id, workflow_code, status, execution_context
     FROM wf_instances
     WHERE instance_id = $1
     FOR UPDATE`,
    [offerRow.workflow_instance_id]
  );

  if (!instanceResult.rows[0]) {
    throw httpError(
      `Workflow instance not found: ${offerRow.workflow_instance_id}`,
      404
    );
  }

  const instanceRow = instanceResult.rows[0];

  if (String(instanceRow.status) !== WORKFLOW_STATUS_RUNNING) {
    throw httpError(
      `Workflow instance must be Running to correct (current status: ${instanceRow.status}).`,
      409
    );
  }

  await assertNoOpenOfferClarification(queryable, offerRow.workflow_instance_id);

  const submissionVersion = readSubmissionVersionFromContext(instanceRow.execution_context);
  const offerVersion = Number(offerRow.version);

  if (
    submissionVersion !== null
    && Number.isFinite(offerVersion)
    && submissionVersion !== offerVersion
  ) {
    throw httpError(
      "This offer submission is out of date. Refresh and retry correction on the latest version.",
      409
    );
  }

  return { offerRow, instanceRow };
}

/**
 * Lock and validate an approved-but-unreleased commercial amendment on the current submission.
 */
async function assertOfferAmendmentMayProceed(queryable, offerId) {
  const offerResult = await queryable.query(
    `SELECT *
     FROM om_offers
     WHERE offer_id = $1
     FOR UPDATE`,
    [offerId]
  );

  if (!offerResult.rows[0]) {
    throw httpError(`Offer not found: ${offerId}`, 404);
  }

  const offerRow = offerResult.rows[0];

  if (String(offerRow.offer_status) !== "Approved") {
    throw httpError(
      `Only approved offers that have not been released may be amended (current status: ${offerRow.offer_status}).`,
      409
    );
  }

  if (!offerRow.workflow_instance_id) {
    throw httpError("Offer workflow instance is missing.", 400);
  }

  const instanceResult = await queryable.query(
    `SELECT instance_id, workflow_code, status, execution_context
     FROM wf_instances
     WHERE instance_id = $1
     FOR UPDATE`,
    [offerRow.workflow_instance_id]
  );

  if (!instanceResult.rows[0]) {
    throw httpError(
      `Workflow instance not found: ${offerRow.workflow_instance_id}`,
      404
    );
  }

  const instanceRow = instanceResult.rows[0];
  const instanceStatus = String(instanceRow.status || "");

  if (
    instanceStatus !== WORKFLOW_STATUS_RUNNING
    && instanceStatus !== WORKFLOW_STATUS_COMPLETED
  ) {
    throw httpError(
      `Workflow instance cannot accept amendment (current status: ${instanceRow.status}).`,
      409
    );
  }

  await assertNoOpenOfferClarification(queryable, offerRow.workflow_instance_id);

  const submissionVersion = readSubmissionVersionFromContext(instanceRow.execution_context);
  const offerVersion = Number(offerRow.version);

  if (
    submissionVersion !== null
    && Number.isFinite(offerVersion)
    && submissionVersion !== offerVersion
  ) {
    throw httpError(
      "This offer submission is out of date. Refresh and retry amendment on the latest version.",
      409
    );
  }

  return { offerRow, instanceRow };
}

/**
 * Ensure the offer is approved on the current submission with no open approval steps.
 */
async function assertCurrentSubmissionFullyApproved(queryable, offerId) {
  const offerResult = await queryable.query(
    `SELECT offer_id, offer_status, version, workflow_instance_id
     FROM om_offers
     WHERE offer_id = $1
     FOR UPDATE`,
    [offerId]
  );

  if (!offerResult.rows[0]) {
    throw httpError(`Offer not found: ${offerId}`, 404);
  }

  const offerRow = offerResult.rows[0];

  if (String(offerRow.offer_status) !== "Approved") {
    throw httpError(
      `Offer must be approved on the current submission before release or letter generation (status: ${offerRow.offer_status}).`,
      409
    );
  }

  if (!offerRow.workflow_instance_id) {
    throw httpError("Offer workflow instance is missing.", 400);
  }

  const instanceResult = await queryable.query(
    `SELECT instance_id, status, execution_context
     FROM wf_instances
     WHERE instance_id = $1
     FOR UPDATE`,
    [offerRow.workflow_instance_id]
  );

  const instanceRow = instanceResult.rows[0];
  if (!instanceRow) {
    throw httpError(
      `Workflow instance not found: ${offerRow.workflow_instance_id}`,
      404
    );
  }

  const submissionVersion = readSubmissionVersionFromContext(instanceRow.execution_context);
  const offerVersion = Number(offerRow.version);

  if (
    submissionVersion !== null
    && Number.isFinite(offerVersion)
    && submissionVersion !== offerVersion
  ) {
    throw httpError(
      "This offer submission is out of date. Complete approval on the latest submission before release.",
      409
    );
  }

  const openMirror = await queryable.query(
    `SELECT COUNT(*) AS count
     FROM om_offer_approvals
     WHERE offer_id = $1
       AND approval_status IN ('Pending', 'Waiting')
       AND version_status = $2
       AND version = $3`,
    [offerId, MIRROR_VERSION_STATUS_PUBLISHED, offerVersion]
  );

  if (Number(openMirror.rows[0]?.count || 0) > 0) {
    throw httpError(
      "All approval steps on the current submission must be completed before release or letter generation.",
      409
    );
  }

  if (String(instanceRow.status) !== WORKFLOW_STATUS_COMPLETED) {
    throw httpError(
      `Approval workflow must be completed on the current submission (instance status: ${instanceRow.status}).`,
      409
    );
  }

  return { offerRow, instanceRow };
}

async function cancelPendingOfferInboxTasks(queryable, offerId) {
  await queryable.query(
    `UPDATE et_tasks
     SET status = 'Completed',
         completed_by = 'System',
         completed_on = NOW(),
         modified_on = NOW()
     WHERE module = 'Offer Management'
       AND business_object_id = $1
       AND status = 'Pending'
       AND (
         workflow_task_id IS NOT NULL
         OR task_type ILIKE 'Approval Step%'
       )`,
    [offerId]
  );
}

/**
 * Replace pending/waiting mirror rows while keeping completed approval history.
 */
async function refreshOfferApprovalMirrorPreservingApproved(
  queryable,
  offerId,
  approvalRouteId,
  submissionVersion
) {
  const approvalRouteRepository = require("../repositories/approvalRouteRepository");
  const version = Number(submissionVersion);
  const normalizedVersion = Number.isFinite(version) ? version : 1;

  await queryable.query(
    `UPDATE om_offer_approvals
     SET version_status = $2
     WHERE offer_id = $1
       AND version_status = $3`,
    [offerId, MIRROR_VERSION_STATUS_SUPERSEDED, MIRROR_VERSION_STATUS_PUBLISHED]
  );

  await queryable.query(
    `DELETE FROM om_offer_approvals
     WHERE offer_id = $1
       AND approval_status IN ('Pending', 'Waiting', 'Cancelled')
       AND version_status = $2`,
    [offerId, MIRROR_VERSION_STATUS_SUPERSEDED]
  );

  const steps = await approvalRouteRepository.getApprovalRouteSteps(
    queryable,
    approvalRouteId
  );

  if (!steps.length) {
    throw httpError("Approval route has no steps to publish.", 400);
  }

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    const sequence = step.sequence_no ?? step.step_no ?? index + 1;
    const stepTitle = `Approval Step ${sequence} — ${offerId}`;

    await queryable.query(
      `INSERT INTO om_offer_approvals (
        offer_id, approval_step, approver_role, approval_status, sequence_order,
        version, version_status, effective_from
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        offerId,
        stepTitle,
        step.approval_type || "Approver",
        index === 0 ? "Pending" : "Waiting",
        sequence,
        normalizedVersion,
        MIRROR_VERSION_STATUS_PUBLISHED,
        new Date()
      ]
    );
  }
}

/**
 * Terminate an in-flight offer workflow when the recruiter discards the request.
 */
async function terminateOfferWorkflowForRecruiterWithdrawal(
  queryable,
  { offerId, instanceId },
  req,
  { reason }
) {
  if (!instanceId) {
    return { terminated: false };
  }

  const user = userContext(req);
  const instanceResult = await queryable.query(
    `SELECT instance_id, status, instance_payload, execution_context
     FROM wf_instances
     WHERE instance_id = $1
     FOR UPDATE`,
    [instanceId]
  );

  const instance = instanceResult.rows[0];
  if (!instance) {
    return { terminated: false };
  }

  const status = String(instance.status || "");
  if (status === WORKFLOW_STATUS_COMPLETED || status === WORKFLOW_STATUS_REJECTED) {
    return { terminated: false, status };
  }

  await cancelPendingOfferApprovalWork(queryable, { offerId, instanceId }, null);
  await cancelPendingOfferInboxTasks(queryable, offerId);

  await queryable.query(
    `UPDATE wf_assignments a
     SET active = FALSE
     FROM wf_tasks t
     WHERE a.task_id = t.task_id
       AND t.instance_id = $1
       AND a.active = TRUE`,
    [instanceId]
  );

  let payload = parseExecutionContext(instance.instance_payload);
  if (!payload || typeof payload !== "object") {
    payload = {};
  }
  if (!Array.isArray(payload.stages)) {
    payload.stages = [];
  }
  if (!Array.isArray(payload.timeline)) {
    payload.timeline = [];
  }

  payload.timeline.push({
    id: `tl-${Date.now()}`,
    time: new Date().toISOString(),
    actor: user.name,
    role: user.role,
    action: "Offer withdrawn by recruiter",
    event_type: "withdrawn",
    comment: reason || null,
    outcome: "Withdrawn"
  });

  await queryable.query(
    `UPDATE wf_instances
     SET status = $2,
         instance_payload = $3,
         completed_on = NOW(),
         modified_by = $4,
         modified_on = NOW()
     WHERE instance_id = $1`,
    [instanceId, WORKFLOW_STATUS_REJECTED, JSON.stringify(payload), user.name]
  );

  await writeEnterpriseAudit(queryable, {
    eventType: "WorkflowWithdrawn",
    module: "Workflow Engine",
    entity: "Workflow Instance",
    entityId: String(instanceId),
    action: "Offer approval workflow terminated after recruiter discard",
    previousValue: status,
    newValue: WORKFLOW_STATUS_REJECTED,
    userName: user.name,
    userRole: user.role,
    metadata: { offer_id: offerId, reason: reason || null }
  });

  return { terminated: true, status: WORKFLOW_STATUS_REJECTED };
}

module.exports = {
  MIRROR_VERSION_STATUS_PUBLISHED,
  MIRROR_VERSION_STATUS_SUPERSEDED,
  SUBMISSION_VERSION_META_KEY,
  buildSubmissionVersionMetaPatch,
  readSubmissionVersionFromContext,
  assertOfferApprovalMayProceed,
  assertOfferCorrectionMayProceed,
  assertOfferAmendmentMayProceed,
  assertCurrentSubmissionFullyApproved,
  assertNoOpenOfferClarification,
  cancelPendingOfferApprovalWork,
  cancelPendingOfferInboxTasks,
  refreshOfferApprovalMirrorPreservingApproved,
  terminateOfferWorkflowForRecruiterWithdrawal,
  assertOfferApprovalTaskMayComplete,
  isOfferWorkflowInstanceRow
};
