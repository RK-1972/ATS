/**
 * Talent Demand Draft — business logic only.
 * Persistence via talentDemandDraftRepository.
 * Does not create operational requisitions or invoke approval/workflow.
 */

const talentDemandDraftRepository = require("../repositories/talentDemandDraftRepository");
const {
  assertApprovedPositionUpdateIntegrity
} = require("../utils/approvedPositionUpdateIntegrity");
const {
  resolveRequisitionRequestorCreatedByKeys,
  assertRequisitionRequestorOwnerAccess,
  assertCanCreateRequisition
} = require("./requisitionCapabilityAuth");
const requisitionFieldResolutionService = require("./requisitionFieldResolutionService");
const { loadRequisitionByCode } = require("./recruitmentService");
const { REQUISITION_STATUS, isClosedRequisitionStatus } = require("../constants/requisitionStatus");
const { collectOpeningsCountErrors } = require("../utils/nonNegativeNumericValidation");

const DRAFT_STATUS = {
  DRAFT: "DRAFT",
  SUBMITTED: "SUBMITTED",
  ARCHIVED: "ARCHIVED"
};

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function assertDraftOpeningsCount(formData) {
  if (formData?.openings_count === undefined || formData?.openings_count === "") {
    return;
  }

  const errors = collectOpeningsCountErrors(formData.openings_count);
  if (errors.length) {
    throw httpError(errors[0], 400);
  }
}

function resolveActor(actor) {
  if (!actor) {
    return { employeeCode: null, actorName: null };
  }

  if (typeof actor === "string") {
    return { employeeCode: actor, actorName: actor };
  }

  const employeeCode =
    actor.employee_code || actor.owner_employee_code || actor.created_by || null;
  const actorName = actor.full_name || actor.name || employeeCode;

  return { employeeCode, actorName };
}

function assertOwner(draft, employeeCode) {
  if (!draft) {
    throw httpError("Draft not found.", 404);
  }

  if (
    String(draft.owner_employee_code || "") !== String(employeeCode || "")
  ) {
    throw httpError("You do not have access to this draft.", 403);
  }
}

function generateDraftCode() {
  const year = new Date().getFullYear();
  const suffix = String(Date.now()).slice(-8);
  return `TD-DRAFT-${year}-${suffix}`;
}

function buildDraftPayload(formData = {}, actor) {
  const { employeeCode, actorName } = resolveActor(actor);

  return {
    draft_code: formData.draft_code || generateDraftCode(),
    status: formData.status || DRAFT_STATUS.DRAFT,
    owner_employee_code: formData.owner_employee_code || employeeCode,
    created_by: formData.created_by || actorName || employeeCode,
    updated_by: formData.updated_by || actorName || employeeCode,
    approval_route_id: formData.approval_route_id ?? null,
    approved_position_id: formData.approved_position_id ?? null,
    result_req_id: formData.result_req_id ?? null,
    result_requisition_code: formData.result_requisition_code ?? null,
    client_id: formData.client_id ?? null,
    client_name: formData.client_name ?? null,
    project_id: formData.project_id ?? null,
    project_name: formData.project_name ?? null,
    job_title: formData.job_title ?? null,
    job_description: formData.job_description ?? null,
    primary_skill: formData.primary_skill ?? null,
    secondary_skill: formData.secondary_skill ?? null,
    experience_min: formData.experience_min ?? null,
    experience_max: formData.experience_max ?? null,
    openings_count: formData.openings_count ?? 1,
    work_location: formData.work_location ?? null,
    employment_type: formData.employment_type ?? null,
    priority_level: formData.priority_level ?? null,
    hiring_manager_id: formData.hiring_manager_id ?? null,
    hiring_manager: formData.hiring_manager ?? null,
    target_date: formData.target_date ?? null,
    recruiter_id: formData.recruiter_id ?? null
  };
}

async function createDraft(pool, formData, actor) {
  const { employeeCode } = resolveActor(actor);

  if (!employeeCode) {
    throw httpError("Authenticated employee_code is required to create a draft.", 401);
  }

  const approvedPositionId = String(formData?.approved_position_id || "").trim();
  if (!approvedPositionId) {
    throw httpError(
      "approved_position_id is required to start Talent Demand from an approved workforce position.",
      400
    );
  }

  await assertCanCreateRequisition(pool, { user: actor });
  await requisitionFieldResolutionService.assertApprovedPositionSelectable(
    pool,
    approvedPositionId
  );

  assertDraftOpeningsCount(formData);

  const payload = buildDraftPayload(formData, actor);

  if (!payload.owner_employee_code || !payload.created_by) {
    throw httpError("owner_employee_code and created_by are required.", 400);
  }

  payload.status = DRAFT_STATUS.DRAFT;

  return talentDemandDraftRepository.createDraft(pool, payload);
}

async function updateDraft(pool, draftId, formData, actor) {
  const { employeeCode, actorName } = resolveActor(actor);

  if (!employeeCode) {
    throw httpError("Authenticated employee_code is required to update a draft.", 401);
  }

  const existing = await talentDemandDraftRepository.getDraftById(pool, draftId);
  assertOwner(existing, employeeCode);

  if (String(existing.status).toUpperCase() !== DRAFT_STATUS.DRAFT) {
    throw httpError("Only drafts in DRAFT status can be updated.", 400);
  }

  await assertApprovedPositionUpdateIntegrity(pool, {
    existingApprovedPositionId: existing.approved_position_id,
    payload: formData || {},
    existingRequisitionCode: existing.result_requisition_code
  });

  assertDraftOpeningsCount(formData);

  const payload = {
    ...formData,
    updated_by: actorName || employeeCode,
    status: DRAFT_STATUS.DRAFT
  };

  const updated = await talentDemandDraftRepository.updateDraft(
    pool,
    draftId,
    payload
  );

  if (!updated) {
    throw httpError("Draft could not be updated.", 404);
  }

  return updated;
}

async function getDraft(pool, draftId, actor) {
  const { employeeCode } = resolveActor(actor);

  if (!employeeCode) {
    throw httpError("Authenticated employee_code is required to view a draft.", 401);
  }

  const draft = await talentDemandDraftRepository.getDraftById(pool, draftId);
  assertOwner(draft, employeeCode);

  return draft;
}

async function listMyDrafts(pool, actor) {
  const work = await listMyTalentDemandWork(pool, actor);
  return work.drafts;
}

/**
 * Link an in-progress draft to an existing operational requisition (legacy catalogue row).
 * Does not submit for approval or create workflow tasks.
 */
async function linkDraftToOpenRequisition(
  pool,
  draftId,
  requisitionCode,
  actor,
  req
) {
  const { employeeCode, actorName } = resolveActor(actor);

  if (!employeeCode) {
    throw httpError("Authenticated employee_code is required.", 401);
  }

  const code = String(requisitionCode || "").trim();
  if (!code) {
    return null;
  }

  const existing = await talentDemandDraftRepository.getDraftById(pool, draftId);
  assertOwner(existing, employeeCode);

  if (String(existing.status || "").toUpperCase() !== DRAFT_STATUS.DRAFT) {
    throw httpError("Only drafts in DRAFT status can be linked.", 400);
  }

  const currentLink = String(existing.result_requisition_code || "").trim();
  if (currentLink && currentLink !== code) {
    throw httpError(
      "Draft is already linked to a different requisition.",
      409
    );
  }

  const requisition = await loadRequisitionByCode(pool, code);
  if (!requisition) {
    throw httpError(`Requisition not found: ${code}`, 404);
  }

  if (!req) {
    throw httpError(
      "Authenticated request context is required to link a draft to a requisition.",
      401
    );
  }
  await assertRequisitionRequestorOwnerAccess(pool, req, requisition);

  const draftPositionId = String(existing.approved_position_id || "").trim();
  const requisitionPositionId = String(requisition.approved_position_id || "").trim();
  if (
    !draftPositionId ||
    !requisitionPositionId ||
    draftPositionId !== requisitionPositionId
  ) {
    throw httpError(
      "approved_position_id on the draft must match the requisition before linking.",
      400
    );
  }

  if (currentLink === code) {
    return existing;
  }

  const updated = await talentDemandDraftRepository.linkDraftToRequisitionCode(
    pool,
    draftId,
    code,
    actorName || employeeCode
  );

  if (updated) {
    return updated;
  }

  const refreshed = await talentDemandDraftRepository.getDraftById(pool, draftId);
  if (
    refreshed &&
    String(refreshed.result_requisition_code || "").trim() === code
  ) {
    return refreshed;
  }

  throw httpError("Draft could not be linked to the requisition.", 400);
}

async function listLegacyInProgressRequisitions(pool, actor, req) {
  const { employeeCode } = resolveActor(actor);

  if (!employeeCode) {
    throw httpError("Authenticated employee_code is required to list work.", 401);
  }

  const ownerKeys = req
    ? await resolveRequisitionRequestorCreatedByKeys(pool, req)
    : [employeeCode];

  if (!ownerKeys.length) {
    return [];
  }

  const result = await pool.query(
    `SELECT
       r.requisition_code,
       r.approved_position_id,
       r.position_title,
       r.business_unit AS client_name,
       r.req_status,
       r.modified_on,
       r.created_by
     FROM rm_requisitions r
     WHERE r.requestor_submitted_on IS NULL
       AND r.created_by = ANY($1::text[])
       AND LOWER(COALESCE(r.req_status, '')) NOT IN ('approved', 'rejected')
       AND NOT EXISTS (
         SELECT 1
         FROM td_draft_mstr d
         WHERE d.approved_position_id = r.approved_position_id
           AND d.owner_employee_code = $2
           AND d.is_deleted = FALSE
           AND UPPER(COALESCE(d.status, 'DRAFT')) = 'DRAFT'
       )
     ORDER BY r.modified_on DESC NULLS LAST, r.requisition_code ASC`,
    [ownerKeys, employeeCode]
  );

  return result.rows
    .filter((row) => !isClosedRequisitionStatus(String(row.req_status || "").trim()))
    .filter(
      (row) =>
        String(row.req_status || "").trim() !== REQUISITION_STATUS.APPROVED &&
        String(row.req_status || "").trim() !== REQUISITION_STATUS.REJECTED
    )
    .map((row) => ({
      work_item_type: "requisition",
      requisition_code: row.requisition_code,
      approved_position_id: row.approved_position_id,
      job_title: row.position_title,
      client_name: row.client_name,
      status: row.req_status || REQUISITION_STATUS.OPEN,
      updated_on: row.modified_on,
      updated_by: row.created_by
    }));
}

/**
 * Draft documents plus legacy unsubmitted requisitions for the current requestor.
 */
async function listMyTalentDemandWork(pool, actor, req = null) {
  const { employeeCode } = resolveActor(actor);

  if (!employeeCode) {
    throw httpError("Authenticated employee_code is required to list work.", 401);
  }

  const draftRows = await talentDemandDraftRepository.listDraftsByOwner(
    pool,
    employeeCode
  );

  const drafts = draftRows.map((row) => ({
    ...row,
    work_item_type: "draft"
  }));

  const requisitionsInProgress = req
    ? await listLegacyInProgressRequisitions(pool, actor, req)
    : [];

  return {
    drafts,
    requisitions_in_progress: requisitionsInProgress
  };
}

async function deleteDraft(pool, draftId, actor) {
  const { employeeCode, actorName } = resolveActor(actor);

  if (!employeeCode) {
    throw httpError("Authenticated employee_code is required to delete a draft.", 401);
  }

  const existing = await talentDemandDraftRepository.getDraftById(pool, draftId);
  assertOwner(existing, employeeCode);

  if (String(existing.status).toUpperCase() !== DRAFT_STATUS.DRAFT) {
    throw httpError("Only drafts in DRAFT status can be deleted.", 400);
  }

  const deleted = await talentDemandDraftRepository.softDeleteDraft(
    pool,
    draftId,
    actorName || employeeCode
  );

  if (!deleted) {
    throw httpError("Draft could not be deleted.", 404);
  }

  return deleted;
}

/**
 * Pre-submit business checks only.
 * Does not create requisitions, invoke approval, or change operational tables.
 *
 * @param {object} queryable - pg Pool or Client (shared TX handle)
 */
async function submitDraftPreparation(queryable, draftId, actor) {
  const { employeeCode } = resolveActor(actor);
  const errors = [];

  if (!employeeCode) {
    return {
      valid: false,
      errors: ["Authenticated employee_code is required."],
      draft: null
    };
  }

  // Lock draft row for the Submit transaction (queryable is the TX client).
  const draft = await talentDemandDraftRepository.getDraftById(
    queryable,
    draftId,
    { forUpdate: true }
  );

  if (!draft) {
    errors.push("Draft does not exist or has been deleted.");
    return {
      valid: false,
      errors,
      draft: null
    };
  }

  if (String(draft.owner_employee_code || "") !== String(employeeCode)) {
    errors.push("Draft does not belong to the current user.");
  }

  if (draft.is_deleted === true) {
    errors.push("Draft is deleted.");
  }

  if (String(draft.status || "").toUpperCase() !== DRAFT_STATUS.DRAFT) {
    errors.push("Draft status does not allow submit.");
  }

  return {
    valid: errors.length === 0,
    errors,
    draft
  };
}

module.exports = {
  DRAFT_STATUS,
  createDraft,
  updateDraft,
  getDraft,
  listMyDrafts,
  listMyTalentDemandWork,
  linkDraftToOpenRequisition,
  deleteDraft,
  submitDraftPreparation
};
