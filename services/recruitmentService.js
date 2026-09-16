const businessRulesService = require("./businessRulesService");
const workflowService = require("./workflowService");
const masterDataService = require("./masterDataService");
const { writeEnterpriseAudit, userContext } = require("./enterpriseAuditService");
const { isLegacyDualWriteEnabled } = require("../config/operationalCutover");
const { REQUISITION_STATUS, isClosedRequisitionStatus } = require("../constants/requisitionStatus");
const {
  assertRequisitionOpenForRecruiting,
  enrichRequisitionsWithFulfillment,
  getFulfillmentForRequisition
} = require("./requisitionFulfillmentService");
const {
  assertCanCreateRequisition,
  assertCanAssignRecruiters,
  assertCanPublishToCandidatePortal,
  assertRequisitionRequestorOwnerAccess
} = require("./requisitionCapabilityAuth");
const candidateAccessService = require("./candidateAccessService");
const candidateService = require("./candidateService");
const legacyPipelineReadService = require("./legacyPipelineReadService");
const pipelineHistoryService = require("./pipelineHistoryService");
const { resolveGovernedAtsStage } = require("./atsStageWriteValidator");
const {
  CANDIDATE_PORTAL_INTERVIEW_MICRO_STATE_PATTERN,
  inferCatalogStageCodeFromOperationalStage,
  buildCandidateFacingStageResolver
} = require("./candidatePortalStageResolver");

const SEED_PATH = require("path").join(__dirname, "..", "seed", "recruitment.seed.json");

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

/**
 * Recruiter assignment write gate — delegates to canonical requisitionCapabilityAuth rule.
 */
async function assertCanAssignRecruiter(pool, req) {
  await assertCanAssignRecruiters(pool, req);
}

/**
 * Enterprise map gate: caller must have an active recruiter assignment on the
 * target requisition (same rule as GET /my-requisitions / recruiter workspace).
 */
async function assertRecruiterAssignedToRequisition(pool, req, requisition) {
  const employeeCode = recruiterEmployeeCode(req);

  const assignment = await pool.query(
    `SELECT assignment_id
     FROM rm_recruiter_assignments
     WHERE recruiter_code = $1
       AND is_active = true
       AND (
         requisition_code = $2
         OR ($3::int IS NOT NULL AND req_id = $3)
       )
     LIMIT 1`,
    [
      employeeCode,
      requisition.requisition_code,
      requisition.req_id || null
    ]
  );

  if (!assignment.rows.length) {
    throw httpError(
      "Enterprise Access Denied. You are not assigned to this requisition.",
      403
    );
  }
}

function clonePayload(payload) {
  return JSON.parse(JSON.stringify(payload));
}

function getDefaultSeedPayload() {
  return clonePayload(require(SEED_PATH));
}

function nowIso() {
  return new Date().toISOString();
}

async function tableExists(pool, tableName) {
  const result = await pool.query(
    `SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = $1
    ) AS exists`,
    [tableName]
  );
  return Boolean(result.rows[0]?.exists);
}

async function loadPlatformConfig(pool) {
  const result = await pool.query(
    "SELECT published_payload FROM pc_config_state WHERE id = 1"
  );
  return result.rows[0]?.published_payload || null;
}

async function assertRecruitmentModuleEnabled(platformConfig) {
  const recruitmentModule = platformConfig?.modules?.find((item) => item.key === "recruitment");
  if (platformConfig && recruitmentModule && !recruitmentModule.enabled) {
    throw httpError("Recruitment module is disabled in Platform Configuration.", 400);
  }
}

async function loadApprovedPosition(pool, positionId) {
  const result = await pool.query(
    "SELECT * FROM wp_approved_positions WHERE position_id = $1",
    [positionId]
  );
  return result.rows[0] || null;
}

const RECRUITMENT_MASTER_DATA_CHECKS = [
  { field: "department", entityType: "departments" },
  { field: "grade", entityType: "grades" },
  // Geography masters use cities / work_locations — entity type "locations" does not exist.
  { field: "location", entityType: "cities", alternateEntityTypes: ["work_locations"] },
  { field: "primary_skill", entityType: "skills", allowMultiple: true },
  { field: "secondary_skill", entityType: "skills", allowMultiple: true },
  { field: "employment_type", entityType: "employment_types" },
  { field: "source_type", entityType: "candidate_sources" },
  { field: "business_unit", entityType: "business_units" }
];

function splitMasterDataFieldTokens(value) {
  if (!value) {
    return [];
  }

  return String(value)
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);
}

function normalizeMasterLookupKey(value) {
  return String(value)
    .toLowerCase()
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function masterRecordMatchesValue(records, value) {
  const key = normalizeMasterLookupKey(value);
  if (!key) {
    return true;
  }

  return records.some((row) => {
    const nameKey = normalizeMasterLookupKey(row.name);
    const codeKey = normalizeMasterLookupKey(row.code);

    if (key === nameKey || key === codeKey) {
      return true;
    }

    return (
      nameKey.includes(key) ||
      key.includes(nameKey) ||
      codeKey.includes(key) ||
      key.includes(codeKey)
    );
  });
}

async function validateMasterDataFields(pool, data, checks) {
  const errors = [];

  for (const check of checks) {
    const value = data[check.field];
    if (!value) {
      continue;
    }

    const entityTypes = [
      check.entityType,
      ...(check.alternateEntityTypes || [])
    ];
    const tokens = check.allowMultiple
      ? splitMasterDataFieldTokens(value)
      : [String(value).trim()];

    for (const token of tokens) {
      let matched = false;

      for (const entityType of entityTypes) {
        const records = await masterDataService.listByEntityType(pool, entityType);
        if (masterRecordMatchesValue(records, token)) {
          matched = true;
          break;
        }
      }

      if (!matched) {
        errors.push(
          `"${token}" not found in Master Data (${entityTypes.join(" / ")}).`
        );
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

async function validateMasterDataReferences(pool, data) {
  return validateMasterDataFields(pool, data, RECRUITMENT_MASTER_DATA_CHECKS);
}

async function evaluateRecruitmentRules(pool, context, req) {
  return businessRulesService.simulateRules(pool, context, req);
}

async function generateRequisitionCode(pool) {
  const today = new Date();
  const day = String(today.getDate()).padStart(2, "0");
  const month = String(today.getMonth() + 1).padStart(2, "0");
  const year = String(today.getFullYear()).slice(-2);
  const datePrefix = `REQ${day}${month}${year}`;

  const countResult = await pool.query(
    `SELECT COUNT(*) AS total FROM rm_requisitions
     WHERE requisition_code LIKE $1`,
    [`REQ-${today.getFullYear()}-%`]
  );

  const runningNumber = parseInt(countResult.rows[0].total, 10) + 1187;
  return `REQ-${today.getFullYear()}-${runningNumber}`;
}

async function allocateReqId(pool) {
  const result = await pool.query(
    `SELECT GREATEST(
      COALESCE((SELECT MAX(req_id) FROM rm_requisitions WHERE req_id IS NOT NULL), 0),
      COALESCE((SELECT MAX(req_id) FROM req_mstr), 0)
    ) + 1 AS next_id`
  );

  return result.rows[0].next_id;
}

async function allocateMapId(pool) {
  const result = await pool.query(
    `SELECT GREATEST(
      COALESCE((SELECT MAX(map_id) FROM rm_candidate_mappings WHERE map_id IS NOT NULL), 0),
      COALESCE((SELECT MAX(map_id) FROM candidate_req_map), 0)
    ) + 1 AS next_id`
  );

  return result.rows[0].next_id;
}

async function insertLegacyRequisition(pool, position, requisitionCode, user, approvalRouteId = null) {
  if (!isLegacyDualWriteEnabled() || !(await tableExists(pool, "req_mstr"))) {
    return null;
  }

  const today = new Date();
  const day = String(today.getDate()).padStart(2, "0");
  const month = String(today.getMonth() + 1).padStart(2, "0");
  const year = String(today.getFullYear()).slice(-2);
  const legacyCode = requisitionCode.replace(/^REQ-/, "REQ");

  const result = await pool.query(
    `INSERT INTO req_mstr (
      req_code, client_name, project_name, job_title, job_description,
      primary_skill, secondary_skill, experience_min, experience_max,
      openings_count, work_location, employment_type, priority_level,
      req_status, recruiter_id, hiring_manager, target_date, created_by,
      approval_route_id
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
    RETURNING *`,
    [
      legacyCode,
      position.business_unit || "Internal",
      position.department,
      position.position_title,
      `Enterprise requisition from approved position ${position.position_id}`,
      position.primary_skill || null,
      null,
      null,
      null,
      position.headcount || 1,
      position.location || null,
      position.employment_type || null,
      "High",
      REQUISITION_STATUS.OPEN,
      null,
      position.hiring_manager || "Hiring Manager",
      position.expiry_date || null,
      user.name,
      approvalRouteId
    ]
  );

  return result.rows[0];
}

async function getRecruitmentBundle(pool) {
  const hasLegacyReq = await tableExists(pool, "req_mstr");

  const requisitions = await pool.query(
    hasLegacyReq
      ? `SELECT r.*,
          p.position_title AS approved_position_title,
          p.department AS approved_department,
          p.grade AS approved_grade,
          p.headcount AS approved_headcount,
          p.expiry_date AS approved_expiry_date,
          p.remaining_budget AS approved_remaining_budget,
          lm.job_description AS legacy_job_description,
          lm.secondary_skill AS legacy_secondary_skill,
          lm.experience_min AS legacy_experience_min,
          lm.experience_max AS legacy_experience_max,
          lm.priority_level AS legacy_priority_level,
          lm.target_date AS legacy_target_date,
          lm.client_name AS legacy_client_name,
          lm.project_name AS legacy_project_name,
          lm.hiring_manager AS legacy_hiring_manager,
          lm.work_location AS legacy_work_location,
          lm.employment_type AS legacy_employment_type,
          lm.primary_skill AS legacy_primary_skill
         FROM rm_requisitions r
         LEFT JOIN wp_approved_positions p ON r.approved_position_id = p.position_id
         LEFT JOIN req_mstr lm ON lm.req_id = r.req_id
         ORDER BY r.created_on DESC`
      : `SELECT r.*,
          p.position_title AS approved_position_title,
          p.department AS approved_department,
          p.grade AS approved_grade,
          p.headcount AS approved_headcount,
          p.expiry_date AS approved_expiry_date,
          p.remaining_budget AS approved_remaining_budget
         FROM rm_requisitions r
         LEFT JOIN wp_approved_positions p ON r.approved_position_id = p.position_id
         ORDER BY r.created_on DESC`
  );

  const assignments = await pool.query(
    `SELECT * FROM rm_recruiter_assignments WHERE is_active = true ORDER BY assigned_on DESC`
  );

  const pipeline = await pool.query(
    `SELECT * FROM rm_candidate_mappings WHERE is_active = true ORDER BY applied_on DESC`
  );

  return {
    requisitions: requisitions.rows,
    recruiterAssignments: assignments.rows,
    pipeline: pipeline.rows,
    summary: {
      openRequisitions: requisitions.rows.filter((row) =>
        /open|pending|approved/i.test(row.req_status)
      ).length,
      activeCandidates: pipeline.rows.length
    }
  };
}

function recruiterEmployeeCode(req) {
  const code = req.user?.employee_code;
  if (!code) {
    throw httpError("Authenticated employee_code is required.", 401);
  }
  return code;
}

function isAdminUser(req) {
  return String(req.user?.role_name || "").trim() === "Admin";
}

async function resolveMappingContext(pool, mapId) {
  let mapping = null;
  let legacyRow = null;

  const byMapId = await pool.query(
    `SELECT *
     FROM rm_candidate_mappings
     WHERE map_id = $1
       AND is_active = TRUE
     ORDER BY modified_on DESC NULLS LAST
     LIMIT 1`,
    [mapId]
  );
  mapping = byMapId.rows[0] || null;

  if (!mapping) {
    const byMappingId = await pool.query(
      "SELECT * FROM rm_candidate_mappings WHERE mapping_id = $1",
      [mapId]
    );
    mapping = byMappingId.rows[0] || null;
  }

  if (await tableExists(pool, "candidate_req_map")) {
    const legacy = await pool.query(
      "SELECT * FROM candidate_req_map WHERE map_id = $1",
      [mapId]
    );
    legacyRow = legacy.rows[0] || null;

    if (!mapping && legacyRow) {
      const byLegacy = await pool.query(
        "SELECT * FROM rm_candidate_mappings WHERE map_id = $1",
        [mapId]
      );
      mapping = byLegacy.rows[0] || null;
    }
  }

  if (!mapping && !legacyRow) {
    throw httpError("Mapping not found.", 404);
  }

  return { mapping, legacyRow };
}

async function resolveRequisitionForMapping(pool, mapping, legacyRow) {
  if (mapping?.requisition_code) {
    const reqResult = await pool.query(
      "SELECT * FROM rm_requisitions WHERE requisition_code = $1",
      [mapping.requisition_code]
    );
    if (reqResult.rows[0]) {
      return reqResult.rows[0];
    }
  }

  const reqId = mapping?.req_id || legacyRow?.req_id;
  if (reqId) {
    const reqResult = await pool.query(
      "SELECT * FROM rm_requisitions WHERE req_id = $1",
      [reqId]
    );
    if (reqResult.rows[0]) {
      return reqResult.rows[0];
    }
  }

  return null;
}

async function assertAuthorizedStageUpdate(pool, req, mapId) {
  const context = await resolveMappingContext(pool, mapId);

  if (isAdminUser(req)) {
    return context;
  }

  const requisition = await resolveRequisitionForMapping(
    pool,
    context.mapping,
    context.legacyRow
  );

  if (!requisition) {
    throw httpError(
      "Enterprise Access Denied. Requisition context not found for this mapping.",
      403
    );
  }

  await assertRecruiterAssignedToRequisition(pool, req, requisition);
  return context;
}

async function assertAuthorizedMappingAccess(pool, req, mapId) {
  const context = await resolveMappingContext(pool, mapId);
  const candidateId = context.mapping?.candidate_id || context.legacyRow?.candidate_id;

  if (!candidateId) {
    throw httpError("Mapping not found.", 404);
  }

  if (isAdminUser(req)) {
    return context;
  }

  try {
    await candidateAccessService.assertCandidateReadAccess(pool, req, candidateId);
    return context;
  } catch (readError) {
    if (readError.status && readError.status !== 403) {
      throw readError;
    }
  }

  const requisition = await resolveRequisitionForMapping(
    pool,
    context.mapping,
    context.legacyRow
  );

  if (!requisition) {
    throw httpError(
      "Enterprise Access Denied. You are not authorized to view this mapping.",
      403
    );
  }

  await assertRecruiterAssignedToRequisition(pool, req, requisition);
  return context;
}

async function assertAuthorizedRelease(pool, req, candidateId) {
  if (isAdminUser(req)) {
    return;
  }

  const employeeCode = recruiterEmployeeCode(req);

  const candResult = await pool.query(
    `SELECT candidate_id, owner_employee_code
     FROM cand_mstr
     WHERE candidate_id = $1`,
    [candidateId]
  );
  const candRow = candResult.rows[0];

  if (!candRow) {
    throw httpError("Candidate not found.", 404);
  }

  if (String(candRow.owner_employee_code || "").trim() === employeeCode) {
    return;
  }

  const activeEnterprise = await pool.query(
    `SELECT requisition_code, req_id
     FROM rm_candidate_mappings
     WHERE candidate_id = $1
       AND is_active = true
     ORDER BY applied_on DESC
     LIMIT 1`,
    [candidateId]
  );

  const mappingRow = activeEnterprise.rows[0];
  if (mappingRow) {
    const requisition = await resolveRequisitionForMapping(pool, mappingRow, null);
    if (requisition) {
      await assertRecruiterAssignedToRequisition(pool, req, requisition);
      return;
    }
  }

  throw httpError(
    "Enterprise Access Denied. You are not authorized to release this candidate mapping.",
    403
  );
}

async function listTalentPoolCandidates(pool, req) {
  const employeeCode = String(req.user?.employee_code || "").trim();

  if (!employeeCode) {
    throw httpError("Authenticated employee_code is required.", 401);
  }

  const result = await pool.query(
    `SELECT
        'AVAILABLE' AS candidate_type,
        cm.candidate_id,
        cm.candidate_code,
        cm.first_name,
        cm.middle_name,
        cm.last_name,
        cm.preferred_name,
        cm.email_id,
        cm.mobile_number,
        cm.primary_skill,
        cm.total_experience,
        cm.current_company,
        cm.current_location,
        cm.candidate_status,
        cm.created_on
     FROM cand_mstr cm
     WHERE cm.candidate_container = 'TALENT_POOL'
     ORDER BY cm.created_on DESC`
  );

  return result.rows;
}

async function listMyPipelineCandidates(pool, req) {
  const employeeCode = String(req.user?.employee_code || "").trim();

  if (!employeeCode) {
    throw httpError("Authenticated employee_code is required.", 401);
  }

  return legacyPipelineReadService.listMyCandidatesList(pool, employeeCode);
}

async function listCandidateEducation(pool, candidateId, req) {
  await candidateAccessService.assertCandidateReadAccess(pool, req, candidateId);

  return candidateService.listChildRecords(pool, "education", candidateId);
}

async function listCandidateExperience(pool, candidateId, req) {
  await candidateAccessService.assertCandidateReadAccess(pool, req, candidateId);

  return candidateService.listChildRecords(pool, "experience", candidateId);
}

async function getCandidateOwnership(pool, candidateId, req) {
  await candidateAccessService.assertCandidateReadAccess(pool, req, candidateId);

  const recruiterId = String(req.user?.employee_code || "").trim();

  const result = await pool.query(
    `SELECT
        c.candidate_id,
        c.owner_employee_code,
        u.full_name,
        CASE
          WHEN c.candidate_container = 'TALENT_POOL'
            AND c.owner_employee_code IS NULL
          THEN NULL
          WHEN c.owner_employee_code IS NULL
          THEN NULL
          ELSE CONCAT(
            u.full_name,
            ' (',
            u.employee_code,
            ')'
          )
        END AS owner_display_name,
        CASE
          WHEN c.candidate_container = 'TALENT_POOL'
            AND c.owner_employee_code IS NULL
          THEN FALSE
          ELSE (c.owner_employee_code IS NOT NULL AND c.owner_employee_code = $2)
        END AS is_owner,
        EXISTS (
          SELECT 1
          FROM rm_candidate_transfer_requests r
          WHERE r.candidate_id = c.candidate_id
            AND r.status = 'Pending'
            AND r.to_recruiter_id = $2
        ) AS pending_request
     FROM cand_mstr c
     LEFT JOIN user_mstr u
       ON u.employee_code = c.owner_employee_code
     WHERE c.candidate_id = $1`,
    [candidateId, recruiterId]
  );

  if (result.rows.length === 0) {
    throw httpError("Candidate not found.", 404);
  }

  return result.rows[0];
}

async function getCandidateWorkspaceProfile(pool, candidateId, req) {
  await candidateAccessService.assertCandidateReadAccess(pool, req, candidateId);

  const result = await pool.query(
    `SELECT *
     FROM cand_mstr
     WHERE candidate_id = $1`,
    [candidateId]
  );

  const row = result.rows[0] || null;

  if (!row) {
    throw httpError("Candidate not found.", 404);
  }

  const addressResult = await pool.query(
    `SELECT country_code, state_code, city_code, address_line_1
     FROM can_address
     WHERE candidate_id = $1
       AND address_type = 'Current'
       AND active_flag = TRUE
     ORDER BY address_id DESC
     LIMIT 1`,
    [candidateId]
  );

  const address = addressResult.rows[0] || null;

  const master = {
    ...row,
    country_code: row.current_country || address?.country_code || null,
    state_code: row.current_state || address?.state_code || null,
    city_code: row.current_city || address?.city_code || null,
    address_line: address?.address_line_1 || null,
    alternate_phone: row.alternate_mobile || null
  };

  const mappingResult = await pool.query(
    `SELECT
        c.candidate_id,
        c.candidate_code,
        c.first_name,
        c.last_name,
        c.email_id,
        c.pan_number,
        c.mobile_number,
        c.primary_skill,
        c.total_experience,
        c.candidate_status,
        c.resume_path,
        crm.map_id,
        crm.req_id,
        crm.requisition_code AS req_code,
        crm.stage_name,
        crm.source_type,
        crm.remarks
     FROM cand_mstr c
     LEFT JOIN rm_candidate_mappings crm
       ON c.candidate_id = crm.candidate_id
      AND crm.is_active = true
     WHERE c.candidate_id = $1
     ORDER BY crm.map_id DESC
     LIMIT 1`,
    [candidateId]
  );

  const mapping = mappingResult.rows[0] || null;

  return {
    master,
    mapping
  };
}

async function listPipelineHistoryForMapping(pool, mapId, req) {
  const { mapping, legacyRow } = await assertAuthorizedMappingAccess(pool, req, mapId);
  const candidateId = mapping?.candidate_id || legacyRow?.candidate_id;
  const mappingId = mapping?.mapping_id || null;

  const result = await pool.query(
    `SELECT history_id, requisition_code, mapping_id, candidate_id, event_type,
            from_stage, to_stage, actor, actor_role, comments, created_on
     FROM rm_pipeline_history
     WHERE candidate_id = $1
       AND (
         ($2::int IS NOT NULL AND mapping_id = $2)
         OR mapping_id IS NULL
       )
     ORDER BY created_on DESC
     LIMIT 200`,
    [candidateId, mappingId]
  );

  return result.rows;
}

function formatDateOnly(value) {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }

  const text = String(value);
  return text.length >= 10 ? text.slice(0, 10) : text;
}

function mapDashboardInterviewRow(row) {
  return {
    interviewId: row.interview_id,
    scheduleId: row.schedule_id,
    mapId: row.map_id,
    reqId: row.req_id,
    requisitionCode: row.requisition_code,
    candidateId: row.candidate_id,
    candidateCode: row.candidate_code,
    candidateName: row.candidate_name,
    roundNo: row.round_no,
    roundType: row.round_type,
    interviewDate: formatDateOnly(row.interview_date),
    interviewTime: row.interview_time,
    interviewStatus: row.interview_status,
    workflowInstanceId: row.workflow_instance_id,
    meetingLink: row.meeting_link,
    feedbackSubmitted: row.feedback_submitted,
    finalOutcome: row.final_outcome,
    remarks: row.remarks,
    requisition_code: row.requisition_code,
    interview_date: formatDateOnly(row.interview_date)
  };
}

function mapDashboardTaskRow(row) {
  return {
    taskId: row.task_id,
    module: row.module,
    taskType: row.task_type,
    title: row.title,
    status: row.status,
    priority: row.priority,
    assignee: row.assignee,
    assigneeRole: row.assignee_role,
    assignee_role: row.assignee_role,
    dueAt: row.due_at?.toISOString?.() || null,
    slaHours: row.sla_hours,
    escalated: row.escalated,
    escalatedTo: row.escalated_to,
    workflowInstanceId: row.workflow_instance_id,
    workflowTaskId: row.workflow_task_id,
    businessObjectType: row.business_object_type,
    businessObjectId: row.business_object_id,
    metadata: row.metadata || {},
    createdBy: row.created_by,
    createdOn: row.created_on?.toISOString?.() || null,
    completedOn: row.completed_on?.toISOString?.() || null
  };
}

function toDateOnly(value) {
  if (!value) return null;
  if (typeof value === "string") return value.slice(0, 10);
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return formatLocalDateOnly(value);
  }
  return null;
}

function formatLocalDateOnly(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function resolveDashboardDateRange(req) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const toDefault = formatLocalDateOnly(today);
  const fromDefaultDate = new Date(today);
  fromDefaultDate.setDate(fromDefaultDate.getDate() - 29);

  const fromDate = toDateOnly(req.query?.fromDate) || formatLocalDateOnly(fromDefaultDate);
  const toDate = toDateOnly(req.query?.toDate) || toDefault;

  if (fromDate > toDate) {
    return { fromDate: toDate, toDate: fromDate };
  }

  return { fromDate, toDate };
}

function emptyPipelineStageCounts() {
  return {
    Applied: 0,
    Screening: 0,
    "L1 Interview": 0,
    "L2 Interview": 0,
    "Client Interview": 0,
    Offer: 0,
    Joined: 0
  };
}

function normalizeStageSql(column) {
  return `CASE
    WHEN LOWER(COALESCE(${column}, '')) LIKE '%applied%' THEN 'Applied'
    WHEN LOWER(COALESCE(${column}, '')) LIKE '%screen%' THEN 'Screening'
    WHEN LOWER(COALESCE(${column}, '')) ~ '(l1|level 1|technical)' THEN 'L1 Interview'
    WHEN LOWER(COALESCE(${column}, '')) ~ '(l2|level 2)' THEN 'L2 Interview'
    WHEN LOWER(COALESCE(${column}, '')) LIKE '%client%' THEN 'Client Interview'
    WHEN LOWER(COALESCE(${column}, '')) LIKE '%offer%' THEN 'Offer'
    WHEN LOWER(COALESCE(${column}, '')) LIKE '%join%' THEN 'Joined'
    ELSE 'Applied'
  END`;
}

function mergeStageCountRows(rows) {
  const counts = emptyPipelineStageCounts();
  rows.forEach((row) => {
    const stage = row.stage;
    if (counts[stage] !== undefined) {
      counts[stage] = Number(row.count) || 0;
    }
  });
  return counts;
}

function mergeReqPeriodMetrics(rows) {
  const byReq = {};
  rows.forEach((row) => {
    const code = row.requisition_code;
    if (!byReq[code]) {
      byReq[code] = { stageCounts: emptyPipelineStageCounts(), candidatesEntered: 0 };
    }
    if (row.metric_type === "applied") {
      const count = Number(row.count) || 0;
      byReq[code].stageCounts.Applied = count;
      byReq[code].candidatesEntered = count;
      return;
    }
    const stage = row.stage;
    if (stage && byReq[code].stageCounts[stage] !== undefined) {
      byReq[code].stageCounts[stage] = Number(row.count) || 0;
    }
  });
  return byReq;
}

async function getMyRecruiterDashboard(pool, req) {
  const employeeCode = recruiterEmployeeCode(req);
  const { fromDate, toDate } = resolveDashboardDateRange(req);
  const stageSql = normalizeStageSql("h.to_stage");

  const assignments = await pool.query(
    `SELECT *
     FROM rm_recruiter_assignments
     WHERE recruiter_code = $1 AND is_active = true
     ORDER BY assigned_on DESC`,
    [employeeCode]
  );

  const requisitions = await pool.query(
    `SELECT DISTINCT r.*,
      p.position_title AS approved_position_title,
      p.department AS approved_department,
      hm.hiring_manager_name,
      hm.email_id AS hiring_manager_email
     FROM rm_requisitions r
     INNER JOIN rm_recruiter_assignments a
       ON a.requisition_code = r.requisition_code
     LEFT JOIN wp_approved_positions p ON r.approved_position_id = p.position_id
     LEFT JOIN hiring_manager_mstr hm ON hm.hiring_manager_id = r.hiring_manager_id
     WHERE a.recruiter_code = $1 AND a.is_active = true
     ORDER BY r.created_on DESC`,
    [employeeCode]
  );

  const pipelineEntered = await pool.query(
    `SELECT m.*,
      c.candidate_code,
      CONCAT(c.first_name, ' ', c.last_name) AS candidate_name
     FROM rm_candidate_mappings m
     INNER JOIN rm_recruiter_assignments a
       ON a.requisition_code = m.requisition_code
     LEFT JOIN cand_mstr c ON c.candidate_id = m.candidate_id
     WHERE a.recruiter_code = $1
       AND a.is_active = true
       AND m.is_active = true
       AND DATE(m.applied_on) >= $2::date
       AND DATE(m.applied_on) <= $3::date
     ORDER BY m.applied_on DESC`,
    [employeeCode, fromDate, toDate]
  );

  const activePipeline = await pool.query(
    `WITH active_mapping_ids AS (
       SELECT DISTINCT m.mapping_id
       FROM rm_candidate_mappings m
       INNER JOIN rm_recruiter_assignments a
         ON a.requisition_code = m.requisition_code
       WHERE a.recruiter_code = $1
         AND a.is_active = true
         AND m.is_active = true
         AND DATE(m.applied_on) >= $2::date
         AND DATE(m.applied_on) <= $3::date

       UNION

       SELECT DISTINCT h.mapping_id
       FROM rm_pipeline_history h
       INNER JOIN rm_recruiter_assignments a
         ON a.requisition_code = h.requisition_code
       WHERE a.recruiter_code = $1
         AND a.is_active = true
         AND h.mapping_id IS NOT NULL
         AND DATE(h.created_on) >= $2::date
         AND DATE(h.created_on) <= $3::date

       UNION

       SELECT DISTINCT m.mapping_id
       FROM im_interviews i
       INNER JOIN rm_recruiter_assignments a
         ON a.requisition_code = i.requisition_code
       INNER JOIN rm_candidate_mappings m
         ON m.requisition_code = i.requisition_code
        AND m.is_active = true
        AND (
          (i.map_id IS NOT NULL AND m.map_id = i.map_id)
          OR (i.candidate_id IS NOT NULL AND m.candidate_id = i.candidate_id)
        )
       WHERE a.recruiter_code = $1
         AND a.is_active = true
         AND i.interview_date >= $2::date
         AND i.interview_date <= $3::date
     )
     SELECT m.*,
       c.candidate_code,
       CONCAT(c.first_name, ' ', c.last_name) AS candidate_name
     FROM rm_candidate_mappings m
     INNER JOIN active_mapping_ids am ON am.mapping_id = m.mapping_id
     LEFT JOIN cand_mstr c ON c.candidate_id = m.candidate_id
     ORDER BY m.modified_on DESC`,
    [employeeCode, fromDate, toDate]
  );

  const interviews = await pool.query(
    `SELECT i.*,
      c.candidate_code,
      CONCAT(c.first_name, ' ', c.last_name) AS candidate_name
     FROM im_interviews i
     INNER JOIN rm_recruiter_assignments a
       ON a.requisition_code = i.requisition_code
     LEFT JOIN cand_mstr c ON c.candidate_id = i.candidate_id
     WHERE a.recruiter_code = $1
       AND a.is_active = true
       AND i.interview_date >= $2::date
       AND i.interview_date <= $3::date
     ORDER BY i.interview_date DESC NULLS LAST, i.interview_time DESC NULLS LAST`,
    [employeeCode, fromDate, toDate]
  );

  const tasks = await pool.query(
    `SELECT DISTINCT t.*
     FROM et_tasks t
     INNER JOIN rm_recruiter_assignments a
       ON a.recruiter_code = $1 AND a.is_active = true
     WHERE t.status = 'Pending'
       AND t.module IN ('Recruitment Management', 'Interview Management')
       AND (
         t.business_object_id = a.requisition_code
         OR EXISTS (
           SELECT 1
           FROM im_interviews i
           WHERE i.requisition_code = a.requisition_code
             AND i.interview_id = t.business_object_id
         )
       )
       AND (
         (t.due_at IS NOT NULL AND DATE(t.due_at) >= $2::date AND DATE(t.due_at) <= $3::date)
         OR (t.created_on IS NOT NULL AND DATE(t.created_on) >= $2::date AND DATE(t.created_on) <= $3::date)
       )
     ORDER BY t.due_at ASC NULLS LAST, t.created_on DESC`,
    [employeeCode, fromDate, toDate]
  );

  const globalStageCounts = await pool.query(
    `SELECT stage, SUM(count)::int AS count
     FROM (
       SELECT 'Applied' AS stage, COUNT(*)::int AS count
       FROM rm_candidate_mappings m
       INNER JOIN rm_recruiter_assignments a
         ON a.requisition_code = m.requisition_code
       WHERE a.recruiter_code = $1
         AND a.is_active = true
         AND m.is_active = true
         AND DATE(m.applied_on) >= $2::date
         AND DATE(m.applied_on) <= $3::date

       UNION ALL

       SELECT ${stageSql} AS stage, COUNT(DISTINCT h.mapping_id)::int AS count
       FROM rm_pipeline_history h
       INNER JOIN rm_recruiter_assignments a
         ON a.requisition_code = h.requisition_code
       WHERE a.recruiter_code = $1
         AND a.is_active = true
         AND h.mapping_id IS NOT NULL
         AND DATE(h.created_on) >= $2::date
         AND DATE(h.created_on) <= $3::date
         AND NOT (LOWER(COALESCE(h.to_stage, '')) LIKE '%applied%')
       GROUP BY ${stageSql}
     ) stage_rows
     GROUP BY stage`,
    [employeeCode, fromDate, toDate]
  );

  const reqPeriodMetrics = await pool.query(
    `SELECT requisition_code, metric_type, stage, count
     FROM (
       SELECT m.requisition_code,
         'applied' AS metric_type,
         NULL::text AS stage,
         COUNT(*)::int AS count
       FROM rm_candidate_mappings m
       INNER JOIN rm_recruiter_assignments a
         ON a.requisition_code = m.requisition_code
       WHERE a.recruiter_code = $1
         AND a.is_active = true
         AND m.is_active = true
         AND DATE(m.applied_on) >= $2::date
         AND DATE(m.applied_on) <= $3::date
       GROUP BY m.requisition_code

       UNION ALL

       SELECT h.requisition_code,
         'history' AS metric_type,
         ${stageSql} AS stage,
         COUNT(DISTINCT h.mapping_id)::int AS count
       FROM rm_pipeline_history h
       INNER JOIN rm_recruiter_assignments a
         ON a.requisition_code = h.requisition_code
       WHERE a.recruiter_code = $1
         AND a.is_active = true
         AND h.mapping_id IS NOT NULL
         AND DATE(h.created_on) >= $2::date
         AND DATE(h.created_on) <= $3::date
         AND NOT (LOWER(COALESCE(h.to_stage, '')) LIKE '%applied%')
       GROUP BY h.requisition_code, ${stageSql}
     ) req_metrics`,
    [employeeCode, fromDate, toDate]
  );

  const offersInRange = await pool.query(
    `SELECT COUNT(DISTINCT h.mapping_id)::int AS count
     FROM rm_pipeline_history h
     INNER JOIN rm_recruiter_assignments a
       ON a.requisition_code = h.requisition_code
     WHERE a.recruiter_code = $1
       AND a.is_active = true
       AND h.mapping_id IS NOT NULL
       AND DATE(h.created_on) >= $2::date
       AND DATE(h.created_on) <= $3::date
       AND LOWER(COALESCE(h.to_stage, '')) LIKE '%offer%'`,
    [employeeCode, fromDate, toDate]
  );

  const offerCandidates = await pool.query(
    `SELECT DISTINCT ON (m.mapping_id)
       m.*,
       c.candidate_code,
       CONCAT(c.first_name, ' ', c.last_name) AS candidate_name,
       h.created_on AS offer_entered_on
     FROM rm_pipeline_history h
     INNER JOIN rm_recruiter_assignments a
       ON a.requisition_code = h.requisition_code
     INNER JOIN rm_candidate_mappings m
       ON m.mapping_id = h.mapping_id
     LEFT JOIN cand_mstr c ON c.candidate_id = m.candidate_id
     WHERE a.recruiter_code = $1
       AND a.is_active = true
       AND h.mapping_id IS NOT NULL
       AND DATE(h.created_on) >= $2::date
       AND DATE(h.created_on) <= $3::date
       AND LOWER(COALESCE(h.to_stage, '')) LIKE '%offer%'
     ORDER BY m.mapping_id, h.created_on DESC`,
    [employeeCode, fromDate, toDate]
  );

  const joinedAllTime = await pool.query(
    `SELECT m.requisition_code, COUNT(*)::int AS joined_count
     FROM rm_candidate_mappings m
     INNER JOIN rm_recruiter_assignments a
       ON a.requisition_code = m.requisition_code
     WHERE a.recruiter_code = $1
       AND a.is_active = true
       AND m.is_active = true
       AND LOWER(COALESCE(m.stage_name, '')) LIKE '%join%'
     GROUP BY m.requisition_code`,
    [employeeCode]
  );

  const taskRows = tasks.rows.map(mapDashboardTaskRow);
  const interviewRows = interviews.rows.map(mapDashboardInterviewRow);
  const pipelineRows = pipelineEntered.rows;
  const activePipelineRows = activePipeline.rows;
  const assignmentRows = assignments.rows;
  const pipelineStageCounts = mergeStageCountRows(globalStageCounts.rows);
  const periodMetricsByReq = mergeReqPeriodMetrics(reqPeriodMetrics.rows);
  const joinedAllTimeByReq = Object.fromEntries(
    joinedAllTime.rows.map((row) => [row.requisition_code, Number(row.joined_count) || 0])
  );

  const requisitionRows = requisitions.rows.map((row) => ({
    ...row,
    periodMetrics: periodMetricsByReq[row.requisition_code] || {
      stageCounts: emptyPipelineStageCounts(),
      candidatesEntered: 0
    },
    joinedAllTime: joinedAllTimeByReq[row.requisition_code] || 0
  }));

  const today = formatLocalDateOnly(new Date());
  const todayInRange = today >= fromDate && today <= toDate;

  const openRequisitions = requisitionRows.filter((row) =>
    /open|pending|approved/i.test(row.req_status)
  ).length;

  const pendingFeedbackInRange = interviewRows.filter((row) => !row.feedbackSubmitted).length;

  return {
    employee_code: employeeCode,
    requisitions: requisitionRows,
    recruiterAssignments: assignmentRows,
    pipeline: pipelineRows,
    activePipeline: activePipelineRows,
    offerCandidates: offerCandidates.rows,
    interviews: interviewRows,
    tasks: taskRows,
    filter: { fromDate, toDate },
    summary: {
      openRequisitions,
      activeCandidates: pipelineRows.length,
      pendingTasks: taskRows.length,
      interviewsInRange: interviewRows.length,
      interviewsToday: todayInRange
        ? interviewRows.filter((row) => row.interview_date === today).length
        : 0,
      pendingFeedbackInRange,
      offersInRange: Number(offersInRange.rows[0]?.count) || 0,
      pipelineStageCounts
    },
    taskSummary: {
      pending: taskRows.length,
      escalated: taskRows.filter((row) => row.escalated).length,
      overdue: taskRows.filter((row) => row.due_at && new Date(row.due_at) < new Date()).length
    },
    interviewSummary: {
      scheduled: interviewRows.filter((row) => row.interviewStatus === "Scheduled").length,
      completed: interviewRows.filter((row) => row.interviewStatus === "Completed").length,
      pendingFeedback: pendingFeedbackInRange
    }
  };
}

/**
 * @param {object} queryable - pg Pool or Client (shared TX handle)
 */
async function createFromApprovedPosition(
  queryable,
  positionId,
  options = {},
  req
) {
  const user = userContext(req);
  const platformConfig = await loadPlatformConfig(queryable);
  await assertRecruitmentModuleEnabled(platformConfig);

  const position = await loadApprovedPosition(queryable, positionId);
  if (!position) {
    throw httpError(`Approved position not found: ${positionId}`, 404);
  }

  if (position.status === "Fully Utilized") {
    throw httpError("Approved position budget is fully utilized.", 400);
  }

  const existingForPosition = await queryable.query(
    `SELECT requisition_code
     FROM rm_requisitions
     WHERE approved_position_id = $1
     ORDER BY created_on ASC
     LIMIT 1`,
    [positionId]
  );

  if (existingForPosition.rows.length > 0) {
    throw httpError(
      `A requisition already exists for approved position ${positionId}: ${existingForPosition.rows[0].requisition_code}. One Approved Position creates exactly one Requisition.`,
      409
    );
  }

  const mdValidation = await validateMasterDataReferences(queryable, {
    department: position.department,
    grade: position.grade,
    location: options.location || position.location || null,
    employment_type:
      options.employment_type || position.employment_type || null,
    primary_skill: options.primary_skill || null,
    secondary_skill: options.secondary_skill || null
  });

  if (!mdValidation.valid) {
    throw httpError(mdValidation.errors.join(" "), 400);
  }

  const resolvedEmploymentType =
    options.employment_type || position.employment_type || null;

  const budgetLpa = Number(position.budget_approved || 0) / 100000;
  const ruleEval = await evaluateRecruitmentRules(queryable, {
    department: position.department,
    grade: position.grade,
    approved_budget_lpa: budgetLpa,
    offered_salary_lpa: budgetLpa,
    headcount: position.headcount,
    employment_type: resolvedEmploymentType,
    action: "create_requisition"
  }, req);

  const requisitionCode =
    options.requisitionId || (await generateRequisitionCode(queryable));

  const existing = await queryable.query(
    "SELECT requisition_code FROM rm_requisitions WHERE requisition_code = $1",
    [requisitionCode]
  );

  if (existing.rows.length > 0) {
    throw httpError(`Requisition already exists: ${requisitionCode}`, 409);
  }

  const legacyRow = await insertLegacyRequisition(
    queryable,
    {
      ...position,
      employment_type: resolvedEmploymentType,
      location: options.location || position.location || null
    },
    requisitionCode,
    user,
    options.approval_route_id ?? null
  );
  const reqId = legacyRow?.req_id || (await allocateReqId(queryable));

  // Ensure rm_requisitions.req_id always has a parent in req_mstr before insert.
  console.log("REQ_MSTR_CHECK_START");
  console.log("reqId:", reqId);
  const hasReqMstr = await tableExists(queryable, "req_mstr");
  console.log("req_mstr table exists:", hasReqMstr);

  if (hasReqMstr) {
    const legacyParent = await queryable.query(
      "SELECT req_id FROM req_mstr WHERE req_id = $1",
      [reqId]
    );
    console.log("existing req_mstr row found:", legacyParent.rows.length > 0);

    if (legacyParent.rows.length === 0) {
      const legacyCode = requisitionCode.replace(/^REQ-/, "REQ");
      console.log("before req_mstr INSERT");
      await queryable.query(
        `INSERT INTO req_mstr (
          req_id, req_code, client_name, project_name, job_title, job_description,
          primary_skill, secondary_skill, experience_min, experience_max,
          openings_count, work_location, employment_type, priority_level,
          req_status, recruiter_id, hiring_manager, target_date, created_by,
          approval_route_id
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
        [
          reqId,
          legacyCode,
          position.business_unit || "Internal",
          position.department,
          position.position_title,
          `Enterprise requisition from approved position ${position.position_id}`,
          position.primary_skill || null,
          null,
          null,
          null,
          position.headcount || 1,
          options.location || position.location || null,
          resolvedEmploymentType,
          "High",
          REQUISITION_STATUS.OPEN,
          null,
          options.hiring_manager || position.hiring_manager || "Hiring Manager",
          position.expiry_date || null,
          user.name,
          options.approval_route_id ?? null
        ]
      );
      console.log("after req_mstr INSERT");
    }
  }

  const instance = await workflowService.startWorkflow(
    queryable,
    "REQUISITION",
    {
      instance_id: `WF-RM-${requisitionCode}`,
      meta: {
        process_id: `WF-RM-${requisitionCode}`,
        document_type: "REQUISITION",
        requisition_id: requisitionCode,
        approved_position_id: positionId,
        department: position.department,
        position_title: position.position_title,
        grade: position.grade
      },
      department: position.department,
      grade: position.grade
    },
    req
  );

  const initialStatus = ruleEval.approvers.some((item) => /finance|ta/i.test(item))
    ? REQUISITION_STATUS.PENDING_LEVEL_1
    : REQUISITION_STATUS.OPEN;

  await queryable.query(
    `INSERT INTO rm_requisitions (
      requisition_code, approved_position_id, req_id, position_title, grade,
      department, business_unit, location, budget_approved, hiring_manager,
      employment_type, headcount, primary_skill, secondary_skill, req_status,
      workflow_instance_id, version, version_status, effective_from, created_by,
      modified_by, approval_route_id
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
    [
      requisitionCode,
      positionId,
      reqId,
      position.position_title,
      position.grade,
      position.department,
      options.business_unit || position.business_unit || position.department,
      options.location || position.location || null,
      position.budget_approved,
      options.hiring_manager || position.hiring_manager || "Hiring Manager",
      resolvedEmploymentType,
      position.headcount || 1,
      options.primary_skill || null,
      options.secondary_skill || null,
      initialStatus,
      instance.instanceId,
      1.0,
      "Published",
      new Date(),
      user.name,
      user.name,
      options.approval_route_id ?? null
    ]
  );

  // When an approval route is provided at create (draft submit), expand L1/Ln
  // tasks immediately — same as Budget submit. Idempotent if submit expands again.
  // Catalogue create passes no route; EDIT submit expands via submitRequisition.
  let approvalTasks = [];
  if (options.approval_route_id != null && String(options.approval_route_id).trim() !== "") {
    const employeeCode = req.user?.employee_code
      ? String(req.user.employee_code).trim()
      : user.name;
    approvalTasks = await workflowService.createApprovalRouteWorkflowTasks(
      queryable,
      instance.instanceId,
      options.approval_route_id,
      {
        stageKey: instance.currentStageKey || "approval",
        assignedBy: employeeCode,
        requisitionCode
      }
    );
  }

  await writeEnterpriseAudit(queryable, {
    eventType: "RequisitionCreated",
    module: "Recruitment Management",
    entity: "Requisition",
    entityId: requisitionCode,
    action: `Requisition ${requisitionCode} created from approved position ${positionId}`,
    userName: user.name,
    userRole: user.role,
    metadata: {
      positionId,
      ruleEvaluation: ruleEval,
      inherited: {
        position: position.position_title,
        grade: position.grade,
        department: position.department,
        budget: position.budget_approved
      }
    }
  });

  return {
    requisitionId: requisitionCode,
    requisition: {
      requisition_code: requisitionCode,
      approved_position_id: positionId,
      position_title: position.position_title,
      grade: position.grade,
      department: position.department,
      budget_approved: position.budget_approved,
      req_status: initialStatus,
      workflow_instance_id: instance.instanceId,
      approval_route_id: options.approval_route_id ?? null
    },
    approval_tasks: approvalTasks,
    legacyRequisition: legacyRow,
    ruleEvaluation: ruleEval,
    hiringProcessUpdate: {
      linkedPositionId: positionId,
      linkedRequisitionId: requisitionCode,
      meta: {
        requisition_id: requisitionCode,
        position_title: position.position_title,
        department: position.department,
        grade: position.grade
      }
    },
    toastMessage: `Requisition ${requisitionCode} created from ${positionId}.`
  };
}

async function approveRequisition(pool, requisitionCode, comment, req) {
  const user = userContext(req);
  const platformConfig = await loadPlatformConfig(pool);
  await assertRecruitmentModuleEnabled(platformConfig);

  const result = await pool.query(
    "SELECT * FROM rm_requisitions WHERE requisition_code = $1",
    [requisitionCode]
  );
  const requisition = result.rows[0];

  if (!requisition) {
    throw httpError(`Requisition not found: ${requisitionCode}`, 404);
  }

  const ruleEval = await evaluateRecruitmentRules(pool, {
    department: requisition.department,
    grade: requisition.grade,
    approved_budget_lpa: Number(requisition.budget_approved || 0) / 100000,
    action: "approve_requisition"
  }, req);

  if (requisition.workflow_instance_id) {
    await workflowService.advanceWorkflow(
      pool,
      requisition.workflow_instance_id,
      "approve",
      { stageKey: "ta_leader_review", actor: user.name, comment },
      req
    );
  }

  const nextStatus =
    requisition.req_status === REQUISITION_STATUS.PENDING_LEVEL_1
    || requisition.req_status === REQUISITION_STATUS.PENDING_LEVEL_2
      ? REQUISITION_STATUS.APPROVED
      : REQUISITION_STATUS.OPEN;

  await pool.query(
    `UPDATE rm_requisitions
     SET req_status = $1, modified_by = $2, modified_on = NOW()
     WHERE requisition_code = $3`,
    [nextStatus, user.name, requisitionCode]
  );

  if (isLegacyDualWriteEnabled() && requisition.req_id && (await tableExists(pool, "req_mstr"))) {
    await pool.query(
      "UPDATE req_mstr SET req_status = $1, updated_on = CURRENT_TIMESTAMP WHERE req_id = $2",
      [REQUISITION_STATUS.OPEN, requisition.req_id]
    );
  }

  await writeEnterpriseAudit(pool, {
    eventType: "RequisitionApproved",
    module: "Recruitment Management",
    entity: "Requisition",
    entityId: requisitionCode,
    action: `Requisition ${requisitionCode} approved`,
    previousValue: requisition.req_status,
    newValue: nextStatus,
    userName: user.name,
    userRole: user.role,
    metadata: { comment, ruleEvaluation: ruleEval }
  });

  const bundle = await getRecruitmentBundle(pool);
  return {
    ...bundle,
    requisition: { ...requisition, req_status: nextStatus },
    toastMessage: "Requisition approved."
  };
}

async function assignRecruiter(pool, reqId, recruiterCode, req) {
  const user = userContext(req);
  const platformConfig = await loadPlatformConfig(pool);
  await assertRecruitmentModuleEnabled(platformConfig);
  await assertCanAssignRecruiter(pool, req);

  let requisition = null;

  if (String(reqId).startsWith("REQ-")) {
    const byCode = await pool.query(
      "SELECT * FROM rm_requisitions WHERE requisition_code = $1",
      [reqId]
    );
    requisition = byCode.rows[0];
  } else {
    const byLegacy = await pool.query(
      "SELECT * FROM rm_requisitions WHERE req_id = $1",
      [reqId]
    );
    requisition = byLegacy.rows[0];
  }

  if (!requisition && (await tableExists(pool, "req_mstr"))) {
    const legacy = await pool.query("SELECT req_id FROM req_mstr WHERE req_id = $1", [reqId]);
    if (!legacy.rows.length) {
      throw httpError("Requisition not found.", 404);
    }
  } else if (!requisition) {
    throw httpError("Requisition not found.", 404);
  }

  if (requisition) {
    assertRequisitionOpenForRecruiting(requisition);
  }

  const ruleEval = await evaluateRecruitmentRules(pool, {
    department: requisition?.department,
    grade: requisition?.grade,
    recruiter_code: recruiterCode,
    action: "assign_recruiter"
  }, req);

  // Align with the live workflow instance: only advance when the instance
  // payload actually defines recruiter_assigned (e.g. HCT-style payloads).
  // Official REQUISITION definitions use draft/ta_review/open/... and do not
  // include recruiter_assigned — assignment must still succeed for those.
  if (requisition?.workflow_instance_id) {
    const instance = await workflowService.getInstanceById(
      pool,
      requisition.workflow_instance_id
    );
    const stages = instance?.payload?.stages || [];
    const hasRecruiterAssignedStage = stages.some(
      (item) => String(item.key || "").trim() === "recruiter_assigned"
    );

    if (hasRecruiterAssignedStage) {
      await workflowService.advanceWorkflow(
        pool,
        requisition.workflow_instance_id,
        "approve",
        { stageKey: "recruiter_assigned", actor: user.name, comment: `Assigned ${recruiterCode}` },
        req
      );
    }
  }

  let assignmentRow = null;

  if (requisition) {
    const duplicate = await pool.query(
      `SELECT * FROM rm_recruiter_assignments
       WHERE requisition_code = $1 AND recruiter_code = $2 AND is_active = true`,
      [requisition.requisition_code, recruiterCode]
    );

    if (duplicate.rows.length > 0) {
      throw httpError("Recruiter already assigned to this requisition.", 400);
    }

    const insert = await pool.query(
      `INSERT INTO rm_recruiter_assignments (
        requisition_code, req_id, recruiter_code, assigned_by, version, version_status, effective_from
      ) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [
        requisition.requisition_code,
        requisition.req_id,
        recruiterCode,
        user.name,
        1.0,
        "Published",
        new Date()
      ]
    );
    assignmentRow = insert.rows[0];
  }

  if (isLegacyDualWriteEnabled() && (await tableExists(pool, "req_recruiter_map"))) {
    const legacyReqId = requisition?.req_id || reqId;
    await pool.query(
      `INSERT INTO req_recruiter_map (req_id, recruiter_code, assigned_by)
       VALUES ($1,$2,$3)`,
      [legacyReqId, recruiterCode, user.name]
    );
  }

  await writeEnterpriseAudit(pool, {
    eventType: "RecruiterAssigned",
    module: "Recruitment Management",
    entity: "Requisition",
    entityId: requisition?.requisition_code || String(reqId),
    action: `Recruiter ${recruiterCode} assigned`,
    userName: user.name,
    userRole: user.role,
    metadata: { recruiterCode, ruleEvaluation: ruleEval }
  });

  return {
    assignment: assignmentRow,
    toastMessage: "Recruiter assigned successfully."
  };
}

async function mapCandidate(pool, payload, req) {
  const user = userContext(req);
  const platformConfig = await loadPlatformConfig(pool);
  await assertRecruitmentModuleEnabled(platformConfig);

  const {
    candidate_id: candidateId,
    req_id: reqId,
    requisition_code: requisitionCode,
    stage_name: stageName = "Applied",
    source_type: sourceType,
    remarks
  } = payload;

  let requisition = null;

  if (requisitionCode) {
    const result = await pool.query(
      "SELECT * FROM rm_requisitions WHERE requisition_code = $1",
      [requisitionCode]
    );
    requisition = result.rows[0];
  } else if (reqId) {
    const result = await pool.query(
      "SELECT * FROM rm_requisitions WHERE req_id = $1",
      [reqId]
    );
    requisition = result.rows[0];
  }

  if (!requisition) {
    throw httpError("Enterprise requisition not found. Requisitions must originate from Workforce Planning.", 400);
  }

  assertRequisitionOpenForRecruiting(requisition);

  const isPortalApply = Boolean(req.candidatePortalApply);

  if (!isPortalApply) {
    await assertRecruiterAssignedToRequisition(pool, req, requisition);
  }

  const mdValidation = await validateMasterDataReferences(pool, {
    source_type: sourceType
  });

  if (sourceType && !mdValidation.valid) {
    throw httpError(mdValidation.errors.join(" "), 400);
  }

  const ruleEval = await evaluateRecruitmentRules(pool, {
    candidate_id: candidateId,
    department: requisition.department,
    grade: requisition.grade,
    source_type: sourceType,
    action: "map_candidate"
  }, req);

  if (ruleEval.triggered_rules.some((item) => /duplicate/i.test(item))) {
    throw httpError("Duplicate candidate detected by Business Rules Engine.", 400);
  }

  const existingEnterprise = await pool.query(
  `SELECT mapping_id
   FROM rm_candidate_mappings
   WHERE candidate_id = $1
     AND requisition_code = $2`,
  [
    candidateId,
    requisition.requisition_code
  ]
);

  if (existingEnterprise.rows.length > 0) {
  throw httpError(
    "Candidate is already assigned to this requisition.",
    400
  );
}

  const resolvedStage = await resolveGovernedAtsStage(pool, stageName);
  const canonicalStageName = resolvedStage.displayName;

  let legacyMap = null;
  let allocatedMapId = null;
  const legacyMapTableExists = await tableExists(pool, "candidate_req_map");
  const dualWriteLegacy =
    isLegacyDualWriteEnabled() && legacyMapTableExists;

  if (!dualWriteLegacy) {
    allocatedMapId = await allocateMapId(pool);
  }

  const instance = await workflowService.startWorkflow(
    pool,
    "CANDIDATE",
    {
      instance_id: `WF-CAND-${candidateId}-${requisition.requisition_code}`,
      meta: {
        candidate_id: candidateId,
        requisition_id: requisition.requisition_code,
        department: requisition.department
      },
      department: requisition.department,
      grade: requisition.grade
    },
    req
  );

  const client = await pool.connect();
  let mappingRow = null;

  try {
    await client.query("BEGIN");

    const candLock = await client.query(
      `SELECT candidate_container, owner_employee_code
       FROM cand_mstr
       WHERE candidate_id = $1
       FOR UPDATE`,
      [candidateId]
    );
    const candRow = candLock.rows[0] || null;
    const shouldAcquireOwnership =
      candRow &&
      String(candRow.candidate_container || "").toUpperCase() === "TALENT_POOL" &&
      candRow.owner_employee_code == null;

    // One active assignment — authoritative check under candidate row lock
    const activeEnterpriseMapping = await client.query(
      `SELECT mapping_id
       FROM rm_candidate_mappings
       WHERE candidate_id = $1
         AND is_active = true
       LIMIT 1`,
      [candidateId]
    );

    if (activeEnterpriseMapping.rows.length > 0) {
      throw httpError(
        "Candidate is already assigned to an active requisition. Release the existing mapping before assigning a new requisition.",
        409
      );
    }

    if (legacyMapTableExists) {
      const activeLegacyMapping = await client.query(
        `SELECT map_id
         FROM candidate_req_map
         WHERE candidate_id = $1
           AND is_active = true
         LIMIT 1`,
        [candidateId]
      );

      if (activeLegacyMapping.rows.length > 0) {
        throw httpError(
          "Candidate is already assigned to an active requisition. Release the existing mapping before assigning a new requisition.",
          409
        );
      }
    }

    if (dualWriteLegacy) {
      const existing = await client.query(
        `SELECT * FROM candidate_req_map
         WHERE candidate_id = $1 AND req_id = $2 AND is_active = true`,
        [candidateId, requisition.req_id || reqId]
      );

      if (existing.rows.length > 0) {
        throw httpError("Candidate already mapped to requisition.", 400);
      }

      const insert = await client.query(
        `INSERT INTO candidate_req_map (
          candidate_id, req_id, recruiter_id, stage_name, source_type, remarks
        ) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [
          candidateId,
          requisition.req_id || reqId,
          user.name,
          canonicalStageName,
          sourceType,
          remarks
        ]
      );
      legacyMap = insert.rows[0];
    }

    const mapping = await client.query(
      `INSERT INTO rm_candidate_mappings (
        candidate_id, requisition_code, req_id, map_id, recruiter_id,
        stage_name, source_type, workflow_instance_id, remarks,
        version, version_status, effective_from
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [
        candidateId,
        requisition.requisition_code,
        requisition.req_id || reqId,
        legacyMap?.map_id || allocatedMapId,
        user.name,
        canonicalStageName,
        sourceType,
        instance.instanceId,
        remarks,
        1.0,
        "Published",
        new Date()
      ]
    );
    mappingRow = mapping.rows[0];

    // Guarantee legacy candidate_req_map parent for schedule FK consumers.
    // Existing dual-write path already inserts; when dual-write is off, create
    // the bridge only if this map_id is missing (idempotent).
    if (legacyMapTableExists && mappingRow.map_id) {
      const legacyParent = await client.query(
        `SELECT map_id
         FROM candidate_req_map
         WHERE map_id = $1`,
        [mappingRow.map_id]
      );

      if (legacyParent.rows.length === 0) {
        const bridgeReqId = requisition.req_id || reqId;
        if (!bridgeReqId) {
          throw httpError(
            "Enterprise requisition is not linked to a legacy Req ID.",
            400
          );
        }

        await client.query(
          `INSERT INTO candidate_req_map (
            map_id, candidate_id, req_id, recruiter_id,
            stage_name, source_type, remarks, is_active
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, true)
          ON CONFLICT (map_id) DO NOTHING`,
          [
            mappingRow.map_id,
            candidateId,
            bridgeReqId,
            user.name,
            canonicalStageName,
            sourceType,
            remarks
          ]
        );

        await client.query(
          `SELECT setval(
             'candidate_req_map_map_id_seq',
             (SELECT COALESCE(MAX(map_id), 1) FROM candidate_req_map)
           )`
        );
      }
    }

    await client.query(
      `INSERT INTO rm_pipeline_history (
        requisition_code, mapping_id, candidate_id, event_type, to_stage, actor, actor_role, comments, metadata
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        requisition.requisition_code,
        mappingRow.mapping_id,
        candidateId,
        "CandidateMapped",
        canonicalStageName,
        user.name,
        user.role,
        remarks,
        JSON.stringify({ sourceType, ruleEvaluation: ruleEval })
      ]
    );

    // Talent Pool unowned → acquire ownership on map (same transaction).
    // PIPELINE + owned by another recruiter: leave ownership unchanged (request workflow).
    if (shouldAcquireOwnership && !isPortalApply) {
      const ownerEmployeeCode = recruiterEmployeeCode(req);

      if (ownerEmployeeCode) {
        await client.query(
          `UPDATE cand_mstr
           SET candidate_container = 'PIPELINE',
               owner_employee_code = $1
           WHERE candidate_id = $2
             AND candidate_container = 'TALENT_POOL'
             AND owner_employee_code IS NULL`,
          [ownerEmployeeCode, candidateId]
        );
      }
    }

    await client.query("COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (_rollbackError) {
      // ignore rollback failures
    }
    throw error;
  } finally {
    client.release();
  }

  await writeEnterpriseAudit(pool, {
    eventType: "CandidateMapped",
    module: "Recruitment Management",
    entity: "Candidate",
    entityId: String(candidateId),
    action: `Candidate mapped to requisition ${requisition.requisition_code}`,
    userName: user.name,
    userRole: user.role,
    metadata: {
      requisitionCode: requisition.requisition_code,
      stageName: canonicalStageName,
      ruleEvaluation: ruleEval
    }
  });

  return {
    mapping: mappingRow,
    legacyMapping: legacyMap,
    toastMessage: "Candidate mapped successfully."
  };
}

async function updateCandidateStage(pool, mapId, stageName, remarks, req) {
  const user = userContext(req);
  const platformConfig = await loadPlatformConfig(pool);
  await assertRecruitmentModuleEnabled(platformConfig);

  if (!stageName || !String(stageName).trim()) {
    throw httpError("stage_name is required.", 400);
  }

  const { mapping, legacyRow } = await assertAuthorizedStageUpdate(pool, req, mapId);

  const resolvedStage = await resolveGovernedAtsStage(pool, stageName);
  const canonicalStageName = resolvedStage.displayName;

  const previousStage = mapping?.stage_name || legacyRow?.stage_name || "Applied";
  const requisitionCode = mapping?.requisition_code;

  let requisition = null;
  if (requisitionCode) {
    const reqResult = await pool.query(
      "SELECT * FROM rm_requisitions WHERE requisition_code = $1",
      [requisitionCode]
    );
    requisition = reqResult.rows[0];
  }

  if (requisition) {
    assertRequisitionOpenForRecruiting(requisition);
  }

  const ruleEval = await evaluateRecruitmentRules(pool, {
    department: requisition?.department,
    grade: requisition?.grade,
    from_stage: previousStage,
    to_stage: canonicalStageName,
    target_stage: canonicalStageName,
    action: /offer/i.test(canonicalStageName) ? "offer_routing" : "stage_change"
  }, req);

  if (mapping?.workflow_instance_id) {
    await workflowService.advanceWorkflow(
      pool,
      mapping.workflow_instance_id,
      /reject/i.test(canonicalStageName) ? "reject" : "approve",
      {
        stageKey: canonicalStageName.toLowerCase().replace(/\s+/g, "_"),
        actor: user.name,
        comment: remarks
      },
      req
    );
  }

  let eventType = "StageChanged";
  if (/reject/i.test(canonicalStageName)) {
    eventType = "CandidateRejected";
  } else if (/shortlist|cleared/i.test(canonicalStageName)) {
    eventType = "CandidateShortlisted";
  }

  if (mapping) {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      await client.query(
        `UPDATE rm_candidate_mappings
         SET stage_name = $1, remarks = $2, modified_on = NOW()
         WHERE mapping_id = $3`,
        [canonicalStageName, remarks, mapping.mapping_id]
      );

      await pipelineHistoryService.recordPipelineStageTransition(client, {
        requisitionCode,
        mappingId: mapping.mapping_id,
        candidateId: mapping.candidate_id,
        eventType,
        fromStage: previousStage,
        toStage: canonicalStageName,
        actor: user.name,
        actorRole: user.role,
        comments: remarks,
        metadata: { ruleEvaluation: ruleEval }
      });

      await client.query("COMMIT");
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (_rollbackError) {
        // ignore rollback failures
      }
      throw error;
    } finally {
      client.release();
    }
  } else {
    await pipelineHistoryService.recordPipelineStageTransition(pool, {
      requisitionCode,
      mappingId: null,
      candidateId: legacyRow?.candidate_id,
      eventType,
      fromStage: previousStage,
      toStage: canonicalStageName,
      actor: user.name,
      actorRole: user.role,
      comments: remarks,
      metadata: { ruleEvaluation: ruleEval }
    });
  }

  if (isLegacyDualWriteEnabled() && legacyRow && (await tableExists(pool, "candidate_req_map"))) {
    await pool.query(
      "UPDATE candidate_req_map SET stage_name = $1, remarks = $2 WHERE map_id = $3",
      [canonicalStageName, remarks, mapId]
    );

    await pool.query(
      "UPDATE cand_mstr SET candidate_status = $1 WHERE candidate_id = $2",
      [canonicalStageName, legacyRow.candidate_id]
    );
  } else if (mapping?.candidate_id) {
    await pool.query(
      "UPDATE cand_mstr SET candidate_status = $1 WHERE candidate_id = $2",
      [canonicalStageName, mapping.candidate_id]
    );
  }

  await writeEnterpriseAudit(pool, {
    eventType,
    module: "Recruitment Management",
    entity: "Candidate Pipeline",
    entityId: String(mapId),
    action: `Stage changed from ${previousStage} to ${canonicalStageName}`,
    previousValue: previousStage,
    newValue: canonicalStageName,
    userName: user.name,
    userRole: user.role,
    metadata: { remarks, ruleEvaluation: ruleEval }
  });

  if (mapping?.mapping_id && mapping?.candidate_id) {
    try {
      const candidatePortalNotificationService = require(
        "./candidatePortalNotificationService"
      );

      const notifyResult =
        await candidatePortalNotificationService.notifyStageChanged(pool, {
          mappingId: mapping.mapping_id,
          candidateId: mapping.candidate_id,
          requisitionCode,
          stageName: canonicalStageName,
          stageCode: resolvedStage.stageCode,
          positionTitle: requisition?.position_title || null
        });

      if (notifyResult?.skipped) {
        console.warn(
          "[updateCandidateStage] stage_changed skipped:",
          notifyResult.reason
        );
      }
    } catch (notificationError) {
      console.error(
        "[updateCandidateStage] stage_changed notification failed:",
        notificationError.message
      );
    }
  }

  return {
    mapping: mapping ? { ...mapping, stage_name: canonicalStageName } : legacyRow,
    eventType,
    toastMessage: "ATS stage updated successfully."
  };
}

/**
 * @param {object} queryable - pg Pool or Client (shared TX handle)
 */
async function handleLegacyCreateRequisition(queryable, body, req) {
  await assertCanCreateRequisition(queryable, req);

  const approvedPositionId = body.approved_position_id;

  if (!approvedPositionId) {
    throw httpError(
      "Requisitions must be created from an Approved Position in Workforce Planning. Provide approved_position_id.",
      400
    );
  }

  return createFromApprovedPosition(queryable, approvedPositionId, {
    business_unit: body.client_name,
    location: body.work_location || null,
    hiring_manager: body.hiring_manager,
    primary_skill: body.primary_skill,
    secondary_skill: body.secondary_skill,
    employment_type: body.employment_type || null,
    approval_route_id: body.approval_route_id ?? body.route_id ?? null
  }, req);
}

async function seedConfiguration(pool, payload, user = { name: "System Seed", role: "Admin" }) {
  const seed = clonePayload(payload);

  for (const requisition of seed.requisitions || []) {
    await pool.query(
      `INSERT INTO rm_requisitions (
        requisition_code, approved_position_id, req_id, position_title, grade,
        department, business_unit, location, budget_approved, hiring_manager,
        employment_type, headcount, primary_skill, req_status, workflow_instance_id,
        version, version_status, effective_from, created_by, modified_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
      ON CONFLICT (requisition_code) DO UPDATE SET
        req_status = EXCLUDED.req_status,
        modified_on = NOW()`,
      [
        requisition.requisition_code,
        requisition.approved_position_id,
        requisition.req_id || null,
        requisition.position_title,
        requisition.grade,
        requisition.department,
        requisition.business_unit || requisition.department,
        requisition.location || "Bangalore",
        requisition.budget_approved || 0,
        requisition.hiring_manager || "Hiring Manager",
        requisition.employment_type || "Full-time",
        requisition.headcount || 1,
        requisition.primary_skill || null,
        requisition.req_status || REQUISITION_STATUS.OPEN,
        requisition.workflow_instance_id || null,
        1.0,
        "Published",
        new Date(),
        user.name,
        user.name
      ]
    );
  }

  for (const assignment of seed.recruiter_assignments || []) {
    await pool.query(
      `INSERT INTO rm_recruiter_assignments (
        requisition_code, req_id, recruiter_code, assigned_by, version, version_status, effective_from
      ) VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT DO NOTHING`,
      [
        assignment.requisition_code,
        assignment.req_id || null,
        assignment.recruiter_code,
        user.name,
        1.0,
        "Published",
        new Date()
      ]
    ).catch(() => {});
  }
}

/**
 * Resolves an enterprise assignment from a legacy map_id or enterprise assignment_id.
 *
 * ID mapping:
 *   legacy map_id  → req_recruiter_map (req_id, recruiter_code)
 *                  → rm_recruiter_assignments (latest active row for that pair)
 *   assignment_id  → rm_recruiter_assignments directly
 */
async function resolveRecruiterAssignmentTarget(pool, mapId) {
  const numericId = Number(mapId);

  if (Number.isInteger(numericId) && numericId > 0) {
    const byAssignmentId = await pool.query(
      `SELECT * FROM rm_recruiter_assignments
       WHERE assignment_id = $1 AND is_active = true`,
      [numericId]
    );

    if (byAssignmentId.rows.length) {
      return {
        assignment: byAssignmentId.rows[0],
        legacyMapId: null,
        legacyRow: null,
        resolution: "assignment_id"
      };
    }
  }

  if (await tableExists(pool, "req_recruiter_map")) {
    const legacy = await pool.query(
      `SELECT * FROM req_recruiter_map WHERE map_id = $1`,
      [mapId]
    );

    if (legacy.rows.length) {
      const legacyRow = legacy.rows[0];

      const enterprise = await pool.query(
        `SELECT * FROM rm_recruiter_assignments
         WHERE req_id = $1
           AND recruiter_code = $2
           AND is_active = true
         ORDER BY assigned_on DESC, assignment_id DESC
         LIMIT 1`,
        [legacyRow.req_id, legacyRow.recruiter_code]
      );

      if (enterprise.rows.length) {
        return {
          assignment: enterprise.rows[0],
          legacyMapId: legacyRow.map_id,
          legacyRow,
          resolution: "legacy_map_id"
        };
      }

      if (legacyRow.is_active === false) {
        throw httpError("Recruiter assignment already removed.", 404);
      }

      throw httpError(
        "Legacy assignment found but no active enterprise assignment exists.",
        404
      );
    }
  }

  throw httpError("Assignment not found.", 404);
}

function mapRequisitionForManagementUi(row) {
  return {
    req_id: row.req_id,
    req_code: row.requisition_code,
    requisition_code: row.requisition_code,
    client_name: row.business_unit || row.department,
    project_name: row.department,
    job_title: row.position_title,
    job_description: null,
    primary_skill: row.primary_skill,
    secondary_skill: row.secondary_skill,
    experience_min: null,
    experience_max: null,
    openings_count: row.headcount,
    work_location: row.location,
    employment_type: row.employment_type,
    priority_level: "High",
    req_status: row.req_status,
    closed_at: row.closed_at || null,
    closed_by: row.closed_by || null,
    closure_reason: row.closure_reason || null,
    is_closed: isClosedRequisitionStatus(row.req_status),
    candidate_portal_published_at: row.candidate_portal_published_at || null,
    candidate_portal_published_by: row.candidate_portal_published_by || null,
    candidate_portal_published: Boolean(row.candidate_portal_published_at),
    recruiter_id: null,
    hiring_manager: row.hiring_manager,
    target_date: null,
    created_by: row.created_by,
    created_on: row.created_on,
    updated_on: row.modified_on
  };
}

function mapAssignmentForManagementUi(row) {
  return {
    map_id: row.assignment_id,
    assignment_id: row.assignment_id,
    employee_code: row.recruiter_code,
    full_name: row.full_name || row.recruiter_code,
    assigned_on: row.assigned_on,
    requisition_code: row.requisition_code,
    req_id: row.req_id
  };
}

async function resolveRequisitionIdentifier(pool, reqIdOrCode) {
  if (String(reqIdOrCode).startsWith("REQ-")) {
    const byCode = await pool.query(
      "SELECT * FROM rm_requisitions WHERE requisition_code = $1",
      [reqIdOrCode]
    );
    return byCode.rows[0] || null;
  }

  const byLegacyId = await pool.query(
    "SELECT * FROM rm_requisitions WHERE req_id = $1",
    [reqIdOrCode]
  );
  return byLegacyId.rows[0] || null;
}

async function listRequisitionsForManagement(pool) {
  const result = await pool.query(
    `SELECT * FROM rm_requisitions
     WHERE req_status = ANY($1::text[])
     ORDER BY COALESCE(req_id, 0) DESC, created_on DESC`,
    [
      [
        REQUISITION_STATUS.APPROVED,
        REQUISITION_STATUS.CLOSED_FILLED,
        REQUISITION_STATUS.CLOSED_CANCELLED
      ]
    ]
  );

  const enriched = await enrichRequisitionsWithFulfillment(pool, result.rows);

  return enriched.map((row) => ({
    ...mapRequisitionForManagementUi(row),
    ...row.fulfillment,
    fulfillment: row.fulfillment
  }));
}

async function getRequisitionFulfillment(pool, requisitionCode) {
  const requisition = await loadRequisitionByCode(pool, requisitionCode);

  if (!requisition) {
    throw httpError(`Requisition not found: ${requisitionCode}`, 404);
  }

  const fulfillment = await getFulfillmentForRequisition(pool, requisition);

  return {
    requisition_code: requisition.requisition_code,
    req_status: requisition.req_status,
    closed_at: requisition.closed_at || null,
    closed_by: requisition.closed_by || null,
    closure_reason: requisition.closure_reason || null,
    fulfillment
  };
}

async function getAssignedRecruitersForRequisition(pool, reqIdOrCode) {
  const requisition = await resolveRequisitionIdentifier(pool, reqIdOrCode);

  if (!requisition) {
    throw httpError("Requisition not found.", 404);
  }

  const result = await pool.query(
    `SELECT a.*, u.full_name
     FROM rm_recruiter_assignments a
     LEFT JOIN user_mstr u ON u.employee_code = a.recruiter_code
     WHERE a.requisition_code = $1
       AND a.is_active = true
     ORDER BY u.full_name NULLS LAST, a.recruiter_code`,
    [requisition.requisition_code]
  );

  return result.rows.map(mapAssignmentForManagementUi);
}

async function listFormRecruiters(pool) {
  const result = await pool.query(
    `SELECT employee_code, full_name
     FROM user_mstr
     WHERE role_name = 'Recruiter' AND is_active = true
     ORDER BY full_name`
  );

  return result.rows;
}

async function listFormClients(pool) {
  const result = await pool.query(
    `SELECT *
     FROM client_mstr
     WHERE is_active = true
     ORDER BY client_name`
  );

  return result.rows;
}

async function listFormProjectsByClient(pool, clientId) {
  const result = await pool.query(
    `SELECT *
     FROM project_mstr
     WHERE client_id = $1 AND is_active = true
     ORDER BY project_name`,
    [clientId]
  );

  return result.rows;
}

async function listFormHiringManagersByProject(pool, projectId) {
  const result = await pool.query(
    `SELECT *
     FROM hiring_manager_mstr
     WHERE project_id = $1 AND is_active = true
     ORDER BY hiring_manager_name`,
    [projectId]
  );

  return result.rows;
}

async function removeRecruiterAssignment(pool, mapId, req) {
  const user = userContext(req);
  const platformConfig = await loadPlatformConfig(pool);
  await assertRecruitmentModuleEnabled(platformConfig);
  await assertCanAssignRecruiter(pool, req);

  const target = await resolveRecruiterAssignmentTarget(pool, mapId);
  const assignment = target.assignment;

  const updated = await pool.query(
    `UPDATE rm_recruiter_assignments
     SET is_active = false, modified_on = NOW()
     WHERE assignment_id = $1 AND is_active = true
     RETURNING *`,
    [assignment.assignment_id]
  );

  if (!updated.rows.length) {
    throw httpError("Assignment not found or already removed.", 404);
  }

  let legacyResponseRow = null;

  if (isLegacyDualWriteEnabled() && (await tableExists(pool, "req_recruiter_map"))) {
    const legacyMapId = target.legacyMapId || mapId;
    const legacyUpdate = await pool.query(
      `UPDATE req_recruiter_map
       SET is_active = false
       WHERE map_id = $1
       RETURNING *`,
      [legacyMapId]
    );
    legacyResponseRow = legacyUpdate.rows[0] || null;
  } else if (target.legacyRow) {
    legacyResponseRow = { ...target.legacyRow, is_active: false };
  }

  await writeEnterpriseAudit(pool, {
    eventType: "RecruiterUnassigned",
    module: "Recruitment Management",
    entity: "Requisition",
    entityId: assignment.requisition_code,
    action: `Recruiter ${assignment.recruiter_code} unassigned from ${assignment.requisition_code}`,
    previousValue: "Active",
    newValue: "Inactive",
    userName: user.name,
    userRole: user.role,
    metadata: {
      assignmentId: assignment.assignment_id,
      legacyMapId: target.legacyMapId,
      resolution: target.resolution,
      reqId: assignment.req_id,
      recruiterCode: assignment.recruiter_code
    }
  });

  return {
    assignment: updated.rows[0],
    legacyMapping: legacyResponseRow,
    responseData: legacyResponseRow || {
      map_id: target.legacyMapId || mapId,
      assignment_id: updated.rows[0].assignment_id,
      req_id: updated.rows[0].req_id,
      requisition_code: updated.rows[0].requisition_code,
      recruiter_code: updated.rows[0].recruiter_code,
      is_active: false
    },
    toastMessage: "Recruiter removed successfully."
  };
}

/**
 * Release Candidate — inverse of mapCandidate.
 * Deactivates active requisition assignment(s) and returns the candidate
 * to Enterprise Talent Pool (unowned). Does not unregister or delete.
 */
async function releaseCandidate(pool, candidateId, req) {
  const user = userContext(req);
  await assertAuthorizedRelease(pool, req, candidateId);
  const legacyMapTableExists = await tableExists(pool, "candidate_req_map");

  const client = await pool.connect();
  let primaryMapping = null;

  try {
    await client.query("BEGIN");

    // Step 1 — same lock strategy as mapCandidate
    await client.query(
      `SELECT candidate_id, candidate_container, owner_employee_code
       FROM cand_mstr
       WHERE candidate_id = $1
       FOR UPDATE`,
      [candidateId]
    );

    // Step 2 — verify at least one ACTIVE assignment under the lock
    const activeEnterprise = await client.query(
      `SELECT mapping_id, candidate_id, requisition_code, map_id
       FROM rm_candidate_mappings
       WHERE candidate_id = $1
         AND is_active = true
       ORDER BY applied_on DESC`,
      [candidateId]
    );

    let activeLegacy = { rows: [] };
    if (legacyMapTableExists) {
      activeLegacy = await client.query(
        `SELECT map_id, candidate_id, req_id
         FROM candidate_req_map
         WHERE candidate_id = $1
           AND is_active = true`,
        [candidateId]
      );
    }

    if (activeEnterprise.rows.length === 0 && activeLegacy.rows.length === 0) {
      throw httpError("No active requisition mapping found.", 404);
    }

    primaryMapping = activeEnterprise.rows[0] || null;

    // Step 3 — deactivate ACTIVE mapping(s); preserve history rows
    if (activeEnterprise.rows.length > 0) {
      await client.query(
        `UPDATE rm_candidate_mappings
         SET is_active = false,
             modified_on = NOW()
         WHERE candidate_id = $1
           AND is_active = true`,
        [candidateId]
      );
    }

    if (legacyMapTableExists && activeLegacy.rows.length > 0) {
      await client.query(
        `UPDATE candidate_req_map
         SET is_active = false
         WHERE candidate_id = $1
           AND is_active = true`,
        [candidateId]
      );
    }

    // Step 4 — return to Talent Pool (unowned). Step 5 — leave
    // registered_by, registered_on, recruiter_id, candidate_status unchanged.
    await client.query(
      `UPDATE cand_mstr
       SET candidate_container = 'TALENT_POOL',
           owner_employee_code = NULL
       WHERE candidate_id = $1`,
      [candidateId]
    );

    if (primaryMapping) {
      await client.query(
        `INSERT INTO rm_pipeline_history (
          requisition_code, mapping_id, candidate_id, event_type,
          actor, actor_role, comments, metadata
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          primaryMapping.requisition_code,
          primaryMapping.mapping_id,
          primaryMapping.candidate_id,
          "CandidateReleased",
          user.name,
          user.role,
          "Candidate released from requisition",
          JSON.stringify({
            actorCode: req.user?.employee_code || null
          })
        ]
      );
    }

    // Step 6
    await client.query("COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (_rollbackError) {
      // ignore rollback failures
    }
    throw error;
  } finally {
    client.release();
  }

  await writeEnterpriseAudit(pool, {
    eventType: "CandidateReleased",
    module: "Recruitment Management",
    entity: "Candidate",
    entityId: String(candidateId),
    action: primaryMapping
      ? `Candidate released from requisition ${primaryMapping.requisition_code}`
      : "Candidate released from active requisition",
    previousValue: "PIPELINE",
    newValue: "TALENT_POOL",
    userName: user.name,
    userRole: user.role,
    metadata: {
      mappingId: primaryMapping?.mapping_id || null,
      requisitionCode: primaryMapping?.requisition_code || null
    }
  });

  return {
    message: "Candidate released from active requisition.",
    mapping: primaryMapping
  };
}

/**
 * Return to Talent Pool — release PIPELINE ownership without an active assignment.
 * Separate from releaseCandidate (which requires an active requisition mapping).
 */
async function returnCandidateToTalentPool(pool, candidateId, req) {
  const user = userContext(req);
  const employeeCode = recruiterEmployeeCode(req);
  const legacyMapTableExists = await tableExists(pool, "candidate_req_map");

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const candLock = await client.query(
      `SELECT candidate_id, candidate_container, owner_employee_code
       FROM cand_mstr
       WHERE candidate_id = $1
       FOR UPDATE`,
      [candidateId]
    );
    const candRow = candLock.rows[0];

    if (!candRow) {
      throw httpError("Candidate not found.", 404);
    }

    if (String(candRow.candidate_container || "").toUpperCase() !== "PIPELINE") {
      throw httpError(
        "Only Pipeline candidates can be returned to the Enterprise Talent Pool.",
        400
      );
    }

    if (candRow.owner_employee_code !== employeeCode) {
      throw httpError(
        "Only the current owner can return this candidate to the Enterprise Talent Pool.",
        403
      );
    }

    const activeEnterprise = await client.query(
      `SELECT mapping_id
       FROM rm_candidate_mappings
       WHERE candidate_id = $1
         AND is_active = true
       LIMIT 1`,
      [candidateId]
    );

    if (activeEnterprise.rows.length > 0) {
      throw httpError(
        "Candidate has an active requisition assignment. Use Release Candidate instead.",
        400
      );
    }

    if (legacyMapTableExists) {
      const activeLegacy = await client.query(
        `SELECT map_id
         FROM candidate_req_map
         WHERE candidate_id = $1
           AND is_active = true
         LIMIT 1`,
        [candidateId]
      );

      if (activeLegacy.rows.length > 0) {
        throw httpError(
          "Candidate has an active requisition assignment. Use Release Candidate instead.",
          400
        );
      }
    }

    await client.query(
      `UPDATE cand_mstr
       SET candidate_container = 'TALENT_POOL',
           owner_employee_code = NULL
       WHERE candidate_id = $1`,
      [candidateId]
    );

    await client.query(
      `INSERT INTO rm_pipeline_history (
        requisition_code, mapping_id, candidate_id, event_type,
        actor, actor_role, comments, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        null,
        null,
        candidateId,
        "ReturnedToTalentPool",
        user.name,
        user.role,
        "Candidate returned to Enterprise Talent Pool",
        JSON.stringify({ ownerReleased: employeeCode })
      ]
    );

    await client.query("COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (_rollbackError) {
      // ignore rollback failures
    }
    throw error;
  } finally {
    client.release();
  }

  await writeEnterpriseAudit(pool, {
    eventType: "ReturnedToTalentPool",
    module: "Recruitment Management",
    entity: "Candidate",
    entityId: String(candidateId),
    action: "Candidate returned to Enterprise Talent Pool",
    previousValue: "PIPELINE",
    newValue: "TALENT_POOL",
    userName: user.name,
    userRole: user.role,
    metadata: { ownerReleased: employeeCode }
  });

  return {
    message: "Candidate returned to Enterprise Talent Pool."
  };
}

/**
 * List Active approved positions for Talent Demand draft selection.
 * Read-only catalogue lookup — no workflow / assignment changes.
 */
async function listApprovedPositions(pool) {
  const result = await pool.query(
    `SELECT
       p.position_id,
       p.position_title,
       p.department,
       p.grade,
       p.headcount,
       p.status,
       p.remaining_budget,
       p.expiry_date
     FROM wp_approved_positions p
     WHERE LOWER(COALESCE(p.status, 'active')) = 'active'
       AND NOT EXISTS (
         SELECT 1
         FROM rm_requisitions r
         WHERE r.approved_position_id = p.position_id
       )
     ORDER BY p.position_title ASC, p.position_id ASC`
  );

  return result.rows.map((row) => ({
    position_id: row.position_id,
    position_title: row.position_title,
    department: row.department,
    grade: row.grade,
    headcount: row.headcount,
    status: row.status,
    remaining_budget: row.remaining_budget,
    expiry_date: row.expiry_date
  }));
}

const CANDIDATE_PORTAL_REQUISITION_INTERNAL_FIELDS = [
  "req_id",
  "approved_position_id",
  "budget_approved",
  "hiring_manager",
  "hiring_manager_id",
  "recruiter_id",
  "workflow_instance_id",
  "version",
  "version_status",
  "candidate_portal_published_at",
  "candidate_portal_published_by",
  "effective_from",
  "effective_to",
  "created_by",
  "modified_by",
  "created_on",
  "modified_on",
  "client_id",
  "project_id",
  "business_unit",
  "approval_route_id",
  "requestor_submitted_on",
  "priority_level",
  "target_date",
  "grade"
];

function mapRequisitionForCandidatePortal(row) {
  return {
    requisition_code: row.requisition_code,
    title: row.position_title,
    location: row.location,
    department: row.department,
    employment_type: row.employment_type,
    primary_skill: row.primary_skill,
    secondary_skill: row.secondary_skill,
    experience_min: row.experience_min,
    experience_max: row.experience_max,
    openings_count: row.headcount,
    job_description: row.job_description
  };
}

/**
 * Candidate portal job discovery — Approved + explicitly published requisitions only.
 * Read-only; excludes internal recruiter/approval/budget metadata.
 */
async function listOpenRequisitionsForCandidatePortal(pool) {
  const result = await pool.query(
    `SELECT
       r.requisition_code,
       r.position_title,
       r.location,
       r.department,
       r.employment_type,
       r.primary_skill,
       r.secondary_skill,
       r.experience_min,
       r.experience_max,
       r.headcount,
       r.job_description
     FROM rm_requisitions r
     WHERE r.req_status = $1
       AND r.candidate_portal_published_at IS NOT NULL
     ORDER BY r.created_on DESC`,
    [REQUISITION_STATUS.APPROVED]
  );

  return result.rows.map(mapRequisitionForCandidatePortal);
}

async function loadOpenRequisitionForCandidatePortal(pool, requisitionCode) {
  const code = String(requisitionCode || "").trim();

  if (!code) {
    throw httpError("requisition_code is required.", 400);
  }

  const result = await pool.query(
    `SELECT
       requisition_code,
       position_title,
       req_id,
       department,
       req_status
     FROM rm_requisitions
     WHERE requisition_code = $1
       AND req_status = $2
       AND candidate_portal_published_at IS NOT NULL
     LIMIT 1`,
    [code, REQUISITION_STATUS.APPROVED]
  );

  if (!result.rows[0]) {
    throw httpError("Requisition is not available for applications.", 404);
  }

  return result.rows[0];
}

async function publishRequisitionToCandidatePortal(pool, requisitionCode, req) {
  const user = userContext(req);
  await assertCanPublishToCandidatePortal(pool, req);

  const code = String(requisitionCode || "").trim();
  if (!code) {
    throw httpError("requisition_code is required.", 400);
  }

  const requisition = await loadRequisitionByCode(pool, code);
  if (!requisition) {
    throw httpError(`Requisition not found: ${code}`, 404);
  }

  if (requisition.req_status !== REQUISITION_STATUS.APPROVED) {
    throw httpError(
      "Only Approved requisitions can be published to the Candidate Portal.",
      400
    );
  }

  assertRequisitionOpenForRecruiting(requisition);

  if (requisition.candidate_portal_published_at) {
    return {
      success: true,
      requisition: mapRequisitionForManagementUi(requisition),
      alreadyPublished: true,
      toastMessage: "Requisition is already published to the Candidate Portal."
    };
  }

  const updated = await pool.query(
    `UPDATE rm_requisitions
     SET candidate_portal_published_at = NOW(),
         candidate_portal_published_by = $1,
         modified_by = $1,
         modified_on = NOW()
     WHERE requisition_code = $2
     RETURNING *`,
    [user.name, code]
  );

  await writeEnterpriseAudit(pool, {
    eventType: "RequisitionPublishedToCandidatePortal",
    module: "Recruitment Management",
    entity: "Requisition",
    entityId: code,
    action: `Requisition ${code} published to Candidate Portal`,
    previousValue: null,
    newValue: updated.rows[0].candidate_portal_published_at?.toISOString?.()
      || String(updated.rows[0].candidate_portal_published_at),
    userName: user.name,
    userRole: user.role,
    metadata: {
      candidate_portal_published_by: user.name
    }
  });

  return {
    success: true,
    requisition: mapRequisitionForManagementUi(updated.rows[0]),
    alreadyPublished: false,
    toastMessage: `Requisition ${code} published to the Candidate Portal.`
  };
}

async function unpublishRequisitionFromCandidatePortal(pool, requisitionCode, req) {
  const user = userContext(req);
  await assertCanPublishToCandidatePortal(pool, req);

  const code = String(requisitionCode || "").trim();
  if (!code) {
    throw httpError("requisition_code is required.", 400);
  }

  const requisition = await loadRequisitionByCode(pool, code);
  if (!requisition) {
    throw httpError(`Requisition not found: ${code}`, 404);
  }

  if (requisition.req_status !== REQUISITION_STATUS.APPROVED) {
    throw httpError(
      "Only Approved requisitions can be unpublished from the Candidate Portal.",
      400
    );
  }

  if (!requisition.candidate_portal_published_at) {
    return {
      success: true,
      requisition: mapRequisitionForManagementUi(requisition),
      alreadyUnpublished: true,
      toastMessage: "Requisition is not published to the Candidate Portal."
    };
  }

  const previousPublishedAt = requisition.candidate_portal_published_at;

  const updated = await pool.query(
    `UPDATE rm_requisitions
     SET candidate_portal_published_at = NULL,
         candidate_portal_published_by = NULL,
         modified_by = $1,
         modified_on = NOW()
     WHERE requisition_code = $2
     RETURNING *`,
    [user.name, code]
  );

  await writeEnterpriseAudit(pool, {
    eventType: "RequisitionUnpublishedFromCandidatePortal",
    module: "Recruitment Management",
    entity: "Requisition",
    entityId: code,
    action: `Requisition ${code} unpublished from Candidate Portal`,
    previousValue: previousPublishedAt?.toISOString?.() || String(previousPublishedAt),
    newValue: null,
    userName: user.name,
    userRole: user.role,
    metadata: {
      candidate_portal_unpublished_by: user.name
    }
  });

  return {
    success: true,
    requisition: mapRequisitionForManagementUi(updated.rows[0]),
    alreadyUnpublished: false,
    toastMessage: `Requisition ${code} unpublished from the Candidate Portal.`
  };
}

async function resolvePortalApplyRecruiterContext(pool, requisitionCode) {
  const result = await pool.query(
    `SELECT a.recruiter_code, u.full_name
     FROM rm_recruiter_assignments a
     LEFT JOIN user_mstr u ON u.employee_code = a.recruiter_code
     WHERE a.requisition_code = $1
       AND a.is_active = true
     ORDER BY a.assigned_on ASC, a.assignment_id ASC
     LIMIT 1`,
    [requisitionCode]
  );

  const row = result.rows[0];

  return {
    employee_code: row?.recruiter_code || null,
    full_name: row?.full_name || row?.recruiter_code || "Candidate Portal"
  };
}

function mapApplicationForCandidatePortal(mapping, requisition) {
  return {
    requisition_code: mapping.requisition_code,
    title: requisition?.position_title || null,
    stage_name: mapping.stage_name,
    applied_on: mapping.applied_on
  };
}

function buildCandidatePortalApplyRequest(candidateContext, recruiterContext) {
  return {
    candidatePortalApply: true,
    user: {
      employee_code: recruiterContext.employee_code,
      full_name: candidateContext.full_name || candidateContext.email_id || "Candidate",
      email_id: candidateContext.email_id,
      role_name: "Candidate"
    }
  };
}

/**
 * Candidate portal apply — governed mapCandidate path with portal auth context.
 */
async function applyCandidateFromPortal(pool, candidateContext, body = {}) {
  const candidateId = Number(candidateContext?.candidate_id);

  if (!Number.isInteger(candidateId) || candidateId <= 0) {
    throw httpError("Invalid candidate session.", 401);
  }

  const requisitionCode = String(body.requisition_code || "").trim();

  if (!requisitionCode) {
    throw httpError("requisition_code is required.", 400);
  }

  const candidateCheck = await pool.query(
    `SELECT c.candidate_id
     FROM cand_mstr c
     INNER JOIN candidate_portal_account a
       ON a.candidate_id = c.candidate_id
     WHERE c.candidate_id = $1
     LIMIT 1`,
    [candidateId]
  );

  if (!candidateCheck.rows[0]) {
    throw httpError("Candidate profile not found.", 404);
  }

  const emailId = String(candidateContext.email_id || "").trim();
  const candidateCountBefore = await pool.query(
    `SELECT COUNT(*)::int AS total
     FROM cand_mstr
     WHERE LOWER(email_id) = LOWER($1)`,
    [emailId]
  );

  if ((candidateCountBefore.rows[0]?.total || 0) !== 1) {
    throw httpError("Candidate profile not found.", 404);
  }

  const requisition = await loadOpenRequisitionForCandidatePortal(
    pool,
    requisitionCode
  );
  const recruiterContext = await resolvePortalApplyRecruiterContext(
    pool,
    requisition.requisition_code
  );
  const portalReq = buildCandidatePortalApplyRequest(
    candidateContext,
    recruiterContext
  );

  const {
    assertCandidatePortalApplicationReady
  } = require("./candidatePortalProfileService");
  await assertCandidatePortalApplicationReady(pool, candidateId);

  const mapResult = await mapCandidate(
    pool,
    {
      candidate_id: candidateId,
      requisition_code: requisition.requisition_code,
      stage_name: "Applied",
      remarks: "Applied via Candidate Portal"
    },
    portalReq
  );

  if (Number(mapResult.mapping?.candidate_id) !== candidateId) {
    throw httpError("Application could not be linked to your candidate profile.", 500);
  }

  const candidateCountAfter = await pool.query(
    `SELECT COUNT(*)::int AS total
     FROM cand_mstr
     WHERE LOWER(email_id) = LOWER($1)`,
    [emailId]
  );

  if (candidateCountAfter.rows[0]?.total !== candidateCountBefore.rows[0]?.total) {
    throw httpError("Application could not be linked to your candidate profile.", 500);
  }

  const application = mapApplicationForCandidatePortal(
    mapResult.mapping,
    requisition
  );

  try {
    const candidatePortalNotificationService = require(
      "./candidatePortalNotificationService"
    );

    await candidatePortalNotificationService.notifyApplicationSubmitted(pool, {
      candidateContext,
      application,
      mappingId: mapResult.mapping.mapping_id
    });
  } catch (notificationError) {
    console.error(
      "[applyCandidateFromPortal] application_submitted notification failed:",
      notificationError.message
    );
  }

  return application;
}

const CANDIDATE_PORTAL_APPLY_REMARKS = "Applied via Candidate Portal";

function mapPendingPortalApplicationRow(row) {
  const firstName = String(row.first_name || "").trim();
  const lastName = String(row.last_name || "").trim();
  const candidateName = [firstName, lastName].filter(Boolean).join(" ").trim();

  return {
    mapping_id: row.mapping_id,
    map_id: row.map_id,
    candidate_id: row.candidate_id,
    candidate_code: row.candidate_code,
    candidate_name: candidateName || null,
    email_id: row.email_id,
    requisition_code: row.requisition_code,
    position_title: row.position_title || null,
    stage_name: row.stage_name,
    applied_on: row.applied_on,
    remarks: row.remarks
  };
}

/**
 * Assignment-scoped pending Candidate Portal applications (unowned, Applied).
 */
async function listPendingPortalApplications(pool, req) {
  const employeeCode = recruiterEmployeeCode(req);

  const result = await pool.query(
    `SELECT
        m.mapping_id,
        m.map_id,
        m.candidate_id,
        m.requisition_code,
        m.stage_name,
        m.applied_on,
        m.remarks,
        c.candidate_code,
        c.first_name,
        c.last_name,
        c.email_id,
        r.position_title
     FROM rm_candidate_mappings m
     INNER JOIN cand_mstr c
       ON c.candidate_id = m.candidate_id
     INNER JOIN rm_requisitions r
       ON r.requisition_code = m.requisition_code
     INNER JOIN rm_recruiter_assignments a
       ON a.requisition_code = m.requisition_code
      AND a.is_active = true
      AND a.recruiter_code = $1
     WHERE m.is_active = true
       AND c.owner_employee_code IS NULL
       AND LOWER(TRIM(COALESCE(m.stage_name, ''))) LIKE '%applied%'
       AND m.remarks = $2
     ORDER BY m.applied_on DESC NULLS LAST, m.mapping_id DESC`,
    [employeeCode, CANDIDATE_PORTAL_APPLY_REMARKS]
  );

  return result.rows.map(mapPendingPortalApplicationRow);
}

/**
 * Claim ownership of an unowned portal application on an assigned requisition.
 */
async function claimPendingPortalApplication(pool, mappingId, req) {
  const employeeCode = recruiterEmployeeCode(req);
  const normalizedMappingId = Number(mappingId);

  if (!Number.isInteger(normalizedMappingId) || normalizedMappingId <= 0) {
    throw httpError("Invalid mapping_id.", 400);
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const mappingResult = await client.query(
      `SELECT mapping_id, candidate_id, requisition_code, stage_name, remarks, is_active
       FROM rm_candidate_mappings
       WHERE mapping_id = $1
       FOR UPDATE`,
      [normalizedMappingId]
    );

    const mapping = mappingResult.rows[0];

    if (!mapping || !mapping.is_active) {
      throw httpError("Application mapping not found.", 404);
    }

    if (mapping.remarks !== CANDIDATE_PORTAL_APPLY_REMARKS) {
      throw httpError("This mapping is not a Candidate Portal application.", 400);
    }

    if (!/applied/i.test(String(mapping.stage_name || ""))) {
      throw httpError("Only Applied-stage portal applications can be claimed.", 400);
    }

    const assignmentResult = await client.query(
      `SELECT assignment_id
       FROM rm_recruiter_assignments
       WHERE recruiter_code = $1
         AND requisition_code = $2
         AND is_active = true
       LIMIT 1`,
      [employeeCode, mapping.requisition_code]
    );

    if (!assignmentResult.rows.length) {
      throw httpError(
        "Enterprise Access Denied. You are not assigned to this requisition.",
        403
      );
    }

    const candResult = await client.query(
      `SELECT candidate_id, candidate_container, owner_employee_code
       FROM cand_mstr
       WHERE candidate_id = $1
       FOR UPDATE`,
      [mapping.candidate_id]
    );

    const candRow = candResult.rows[0];

    if (!candRow) {
      throw httpError("Candidate not found.", 404);
    }

    if (String(candRow.owner_employee_code || "").trim()) {
      throw httpError("Candidate ownership has already been claimed.", 409);
    }

    const updateResult = await client.query(
      `UPDATE cand_mstr
       SET owner_employee_code = $1,
           candidate_container = 'PIPELINE'
       WHERE candidate_id = $2
         AND owner_employee_code IS NULL
       RETURNING candidate_id, owner_employee_code, candidate_container`,
      [employeeCode, mapping.candidate_id]
    );

    if (!updateResult.rows.length) {
      throw httpError("Candidate ownership has already been claimed.", 409);
    }

    await client.query("COMMIT");

    return {
      mapping_id: mapping.mapping_id,
      candidate_id: mapping.candidate_id,
      requisition_code: mapping.requisition_code,
      owner_employee_code: employeeCode,
      candidate_container: updateResult.rows[0].candidate_container
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (_rollbackError) {
      // ignore rollback failures
    }
    throw error;
  } finally {
    client.release();
  }
}

const CANDIDATE_PORTAL_APPLICATION_ALLOWED_FIELDS = new Set([
  "requisition_code",
  "title",
  "location",
  "stage_name",
  "applied_on"
]);

function mapCandidatePortalApplicationListItem(row, resolveStage) {
  const stage = resolveStage(row.stage_name);

  return {
    requisition_code: row.requisition_code,
    title: row.position_title || null,
    location: row.location || null,
    stage_name: stage?.stage_name || null,
    applied_on: row.applied_on
  };
}

/**
 * Candidate portal My Applications — Enterprise rm_candidate_mappings read.
 */
async function listCandidatePortalApplications(pool, candidateContext) {
  const candidateId = Number(candidateContext?.candidate_id);

  if (!Number.isInteger(candidateId) || candidateId <= 0) {
    throw httpError("Invalid candidate session.", 401);
  }

  const result = await pool.query(
    `SELECT
       m.requisition_code,
       m.stage_name,
       m.applied_on,
       r.position_title,
       r.location
     FROM rm_candidate_mappings m
     INNER JOIN rm_requisitions r
       ON r.requisition_code = m.requisition_code
     WHERE m.candidate_id = $1
     ORDER BY m.applied_on DESC, m.mapping_id DESC`,
    [candidateId]
  );

  const resolveStage = await buildCandidateFacingStageResolver(pool);

  return result.rows.map((row) =>
    mapCandidatePortalApplicationListItem(row, resolveStage)
  );
}

async function loadRequisitionByCode(queryable, code) {
  const requisitionCode = String(code || "").trim();
  if (!requisitionCode) {
    throw httpError("requisition code is required.", 400);
  }

  const result = await queryable.query(
    `SELECT r.*,
      p.position_title AS approved_position_title,
      p.department AS approved_department,
      p.grade AS approved_grade,
      p.headcount AS approved_headcount,
      p.expiry_date AS approved_expiry_date,
      p.remaining_budget AS approved_remaining_budget
     FROM rm_requisitions r
     LEFT JOIN wp_approved_positions p ON r.approved_position_id = p.position_id
     WHERE r.requisition_code = $1`,
    [requisitionCode]
  );

  return result.rows[0] || null;
}

async function getRequisitionForRequestor(pool, code, req) {
  const requisition = await loadRequisitionByCode(pool, code);

  if (!requisition) {
    throw httpError(`Requisition not found: ${code}`, 404);
  }

  await assertRequisitionRequestorOwnerAccess(pool, req, requisition);

  return requisition;
}

function blankToNull(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text === "" ? null : value;
}

function assertExistingRequisitionEditable(requisition) {
  const status = String(requisition.req_status || "").trim();
  if (
    status === REQUISITION_STATUS.APPROVED ||
    status === REQUISITION_STATUS.REJECTED ||
    isClosedRequisitionStatus(status)
  ) {
    throw httpError(
      `Requisition ${requisition.requisition_code} is ${status} and cannot be edited.`,
      400
    );
  }
}

function assertRequestorSubmitReadiness(requisition) {
  const errors = [];

  if (requisition.requestor_submitted_on) {
    throw httpError(
      `Requisition ${requisition.requisition_code} has already been submitted.`,
      409
    );
  }

  if (!blankToNull(requisition.approval_route_id)) {
    errors.push("approval_route_id is required before submit.");
  }
  if (!blankToNull(requisition.business_unit)) {
    errors.push("client_name is required before submit.");
  }
  if (!blankToNull(requisition.position_title)) {
    errors.push("job_title is required before submit.");
  }
  if (!blankToNull(requisition.primary_skill)) {
    errors.push("primary_skill is required before submit.");
  }
  if (!blankToNull(requisition.location)) {
    errors.push("work_location is required before submit.");
  }
  if (!blankToNull(requisition.employment_type)) {
    errors.push("employment_type is required before submit.");
  }
  if (!blankToNull(requisition.priority_level)) {
    errors.push("priority_level is required before submit.");
  }
  if (!blankToNull(requisition.target_date)) {
    errors.push("target_date is required before submit.");
  }
  if (
    requisition.experience_min != null &&
    requisition.experience_max != null &&
    Number(requisition.experience_min) > Number(requisition.experience_max)
  ) {
    errors.push("experience_min cannot be greater than experience_max.");
  }

  if (errors.length > 0) {
    throw httpError(errors.join(" "), 400);
  }
}

/**
 * Map Talent Demand editor payload onto rm_requisitions columns.
 * Never creates a requisition and never changes requisition_code / approved_position_id.
 */
function buildRequisitionUpdateFields(payload = {}) {
  const openings =
    payload.openings_count !== undefined && payload.openings_count !== ""
      ? Number(payload.openings_count)
      : undefined;

  return {
    business_unit:
      payload.client_name !== undefined
        ? blankToNull(payload.client_name)
        : undefined,
    department:
      payload.project_name !== undefined
        ? (() => {
            const normalized = blankToNull(payload.project_name);
            // rm_requisitions.department is the approved-position org department.
            // Legacy editor round-trips it via project_name; an empty optional
            // project selection must not null out the existing department.
            return normalized === null ? undefined : normalized;
          })()
        : undefined,
    position_title:
      payload.job_title !== undefined
        ? blankToNull(payload.job_title)
        : undefined,
    job_description:
      payload.job_description !== undefined
        ? blankToNull(payload.job_description)
        : undefined,
    primary_skill:
      payload.primary_skill !== undefined
        ? blankToNull(payload.primary_skill)
        : undefined,
    secondary_skill:
      payload.secondary_skill !== undefined
        ? blankToNull(payload.secondary_skill)
        : undefined,
    experience_min:
      payload.experience_min !== undefined
        ? payload.experience_min === "" || payload.experience_min === null
          ? null
          : Number(payload.experience_min)
        : undefined,
    experience_max:
      payload.experience_max !== undefined
        ? payload.experience_max === "" || payload.experience_max === null
          ? null
          : Number(payload.experience_max)
        : undefined,
    headcount:
      openings !== undefined && !Number.isNaN(openings) ? openings : undefined,
    location:
      payload.work_location !== undefined
        ? blankToNull(payload.work_location)
        : undefined,
    employment_type:
      payload.employment_type !== undefined
        ? blankToNull(payload.employment_type)
        : undefined,
    priority_level:
      payload.priority_level !== undefined
        ? blankToNull(payload.priority_level)
        : undefined,
    hiring_manager:
      payload.hiring_manager !== undefined
        ? blankToNull(payload.hiring_manager)
        : undefined,
    hiring_manager_id:
      payload.hiring_manager_id !== undefined
        ? payload.hiring_manager_id === "" || payload.hiring_manager_id === null
          ? null
          : Number(payload.hiring_manager_id)
        : undefined,
    target_date:
      payload.target_date !== undefined
        ? blankToNull(payload.target_date)
        : undefined,
    approval_route_id:
      payload.approval_route_id !== undefined || payload.route_id !== undefined
        ? blankToNull(payload.approval_route_id ?? payload.route_id)
        : undefined,
    client_id:
      payload.client_id !== undefined
        ? payload.client_id === "" || payload.client_id === null
          ? null
          : Number(payload.client_id)
        : undefined,
    project_id:
      payload.project_id !== undefined
        ? payload.project_id === "" || payload.project_id === null
          ? null
          : Number(payload.project_id)
        : undefined,
    recruiter_id:
      payload.recruiter_id !== undefined
        ? blankToNull(payload.recruiter_id)
        : undefined
  };
}

/**
 * Update existing operational requisition only. Never creates a requisition.
 */
async function updateRequisition(pool, code, payload, req) {
  const user = userContext(req);
  const platformConfig = await loadPlatformConfig(pool);
  await assertRecruitmentModuleEnabled(platformConfig);

  const existing = await loadRequisitionByCode(pool, code);
  if (!existing) {
    throw httpError(`Requisition not found: ${code}`, 404);
  }

  await assertRequisitionRequestorOwnerAccess(pool, req, existing);

  assertExistingRequisitionEditable(existing);

  const fields = buildRequisitionUpdateFields(payload || {});

  const mdPayload = {};
  if (fields.primary_skill !== undefined) {
    mdPayload.primary_skill = fields.primary_skill;
  }
  if (fields.secondary_skill !== undefined) {
    mdPayload.secondary_skill = fields.secondary_skill;
  }
  if (Object.keys(mdPayload).length > 0) {
    const mdValidation = await validateMasterDataReferences(pool, mdPayload);
    if (!mdValidation.valid) {
      throw httpError(mdValidation.errors.join(" "), 400);
    }
  }

  const setClauses = [];
  const params = [];
  let idx = 1;

  const columnMap = [
    ["business_unit", fields.business_unit],
    ["department", fields.department],
    ["position_title", fields.position_title],
    ["job_description", fields.job_description],
    ["primary_skill", fields.primary_skill],
    ["secondary_skill", fields.secondary_skill],
    ["experience_min", fields.experience_min],
    ["experience_max", fields.experience_max],
    ["headcount", fields.headcount],
    ["location", fields.location],
    ["employment_type", fields.employment_type],
    ["priority_level", fields.priority_level],
    ["hiring_manager", fields.hiring_manager],
    ["hiring_manager_id", fields.hiring_manager_id],
    ["target_date", fields.target_date],
    ["approval_route_id", fields.approval_route_id],
    ["client_id", fields.client_id],
    ["project_id", fields.project_id],
    ["recruiter_id", fields.recruiter_id]
  ];

  for (const [column, value] of columnMap) {
    if (value !== undefined) {
      setClauses.push(`${column} = $${idx}`);
      params.push(value);
      idx += 1;
    }
  }

  if (setClauses.length === 0) {
    return {
      success: true,
      requisition: existing,
      toastMessage: `Requisition ${existing.requisition_code} unchanged.`
    };
  }

  setClauses.push(`modified_by = $${idx}`);
  params.push(user.name);
  idx += 1;
  setClauses.push("modified_on = NOW()");
  params.push(existing.requisition_code);

  const updated = await pool.query(
    `UPDATE rm_requisitions
     SET ${setClauses.join(", ")}
     WHERE requisition_code = $${idx}
     RETURNING *`,
    params
  );

  const requisition = updated.rows[0];

  if (
    isLegacyDualWriteEnabled() &&
    requisition.req_id &&
    (await tableExists(pool, "req_mstr"))
  ) {
    await pool.query(
      `UPDATE req_mstr SET
         client_name = COALESCE($1, client_name),
         project_name = COALESCE($2, project_name),
         job_title = COALESCE($3, job_title),
         job_description = COALESCE($4, job_description),
         primary_skill = COALESCE($5, primary_skill),
         secondary_skill = COALESCE($6, secondary_skill),
         experience_min = COALESCE($7, experience_min),
         experience_max = COALESCE($8, experience_max),
         openings_count = COALESCE($9, openings_count),
         work_location = COALESCE($10, work_location),
         employment_type = COALESCE($11, employment_type),
         priority_level = COALESCE($12, priority_level),
         hiring_manager = COALESCE($13, hiring_manager),
         target_date = COALESCE($14, target_date),
         approval_route_id = COALESCE($15, approval_route_id),
         updated_on = CURRENT_TIMESTAMP
       WHERE req_id = $16`,
      [
        fields.business_unit !== undefined ? fields.business_unit : null,
        fields.department !== undefined ? fields.department : null,
        fields.position_title !== undefined ? fields.position_title : null,
        fields.job_description !== undefined ? fields.job_description : null,
        fields.primary_skill !== undefined ? fields.primary_skill : null,
        fields.secondary_skill !== undefined ? fields.secondary_skill : null,
        fields.experience_min !== undefined ? fields.experience_min : null,
        fields.experience_max !== undefined ? fields.experience_max : null,
        fields.headcount !== undefined ? fields.headcount : null,
        fields.location !== undefined ? fields.location : null,
        fields.employment_type !== undefined ? fields.employment_type : null,
        fields.priority_level !== undefined ? fields.priority_level : null,
        fields.hiring_manager !== undefined ? fields.hiring_manager : null,
        fields.target_date !== undefined ? fields.target_date : null,
        fields.approval_route_id !== undefined ? fields.approval_route_id : null,
        requisition.req_id
      ]
    );
  }

  await writeEnterpriseAudit(pool, {
    eventType: "RequisitionUpdated",
    module: "Recruitment Management",
    entity: "Requisition",
    entityId: requisition.requisition_code,
    action: `Requisition ${requisition.requisition_code} updated by requestor`,
    userName: user.name,
    userRole: user.role,
    metadata: { fields: Object.keys(fields).filter((k) => fields[k] !== undefined) }
  });

  return {
    success: true,
    requisition,
    toastMessage: `Requisition ${requisition.requisition_code} updated.`
  };
}

/**
 * Submit existing operational requisition into its existing workflow.
 * Never creates a requisition. Never starts a second workflow when one exists.
 */
async function submitRequisition(pool, code, payload, req) {
  const user = userContext(req);
  const platformConfig = await loadPlatformConfig(pool);
  await assertRecruitmentModuleEnabled(platformConfig);

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const existing = await loadRequisitionByCode(client, code);
    if (!existing) {
      throw httpError(`Requisition not found: ${code}`, 404);
    }

    assertExistingRequisitionEditable(existing);

    if (existing.requestor_submitted_on) {
      throw httpError(
        `Requisition ${existing.requisition_code} has already been submitted.`,
        409
      );
    }

    // Optional final field flush before submit (same mapper as update).
    // Never creates a requisition — update path only.
    if (payload && Object.keys(payload).length > 0) {
      await updateRequisition(client, code, payload, req);
    }

    const requisition = await loadRequisitionByCode(client, code);
    assertRequestorSubmitReadiness(requisition);

    const workflowInstanceId = requisition.workflow_instance_id;
    if (!workflowInstanceId) {
      throw httpError(
        `Requisition ${requisition.requisition_code} has no workflow instance. Catalogue create must start workflow.`,
        400
      );
    }

    let workflow = await workflowService.getInstanceById(
      client,
      workflowInstanceId
    );

    const employeeCode = req.user?.employee_code
      ? String(req.user.employee_code).trim()
      : user.name;

    const approvalTasks =
      await workflowService.createApprovalRouteWorkflowTasks(
        client,
        workflowInstanceId,
        requisition.approval_route_id,
        {
          stageKey: workflow?.currentStageKey || "approval",
          assignedBy: employeeCode,
          requisitionCode: requisition.requisition_code
        }
      );

    const nextStatus =
      requisition.req_status === REQUISITION_STATUS.OPEN
        ? REQUISITION_STATUS.PENDING_LEVEL_1
        : requisition.req_status;

    const submitted = await client.query(
      `UPDATE rm_requisitions
       SET requestor_submitted_on = COALESCE(requestor_submitted_on, NOW()),
           req_status = $1,
           modified_by = $2,
           modified_on = NOW()
       WHERE requisition_code = $3
       RETURNING *`,
      [nextStatus, user.name, requisition.requisition_code]
    );

    await writeEnterpriseAudit(client, {
      eventType: "RequisitionSubmitted",
      module: "Recruitment Management",
      entity: "Requisition",
      entityId: requisition.requisition_code,
      action: `Requisition ${requisition.requisition_code} submitted for approval`,
      previousValue: existing.req_status,
      newValue: nextStatus,
      userName: user.name,
      userRole: user.role,
      metadata: {
        workflow_instance_id: workflowInstanceId,
        approval_route_id: requisition.approval_route_id,
        approval_task_count: approvalTasks.length
      }
    });

    await client.query("COMMIT");

    return {
      success: true,
      requisition: submitted.rows[0],
      workflow,
      approval_tasks: approvalTasks,
      requisition_code: requisition.requisition_code,
      workflow_instance_id: workflowInstanceId,
      toastMessage: `Requisition ${requisition.requisition_code} submitted for approval.`
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
  getDefaultSeedPayload,
  getRecruitmentBundle,
  getMyRecruiterDashboard,
  createFromApprovedPosition,
  approveRequisition,
  assignRecruiter,
  removeRecruiterAssignment,
  resolveRecruiterAssignmentTarget,
  mapCandidate,
  releaseCandidate,
  returnCandidateToTalentPool,
  updateCandidateStage,
  assertAuthorizedMappingAccess,
  getCandidateWorkspaceProfile,
  listCandidateEducation,
  listCandidateExperience,
  getCandidateOwnership,
  listTalentPoolCandidates,
  listMyPipelineCandidates,
  listPipelineHistoryForMapping,
  assertAuthorizedRelease,
  validateMasterDataReferences,
  validateMasterDataFields,
  RECRUITMENT_MASTER_DATA_CHECKS,
  evaluateRecruitmentRules,
  handleLegacyCreateRequisition,
  seedConfiguration,
  mapRequisitionForManagementUi,
  mapAssignmentForManagementUi,
  listRequisitionsForManagement,
  getRequisitionFulfillment,
  getAssignedRecruitersForRequisition,
  listFormRecruiters,
  listFormClients,
  listFormProjectsByClient,
  listFormHiringManagersByProject,
  listApprovedPositions,
  updateRequisition,
  submitRequisition,
  loadRequisitionByCode,
  getRequisitionForRequestor,
  mapRequisitionForCandidatePortal,
  listOpenRequisitionsForCandidatePortal,
  loadOpenRequisitionForCandidatePortal,
  publishRequisitionToCandidatePortal,
  unpublishRequisitionFromCandidatePortal,
  applyCandidateFromPortal,
  listPendingPortalApplications,
  claimPendingPortalApplication,
  CANDIDATE_PORTAL_APPLY_REMARKS,
  mapApplicationForCandidatePortal,
  listCandidatePortalApplications,
  buildCandidateFacingStageResolver,
  inferCatalogStageCodeFromOperationalStage,
  CANDIDATE_PORTAL_REQUISITION_INTERNAL_FIELDS,
  CANDIDATE_PORTAL_APPLICATION_ALLOWED_FIELDS,
  CANDIDATE_PORTAL_INTERVIEW_MICRO_STATE_PATTERN
};
