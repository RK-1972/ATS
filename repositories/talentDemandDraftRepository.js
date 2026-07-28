/**
 * Talent Demand Draft — database operations only.
 * Table: td_draft_mstr
 * Private WIP documents; not operational requisitions.
 */

const DRAFT_COLUMNS = `
  draft_id,
  draft_code,
  status,
  owner_employee_code,
  created_by,
  created_on,
  updated_by,
  updated_on,
  is_deleted,
  deleted_by,
  deleted_on,
  row_version,
  approval_route_id,
  approved_position_id,
  result_req_id,
  result_requisition_code,
  client_id,
  client_name,
  project_id,
  project_name,
  job_title,
  job_description,
  primary_skill,
  secondary_skill,
  experience_min,
  experience_max,
  openings_count,
  work_location,
  employment_type,
  priority_level,
  hiring_manager_id,
  hiring_manager,
  target_date,
  recruiter_id
`;

async function createDraft(pool, draftData) {
  const result = await pool.query(
    `INSERT INTO td_draft_mstr (
       draft_code,
       status,
       owner_employee_code,
       created_by,
       created_on,
       updated_by,
       updated_on,
       row_version,
       approval_route_id,
       approved_position_id,
       result_req_id,
       result_requisition_code,
       client_id,
       client_name,
       project_id,
       project_name,
       job_title,
       job_description,
       primary_skill,
       secondary_skill,
       experience_min,
       experience_max,
       openings_count,
       work_location,
       employment_type,
       priority_level,
       hiring_manager_id,
       hiring_manager,
       target_date,
       recruiter_id
     ) VALUES (
       $1, COALESCE($2, 'DRAFT'), $3, $4, NOW(), $4, NOW(), 1,
       $5, $6, $7, $8,
       $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26
     )
     RETURNING ${DRAFT_COLUMNS}`,
    [
      draftData.draft_code,
      draftData.status ?? null,
      draftData.owner_employee_code,
      draftData.created_by,
      draftData.approval_route_id ?? null,
      draftData.approved_position_id ?? null,
      draftData.result_req_id ?? null,
      draftData.result_requisition_code ?? null,
      draftData.client_id ?? null,
      draftData.client_name ?? null,
      draftData.project_id ?? null,
      draftData.project_name ?? null,
      draftData.job_title ?? null,
      draftData.job_description ?? null,
      draftData.primary_skill ?? null,
      draftData.secondary_skill ?? null,
      draftData.experience_min ?? null,
      draftData.experience_max ?? null,
      draftData.openings_count ?? 1,
      draftData.work_location ?? null,
      draftData.employment_type ?? null,
      draftData.priority_level ?? null,
      draftData.hiring_manager_id ?? null,
      draftData.hiring_manager ?? null,
      draftData.target_date ?? null,
      draftData.recruiter_id ?? null
    ]
  );

  return result.rows[0] || null;
}

async function updateDraft(pool, draftId, draftData) {
  const result = await pool.query(
    `UPDATE td_draft_mstr
     SET
       status = COALESCE($2, status),
       updated_by = COALESCE($3, updated_by),
       updated_on = NOW(),
       row_version = row_version + 1,
       approval_route_id = COALESCE($4, approval_route_id),
       approved_position_id = COALESCE($5, approved_position_id),
       client_id = COALESCE($6, client_id),
       client_name = COALESCE($7, client_name),
       project_id = COALESCE($8, project_id),
       project_name = COALESCE($9, project_name),
       job_title = COALESCE($10, job_title),
       job_description = COALESCE($11, job_description),
       primary_skill = COALESCE($12, primary_skill),
       secondary_skill = COALESCE($13, secondary_skill),
       experience_min = COALESCE($14, experience_min),
       experience_max = COALESCE($15, experience_max),
       openings_count = COALESCE($16, openings_count),
       work_location = COALESCE($17, work_location),
       employment_type = COALESCE($18, employment_type),
       priority_level = COALESCE($19, priority_level),
       hiring_manager_id = COALESCE($20, hiring_manager_id),
       hiring_manager = COALESCE($21, hiring_manager),
       target_date = COALESCE($22, target_date),
       recruiter_id = COALESCE($23, recruiter_id)
     WHERE draft_id = $1
       AND is_deleted = FALSE
     RETURNING ${DRAFT_COLUMNS}`,
    [
      draftId,
      draftData.status ?? null,
      draftData.updated_by ?? null,
      draftData.approval_route_id ?? null,
      draftData.approved_position_id ?? null,
      draftData.client_id ?? null,
      draftData.client_name ?? null,
      draftData.project_id ?? null,
      draftData.project_name ?? null,
      draftData.job_title ?? null,
      draftData.job_description ?? null,
      draftData.primary_skill ?? null,
      draftData.secondary_skill ?? null,
      draftData.experience_min ?? null,
      draftData.experience_max ?? null,
      draftData.openings_count ?? null,
      draftData.work_location ?? null,
      draftData.employment_type ?? null,
      draftData.priority_level ?? null,
      draftData.hiring_manager_id ?? null,
      draftData.hiring_manager ?? null,
      draftData.target_date ?? null,
      draftData.recruiter_id ?? null
    ]
  );

  return result.rows[0] || null;
}

/**
 * @param {object} queryable - pg Pool or Client (shared TX handle)
 * @param {string|number} draftId
 * @param {{ forUpdate?: boolean }} [options] - forUpdate locks the row (Submit TX)
 */
async function getDraftById(queryable, draftId, options = {}) {
  const forUpdate = Boolean(options.forUpdate);
  const result = await queryable.query(
    `SELECT ${DRAFT_COLUMNS}
     FROM td_draft_mstr
     WHERE draft_id = $1
       AND is_deleted = FALSE${forUpdate ? " FOR UPDATE" : ""}`,
    [draftId]
  );

  return result.rows[0] || null;
}

async function getDraftByCode(pool, draftCode) {
  const result = await pool.query(
    `SELECT ${DRAFT_COLUMNS}
     FROM td_draft_mstr
     WHERE draft_code = $1
       AND is_deleted = FALSE`,
    [draftCode]
  );

  return result.rows[0] || null;
}

async function listDraftsByOwner(pool, ownerEmployeeCode) {
  const result = await pool.query(
    `SELECT ${DRAFT_COLUMNS}
     FROM td_draft_mstr
     WHERE owner_employee_code = $1
       AND is_deleted = FALSE
     ORDER BY updated_on DESC`,
    [ownerEmployeeCode]
  );

  return result.rows;
}

async function softDeleteDraft(pool, draftId, deletedBy) {
  const result = await pool.query(
    `UPDATE td_draft_mstr
     SET
       is_deleted = TRUE,
       deleted_by = $2,
       deleted_on = NOW(),
       updated_by = $2,
       updated_on = NOW(),
       row_version = row_version + 1
     WHERE draft_id = $1
       AND is_deleted = FALSE
     RETURNING ${DRAFT_COLUMNS}`,
    [draftId, deletedBy ?? null]
  );

  return result.rows[0] || null;
}

/**
 * @param {object} queryable - pg Pool or Client (shared TX handle)
 */
/**
 * Mark draft submitted — only while status is DRAFT and not already linked.
 * Prevents duplicate submit under concurrent transactions (with FOR UPDATE).
 *
 * @param {object} queryable - pg Pool or Client (shared TX handle)
 */
async function markDraftSubmitted(queryable, draftId, submitData) {
  const result = await queryable.query(
    `UPDATE td_draft_mstr
     SET
       status = COALESCE($2, 'SUBMITTED'),
       result_req_id = COALESCE($3, result_req_id),
       result_requisition_code = COALESCE($4, result_requisition_code),
       updated_by = COALESCE($5, updated_by),
       updated_on = NOW(),
       row_version = row_version + 1
     WHERE draft_id = $1
       AND is_deleted = FALSE
       AND UPPER(status) = 'DRAFT'
       AND result_req_id IS NULL
     RETURNING ${DRAFT_COLUMNS}`,
    [
      draftId,
      submitData?.status ?? null,
      submitData?.result_req_id ?? null,
      submitData?.result_requisition_code ?? null,
      submitData?.updated_by ?? null
    ]
  );

  return result.rows[0] || null;
}

module.exports = {
  createDraft,
  updateDraft,
  getDraftById,
  getDraftByCode,
  listDraftsByOwner,
  softDeleteDraft,
  markDraftSubmitted
};
