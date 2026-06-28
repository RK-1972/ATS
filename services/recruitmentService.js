const businessRulesService = require("./businessRulesService");
const workflowService = require("./workflowService");
const masterDataService = require("./masterDataService");
const { writeEnterpriseAudit, userContext } = require("./enterpriseAuditService");
const { isLegacyDualWriteEnabled } = require("../config/operationalCutover");

const SEED_PATH = require("path").join(__dirname, "..", "seed", "recruitment.seed.json");

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
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
    { field: "location", entityType: "locations" },
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

    const records = await masterDataService.listByEntityType(pool, check.entityType);
    const names = new Set(records.map((row) => row.name.toLowerCase()));
    const codes = new Set(records.map((row) => row.code.toLowerCase()));
    const key = String(value).toLowerCase();

    if (!names.has(key) && !codes.has(key)) {
      const partial = records.find((row) =>
        row.name.toLowerCase().includes(key) || row.code.toLowerCase().includes(key)
      );
      if (!partial) {
        errors.push(`"${value}" not found in Master Data (${check.entityType}).`);
      }
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

async function insertLegacyRequisition(pool, position, requisitionCode, user) {
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
      req_status, recruiter_id, hiring_manager, target_date, created_by
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
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
      position.location || "Bangalore",
      position.employment_type || "Full-time",
      "High",
      "Open",
      null,
      position.hiring_manager || "Hiring Manager",
      position.expiry_date || null,
      user.name
    ]
  );

  return result.rows[0];
}

async function getRecruitmentBundle(pool) {
  const requisitions = await pool.query(
    `SELECT r.*,
      p.position_title AS approved_position_title,
      p.department AS approved_department
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

async function getMyRecruiterDashboard(pool, req) {
  const employeeCode = recruiterEmployeeCode(req);

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

  const pipeline = await pool.query(
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
     ORDER BY m.applied_on DESC`,
    [employeeCode]
  );

  const interviews = await pool.query(
    `SELECT i.*,
      c.candidate_code,
      CONCAT(c.first_name, ' ', c.last_name) AS candidate_name
     FROM im_interviews i
     INNER JOIN rm_recruiter_assignments a
       ON a.requisition_code = i.requisition_code
     LEFT JOIN cand_mstr c ON c.candidate_id = i.candidate_id
     WHERE a.recruiter_code = $1 AND a.is_active = true
     ORDER BY i.interview_date DESC NULLS LAST, i.interview_time DESC NULLS LAST`,
    [employeeCode]
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
     ORDER BY t.due_at ASC NULLS LAST, t.created_on DESC`,
    [employeeCode]
  );

  const taskRows = tasks.rows.map(mapDashboardTaskRow);
  const interviewRows = interviews.rows.map(mapDashboardInterviewRow);
  const requisitionRows = requisitions.rows;
  const pipelineRows = pipeline.rows;
  const assignmentRows = assignments.rows;

  const today = new Date().toISOString().slice(0, 10);

  return {
    employee_code: employeeCode,
    requisitions: requisitionRows,
    recruiterAssignments: assignmentRows,
    pipeline: pipelineRows,
    interviews: interviewRows,
    tasks: taskRows,
    summary: {
      openRequisitions: requisitionRows.filter((row) =>
        /open|pending|approved/i.test(row.req_status)
      ).length,
      activeCandidates: pipelineRows.length,
      pendingTasks: taskRows.length,
      interviewsToday: interviewRows.filter((row) => row.interview_date === today).length
    },
    taskSummary: {
      pending: taskRows.length,
      escalated: taskRows.filter((row) => row.escalated).length,
      overdue: taskRows.filter((row) => row.due_at && new Date(row.due_at) < new Date()).length
    },
    interviewSummary: {
      scheduled: interviewRows.filter((row) => row.interviewStatus === "Scheduled").length,
      completed: interviewRows.filter((row) => row.interviewStatus === "Completed").length,
      pendingFeedback: interviewRows.filter((row) => !row.feedbackSubmitted).length
    }
  };
}

async function createFromApprovedPosition(pool, positionId, options = {}, req) {
  const user = userContext(req);
  const platformConfig = await loadPlatformConfig(pool);
  await assertRecruitmentModuleEnabled(platformConfig);

  const position = await loadApprovedPosition(pool, positionId);
  if (!position) {
    throw httpError(`Approved position not found: ${positionId}`, 404);
  }

  if (position.status === "Fully Utilized") {
    throw httpError("Approved position budget is fully utilized.", 400);
  }

  const mdValidation = await validateMasterDataReferences(pool, {
    department: position.department,
    grade: position.grade,
    location: position.location || options.location,
    employment_type: position.employment_type || "Full-time"
  });

  if (!mdValidation.valid) {
    throw httpError(mdValidation.errors.join(" "), 400);
  }

  const budgetLpa = Number(position.budget_approved || 0) / 100000;
  const ruleEval = await evaluateRecruitmentRules(pool, {
    department: position.department,
    grade: position.grade,
    approved_budget_lpa: budgetLpa,
    offered_salary_lpa: budgetLpa,
    headcount: position.headcount,
    employment_type: position.employment_type || "Full-time",
    action: "create_requisition"
  }, req);

  const requisitionCode = options.requisitionId || await generateRequisitionCode(pool);

  const existing = await pool.query(
    "SELECT requisition_code FROM rm_requisitions WHERE requisition_code = $1",
    [requisitionCode]
  );

  if (existing.rows.length > 0) {
    throw httpError(`Requisition already exists: ${requisitionCode}`, 409);
  }

  const legacyRow = await insertLegacyRequisition(pool, position, requisitionCode, user);
  const reqId = legacyRow?.req_id || await allocateReqId(pool);

  const instance = await workflowService.startWorkflow(
    pool,
    "REQUISITION",
    {
      instance_id: `WF-RM-${requisitionCode}`,
      meta: {
        process_id: `WF-RM-${requisitionCode}`,
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
    ? "Pending TA Lead"
    : "Open";

  await pool.query(
    `INSERT INTO rm_requisitions (
      requisition_code, approved_position_id, req_id, position_title, grade,
      department, business_unit, location, budget_approved, hiring_manager,
      employment_type, headcount, primary_skill, req_status, workflow_instance_id,
      version, version_status, effective_from, created_by, modified_by
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
    [
      requisitionCode,
      positionId,
      reqId,
      position.position_title,
      position.grade,
      position.department,
      options.business_unit || position.business_unit || position.department,
      options.location || position.location || "Bangalore",
      position.budget_approved,
      options.hiring_manager || position.hiring_manager || "Hiring Manager",
      position.employment_type || "Full-time",
      position.headcount || 1,
      options.primary_skill || null,
      initialStatus,
      instance.instanceId,
      1.0,
      "Published",
      new Date(),
      user.name,
      user.name
    ]
  );

  await writeEnterpriseAudit(pool, {
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
      workflow_instance_id: instance.instanceId
    },
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

  const nextStatus = requisition.req_status === "Pending TA Lead" ? "Approved" : "Open";

  await pool.query(
    `UPDATE rm_requisitions
     SET req_status = $1, modified_by = $2, modified_on = NOW()
     WHERE requisition_code = $3`,
    [nextStatus, user.name, requisitionCode]
  );

  if (isLegacyDualWriteEnabled() && requisition.req_id && (await tableExists(pool, "req_mstr"))) {
    await pool.query(
      "UPDATE req_mstr SET req_status = $1, updated_on = CURRENT_TIMESTAMP WHERE req_id = $2",
      ["Open", requisition.req_id]
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

  if (!["Admin", "TA Lead", "TA Leader"].includes(user.role)) {
    throw httpError("Only Admin or TA Lead can assign recruiters.", 403);
  }

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

  let legacyMap = null;
  let allocatedMapId = null;

  if (isLegacyDualWriteEnabled() && (await tableExists(pool, "candidate_req_map"))) {
    const existing = await pool.query(
      `SELECT * FROM candidate_req_map
       WHERE candidate_id = $1 AND req_id = $2 AND is_active = true`,
      [candidateId, requisition.req_id || reqId]
    );

    if (existing.rows.length > 0) {
      throw httpError("Candidate already mapped to requisition.", 400);
    }

    const insert = await pool.query(
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
  } else {
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

  const mapping = await pool.query(
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

  await pool.query(
    `INSERT INTO rm_pipeline_history (
      requisition_code, mapping_id, candidate_id, event_type, to_stage, actor, actor_role, comments, metadata
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      requisition.requisition_code,
      mapping.rows[0].mapping_id,
      candidateId,
      "CandidateMapped",
      stageName,
      user.name,
      user.role,
      remarks,
      JSON.stringify({ sourceType, ruleEvaluation: ruleEval })
    ]
  );

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
    mapping: mapping.rows[0],
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

async function handleLegacyCreateRequisition(pool, body, req) {
  const approvedPositionId = body.approved_position_id;

  if (!approvedPositionId) {
    throw httpError(
      "Requisitions must be created from an Approved Position in Workforce Planning. Provide approved_position_id.",
      400
    );
  }

  return createFromApprovedPosition(pool, approvedPositionId, {
    business_unit: body.client_name,
    location: body.work_location,
    hiring_manager: body.hiring_manager,
    primary_skill: body.primary_skill
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
        requisition.req_status || "Open",
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

  if (!["Admin", "TA Lead", "TA Leader"].includes(user.role)) {
    throw httpError("Only Admin or TA Lead can remove recruiter assignments.", 403);
  }

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
  listFormHiringManagersByProject
};
