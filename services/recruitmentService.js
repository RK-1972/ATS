const businessRulesService = require("./businessRulesService");
const workflowService = require("./workflowService");
const masterDataService = require("./masterDataService");
const { writeEnterpriseAudit, userContext } = require("./enterpriseAuditService");
const { isLegacyDualWriteEnabled } = require("../config/operationalCutover");
const { REQUISITION_STATUS } = require("../constants/requisitionStatus");

const SEED_PATH = require("path").join(__dirname, "..", "seed", "recruitment.seed.json");

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

const ASSIGN_RECRUITER_ROLES = ["Admin", "TA Lead", "TA Leader"];
const REQUISITION_ASSIGNER_CODE = "REQUISITION_ASSIGNER";

/**
 * V1.0 assign gate: keep legacy Admin/TA Lead roles, and also allow
 * employees with an active REQUISITION_ASSIGNER work assignment.
 */
async function assertCanAssignRecruiter(pool, req) {
  const user = userContext(req);

  if (ASSIGN_RECRUITER_ROLES.includes(user.role)) {
    return;
  }

  const employeeCode = req.user?.employee_code
    ? String(req.user.employee_code).trim()
    : "";

  if (!employeeCode) {
    throw httpError(
      "Only Admin, TA Lead, or users with Requisition Assigner work assignment can assign recruiters.",
      403
    );
  }

  const workAssignmentService = require("./workAssignmentService");
  const assignments =
    await workAssignmentService.getEmployeeWorkAssignments(pool, employeeCode);

  const hasAssignerCapacity = (assignments || []).some((row) => {
    if (row.is_active !== true) {
      return false;
    }

    if (row.master_is_active === false) {
      return false;
    }

    return (
      String(row.assignment_code || "").trim().toUpperCase() ===
      REQUISITION_ASSIGNER_CODE
    );
  });

  if (!hasAssignerCapacity) {
    throw httpError(
      "Only Admin, TA Lead, or users with Requisition Assigner work assignment can assign recruiters.",
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

async function validateMasterDataReferences(pool, data) {
  const errors = [];
  const checks = [
    { field: "department", entityType: "departments" },
    { field: "grade", entityType: "grades" },
    // Geography masters use cities / work_locations — entity type "locations" does not exist.
    { field: "location", entityType: "cities", alternateEntityTypes: ["work_locations"] },
    { field: "primary_skill", entityType: "skills" },
    { field: "employment_type", entityType: "employment_types" },
    { field: "source_type", entityType: "candidate_sources" },
    { field: "business_unit", entityType: "business_units" }
  ];

  for (const check of checks) {
    const value = data[check.field];
    if (!value) {
      continue;
    }

    const entityTypes = [
      check.entityType,
      ...(check.alternateEntityTypes || [])
    ];
    const key = String(value).toLowerCase();
    let matched = false;

    for (const entityType of entityTypes) {
      const records = await masterDataService.listByEntityType(pool, entityType);
      const names = new Set(records.map((row) => row.name.toLowerCase()));
      const codes = new Set(records.map((row) => row.code.toLowerCase()));

      if (names.has(key) || codes.has(key)) {
        matched = true;
        break;
      }

      const partial = records.find((row) =>
        row.name.toLowerCase().includes(key) || row.code.toLowerCase().includes(key)
      );
      if (partial) {
        matched = true;
        break;
      }
    }

    if (!matched) {
      errors.push(
        `"${value}" not found in Master Data (${entityTypes.join(" / ")}).`
      );
    }
  }

  return { valid: errors.length === 0, errors };
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
    return value.toISOString().slice(0, 10);
  }
  return null;
}

function resolveDashboardDateRange(req) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const toDefault = today.toISOString().slice(0, 10);
  const fromDefaultDate = new Date(today);
  fromDefaultDate.setDate(fromDefaultDate.getDate() - 29);

  const fromDate = toDateOnly(req.query?.fromDate) || fromDefaultDate.toISOString().slice(0, 10);
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
      p.department AS approved_department
     FROM rm_requisitions r
     INNER JOIN rm_recruiter_assignments a
       ON a.requisition_code = r.requisition_code
     LEFT JOIN wp_approved_positions p ON r.approved_position_id = p.position_id
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

  const today = new Date().toISOString().slice(0, 10);
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
      options.employment_type || position.employment_type || null
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
      employment_type, headcount, primary_skill, req_status, workflow_instance_id,
      version, version_status, effective_from, created_by, modified_by,
      approval_route_id
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
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

  const ruleEval = await evaluateRecruitmentRules(pool, {
    department: requisition?.department,
    grade: requisition?.grade,
    recruiter_code: recruiterCode,
    action: "assign_recruiter"
  }, req);

  if (requisition?.workflow_instance_id) {
    await workflowService.advanceWorkflow(
      pool,
      requisition.workflow_instance_id,
      "approve",
      { stageKey: "recruiter_assigned", actor: user.name, comment: `Assigned ${recruiterCode}` },
      req
    );
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
          stageName,
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
        stageName,
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
            stageName,
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
        stageName,
        user.name,
        user.role,
        remarks,
        JSON.stringify({ sourceType, ruleEvaluation: ruleEval })
      ]
    );

    // Talent Pool unowned → acquire ownership on map (same transaction).
    // PIPELINE + owned by another recruiter: leave ownership unchanged (request workflow).
    if (shouldAcquireOwnership) {
      await client.query(
        `UPDATE cand_mstr
         SET candidate_container = 'PIPELINE',
             owner_employee_code = $1
         WHERE candidate_id = $2
           AND candidate_container = 'TALENT_POOL'
           AND owner_employee_code IS NULL`,
        [recruiterEmployeeCode(req), candidateId]
      );
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
    metadata: { requisitionCode: requisition.requisition_code, stageName, ruleEvaluation: ruleEval }
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

  let mapping = null;

  const enterpriseMap = await pool.query(
    "SELECT * FROM rm_candidate_mappings WHERE mapping_id = $1 OR map_id = $1",
    [mapId]
  );
  mapping = enterpriseMap.rows[0];

  let legacyRow = null;

  if (await tableExists(pool, "candidate_req_map")) {
    const legacy = await pool.query(
      "SELECT * FROM candidate_req_map WHERE map_id = $1",
      [mapId]
    );
    legacyRow = legacy.rows[0];

    if (!mapping && legacyRow) {
      const byLegacy = await pool.query(
        "SELECT * FROM rm_candidate_mappings WHERE map_id = $1",
        [mapId]
      );
      mapping = byLegacy.rows[0];
    }
  }

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

  const ruleEval = await evaluateRecruitmentRules(pool, {
    department: requisition?.department,
    grade: requisition?.grade,
    from_stage: previousStage,
    to_stage: stageName,
    action: /offer/i.test(stageName) ? "offer_routing" : "stage_change"
  }, req);

  if (mapping?.workflow_instance_id) {
    await workflowService.advanceWorkflow(
      pool,
      mapping.workflow_instance_id,
      /reject/i.test(stageName) ? "reject" : "approve",
      { stageKey: stageName.toLowerCase().replace(/\s+/g, "_"), actor: user.name, comment: remarks },
      req
    );
  }

  if (isLegacyDualWriteEnabled() && legacyRow && (await tableExists(pool, "candidate_req_map"))) {
    await pool.query(
      "UPDATE candidate_req_map SET stage_name = $1, remarks = $2 WHERE map_id = $3",
      [stageName, remarks, mapId]
    );

    await pool.query(
      "UPDATE cand_mstr SET candidate_status = $1 WHERE candidate_id = $2",
      [stageName, legacyRow.candidate_id]
    );
  } else if (mapping?.candidate_id) {
    await pool.query(
      "UPDATE cand_mstr SET candidate_status = $1 WHERE candidate_id = $2",
      [stageName, mapping.candidate_id]
    );
  }

  if (mapping) {
    await pool.query(
      `UPDATE rm_candidate_mappings
       SET stage_name = $1, remarks = $2, modified_on = NOW()
       WHERE mapping_id = $3`,
      [stageName, remarks, mapping.mapping_id]
    );
  }

  let eventType = "StageChanged";
  if (/reject/i.test(stageName)) {
    eventType = "CandidateRejected";
  } else if (/shortlist|cleared/i.test(stageName)) {
    eventType = "CandidateShortlisted";
  }

  await pool.query(
    `INSERT INTO rm_pipeline_history (
      requisition_code, mapping_id, candidate_id, event_type,
      from_stage, to_stage, actor, actor_role, comments, metadata
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      requisitionCode,
      mapping?.mapping_id || null,
      mapping?.candidate_id || legacyRow?.candidate_id,
      eventType,
      previousStage,
      stageName,
      user.name,
      user.role,
      remarks,
      JSON.stringify({ ruleEvaluation: ruleEval })
    ]
  );

  await writeEnterpriseAudit(pool, {
    eventType,
    module: "Recruitment Management",
    entity: "Candidate Pipeline",
    entityId: String(mapId),
    action: `Stage changed from ${previousStage} to ${stageName}`,
    previousValue: previousStage,
    newValue: stageName,
    userName: user.name,
    userRole: user.role,
    metadata: { remarks, ruleEvaluation: ruleEval }
  });

  return {
    mapping: mapping ? { ...mapping, stage_name: stageName } : legacyRow,
    eventType,
    toastMessage: "ATS stage updated successfully."
  };
}

/**
 * @param {object} queryable - pg Pool or Client (shared TX handle)
 */
async function handleLegacyCreateRequisition(queryable, body, req) {
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
    secondary_skill: null,
    experience_min: null,
    experience_max: null,
    openings_count: row.headcount,
    work_location: row.location,
    employment_type: row.employment_type,
    priority_level: "High",
    req_status: row.req_status,
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
     WHERE UPPER(COALESCE(req_status, '')) = 'APPROVED'
     ORDER BY COALESCE(req_id, 0) DESC, created_on DESC`
  );

  return result.rows.map(mapRequisitionForManagementUi);
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
       position_id,
       position_title,
       department,
       grade,
       headcount,
       status,
       remaining_budget,
       expiry_date
     FROM wp_approved_positions
     WHERE LOWER(COALESCE(status, 'active')) = 'active'
     ORDER BY position_title ASC, position_id ASC`
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

function blankToNull(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text === "" ? null : value;
}

function assertExistingRequisitionEditable(requisition) {
  const status = String(requisition.req_status || "").trim();
  if (
    status === REQUISITION_STATUS.APPROVED ||
    status === REQUISITION_STATUS.REJECTED
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
        ? blankToNull(payload.project_name)
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

  assertExistingRequisitionEditable(existing);

  const fields = buildRequisitionUpdateFields(payload || {});
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
  validateMasterDataReferences,
  evaluateRecruitmentRules,
  handleLegacyCreateRequisition,
  seedConfiguration,
  mapRequisitionForManagementUi,
  mapAssignmentForManagementUi,
  listRequisitionsForManagement,
  getAssignedRecruitersForRequisition,
  listFormRecruiters,
  listFormClients,
  listFormProjectsByClient,
  listFormHiringManagersByProject,
  listApprovedPositions,
  updateRequisition,
  submitRequisition,
  loadRequisitionByCode
};
