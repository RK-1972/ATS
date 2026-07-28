/**
 * Talent Demand Submit — orchestration only.
 *
 * Coordinates existing Draft, Requisition, and Workflow services for the
 * Submit Draft business transaction.
 *
 * No SQL. No Express route handling. No repository implementation.
 */

const talentDemandDraftService = require("./talentDemandDraftService");
const talentDemandDraftRepository = require("../repositories/talentDemandDraftRepository");
const recruitmentService = require("./recruitmentService");
const workflowService = require("./workflowService");

const { DRAFT_STATUS } = talentDemandDraftService;

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function isBlank(value) {
  return value === null || value === undefined || String(value).trim() === "";
}

/**
 * Build a request-like actor context for downstream Optalynx services
 * that expect req.user (recruitment / workflow).
 */
function buildActorRequest(employeeCode, req) {
  if (req && req.user) {
    return req;
  }

  return {
    user: {
      employee_code: employeeCode,
      full_name: employeeCode,
      role_name: "Recruiter"
    }
  };
}

/**
 * Step 2 — Validate submit readiness beyond ownership/status.
 */
function assertSubmitReadiness(draft, rowVersion) {
  const errors = [];

  if (draft.result_req_id || draft.result_requisition_code) {
    throw httpError("Draft has already been submitted.", 409);
  }

  if (
    rowVersion !== undefined &&
    rowVersion !== null &&
    Number(draft.row_version) !== Number(rowVersion)
  ) {
    throw httpError(
      "Draft was modified by another session. Reload and try again.",
      409
    );
  }

  if (isBlank(draft.approved_position_id)) {
    errors.push(
      "approved_position_id is required to create an operational requisition."
    );
  }

  if (isBlank(draft.approval_route_id)) {
    errors.push("approval_route_id is required before submit.");
  }

  if (isBlank(draft.client_name)) {
    errors.push("client_name is required before submit.");
  }

  if (isBlank(draft.job_title)) {
    errors.push("job_title is required before submit.");
  }

  if (isBlank(draft.primary_skill)) {
    errors.push("primary_skill is required before submit.");
  }

  if (isBlank(draft.work_location)) {
    errors.push("work_location is required before submit.");
  }

  if (isBlank(draft.employment_type)) {
    errors.push("employment_type is required before submit.");
  }

  if (isBlank(draft.priority_level)) {
    errors.push("priority_level is required before submit.");
  }

  if (isBlank(draft.target_date)) {
    errors.push("target_date is required before submit.");
  }

  if (
    draft.experience_min != null &&
    draft.experience_max != null &&
    Number(draft.experience_min) > Number(draft.experience_max)
  ) {
    errors.push("experience_min cannot be greater than experience_max.");
  }

  if (errors.length > 0) {
    throw httpError(errors.join(" "), 400);
  }
}

/**
 * Step 3 — Map draft document fields to the existing requisition create payload.
 */
function prepareRequisitionPayload(draft) {
  return {
    approved_position_id: draft.approved_position_id,
    client_id: draft.client_id,
    client_name: draft.client_name,
    project_id: draft.project_id,
    project_name: draft.project_name,
    job_title: draft.job_title,
    job_description: draft.job_description,
    primary_skill: draft.primary_skill,
    secondary_skill: draft.secondary_skill,
    experience_min: draft.experience_min,
    experience_max: draft.experience_max,
    openings_count: draft.openings_count,
    work_location: draft.work_location,
    employment_type: draft.employment_type,
    priority_level: draft.priority_level,
    hiring_manager_id: draft.hiring_manager_id,
    hiring_manager: draft.hiring_manager,
    target_date: draft.target_date,
    recruiter_id: draft.recruiter_id,
    approval_route_id: draft.approval_route_id,
    route_id: draft.approval_route_id
  };
}

/**
 * Submit Draft orchestration — single ACID transaction.
 *
 * Acquires ONE client, BEGIN, passes the same queryable handle through
 * Draft → Recruitment → Workflow → Draft Repository, then COMMIT/ROLLBACK.
 *
 * @param {object} pool - PostgreSQL pool
 * @param {string|number} draftId
 * @param {string} employeeCode - submitting actor
 * @param {number|null|undefined} rowVersion - optional optimistic lock token
 * @param {object|null} req - optional Express request for downstream userContext
 * @returns {Promise<object>} unified submit result
 */
async function submitDraft(pool, draftId, employeeCode, rowVersion, req = null) {
  if (draftId === null || draftId === undefined || String(draftId).trim() === "") {
    throw httpError("draftId is required.", 400);
  }

  if (isBlank(employeeCode)) {
    throw httpError("employeeCode is required.", 401);
  }

  const actorReq = buildActorRequest(employeeCode, req);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // ------------------------------------------------------------------
    // 1. Validate draft ownership and status
    // ------------------------------------------------------------------
    const preparation = await talentDemandDraftService.submitDraftPreparation(
      client,
      draftId,
      { employee_code: employeeCode }
    );

    if (!preparation.valid) {
      const status = preparation.draft ? 400 : 404;
      throw httpError(
        (preparation.errors || ["Draft is not ready for submit."]).join(" "),
        status
      );
    }

    const draft = preparation.draft;

    // ------------------------------------------------------------------
    // 2. Validate submit readiness
    // ------------------------------------------------------------------
    assertSubmitReadiness(draft, rowVersion);

    // ------------------------------------------------------------------
    // 3. Prepare requisition payload from draft
    // ------------------------------------------------------------------
    const requisitionPayload = prepareRequisitionPayload(draft);

    // ------------------------------------------------------------------
    // 4. Invoke existing requisition creation service
    //    (createFromApprovedPosition also starts the REQUISITION workflow)
    // ------------------------------------------------------------------
    const requisitionResult =
      await recruitmentService.handleLegacyCreateRequisition(
        client,
        requisitionPayload,
        actorReq
      );

    const requisitionCode =
      requisitionResult.requisitionId ||
      requisitionResult.requisition?.requisition_code ||
      requisitionResult.legacyRequisition?.req_code ||
      null;

    const reqId =
      requisitionResult.legacyRequisition?.req_id ||
      requisitionResult.requisition?.req_id ||
      null;

    const workflowInstanceId =
      requisitionResult.requisition?.workflow_instance_id || null;

    // ------------------------------------------------------------------
    // 5. Invoke existing workflow/approval service
    //    Resolve the instance started by requisition create; if absent,
    //    start REQUISITION workflow (idempotent when instance_id exists).
    // ------------------------------------------------------------------
    let workflow = null;

    if (workflowInstanceId) {
      workflow = await workflowService.getInstanceById(
        client,
        workflowInstanceId
      );
    } else if (requisitionCode) {
      workflow = await workflowService.startWorkflow(
        client,
        "REQUISITION",
        {
          instance_id: `WF-RM-${requisitionCode}`,
          meta: {
            process_id: `WF-RM-${requisitionCode}`,
            document_type: "REQUISITION",
            requisition_id: requisitionCode,
            source_draft_id: draft.draft_id,
            source_draft_code: draft.draft_code,
            approved_position_id: draft.approved_position_id
          }
        },
        actorReq
      );
    }

    const workflowInstanceIdResolved =
      workflow?.instanceId || workflowInstanceId || null;

    // ------------------------------------------------------------------
    // 5b. Expand approval_route_step into workflow tasks/assignments
    //     (same client / transaction — no notifications)
    // ------------------------------------------------------------------
    let approvalTasks = [];

    if (workflowInstanceIdResolved && draft.approval_route_id) {
      approvalTasks =
        await workflowService.createApprovalRouteWorkflowTasks(
          client,
          workflowInstanceIdResolved,
          draft.approval_route_id,
          {
            stageKey: workflow?.currentStageKey || "approval",
            assignedBy: employeeCode,
            requisitionCode
          }
        );
    }

    // ------------------------------------------------------------------
    // 6. Mark draft as SUBMITTED (existing repository method — no SQL here)
    // ------------------------------------------------------------------
    const submittedDraft = await talentDemandDraftRepository.markDraftSubmitted(
      client,
      draftId,
      {
        status: DRAFT_STATUS.SUBMITTED,
        result_req_id: reqId,
        result_requisition_code: requisitionCode,
        updated_by: employeeCode
      }
    );

    if (!submittedDraft) {
      throw httpError(
        "Draft was already submitted or is no longer in DRAFT status.",
        409
      );
    }

    await client.query("COMMIT");

    // ------------------------------------------------------------------
    // 7. Unified result object
    // ------------------------------------------------------------------
    return {
      draft: submittedDraft,
      requisition: requisitionResult.requisition || null,
      legacyRequisition: requisitionResult.legacyRequisition || null,
      workflow,
      approval_tasks: approvalTasks,
      req_id: reqId,
      requisition_code: requisitionCode,
      workflow_instance_id: workflowInstanceIdResolved,
      toastMessage:
        requisitionResult.toastMessage ||
        `Draft ${draft.draft_code} submitted as ${requisitionCode}.`
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (_rollbackError) {
      // Preserve the original orchestration error.
    }
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  submitDraft,
  prepareRequisitionPayload,
  assertSubmitReadiness
};
