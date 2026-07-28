/**
 * Talent Demand Draft — business logic only.
 * Persistence via talentDemandDraftRepository.
 * Does not create operational requisitions or invoke approval/workflow.
 */

const talentDemandDraftRepository = require("../repositories/talentDemandDraftRepository");

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
  const { employeeCode } = resolveActor(actor);

  if (!employeeCode) {
    throw httpError("Authenticated employee_code is required to list drafts.", 401);
  }

  return talentDemandDraftRepository.listDraftsByOwner(pool, employeeCode);
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
  deleteDraft,
  submitDraftPreparation
};
