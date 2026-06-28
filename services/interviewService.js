const businessRulesService = require("./businessRulesService");
const workflowService = require("./workflowService");
const masterDataService = require("./masterDataService");
const taskService = require("./taskService");
const { writeEnterpriseAudit, userContext } = require("./enterpriseAuditService");
const { isLegacyDualWriteEnabled, isEnterpriseOperationalSor } = require("../config/operationalCutover");

const SEED_PATH = require("path").join(__dirname, "..", "seed", "interviews.seed.json");

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

async function assertInterviewModuleEnabled(platformConfig) {
  const interviewModule = platformConfig?.modules?.find(
    (item) => item.key === "interview_management"
  );
  if (platformConfig && interviewModule && !interviewModule.enabled) {
    throw httpError("Interview Management module is disabled in Platform Configuration.", 400);
  }
}

async function validateMasterDataReferences(pool, data) {
  const errors = [];
  const checks = [
    { field: "round_type", entityType: "interview_types" },
    { field: "interview_mode", entityType: "interview_modes" },
    { field: "primary_skill", entityType: "skills" }
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

async function evaluateInterviewRules(pool, context, req) {
  return businessRulesService.simulateRules(pool, context, req);
}

function generateInterviewId() {
  return `INT-${Date.now()}`;
}

function stageNameForRound(roundType) {
  switch (roundType) {
    case "L1 Technical":
    case "L1 Non Technical":
      return "L1 Interview Scheduled";
    case "L2 Managerial":
      return "L2 Interview Scheduled";
    case "HR Round":
      return "HR Interview Scheduled";
    case "Client Round":
      return "Client Interview Scheduled";
    default:
      return "Interview Scheduled";
  }
}

async function recordInterviewHistory(pool, interviewId, eventType, actor, fromStatus, toStatus, comments, metadata) {
  await pool.query(
    `INSERT INTO im_interview_history (
      interview_id, event_type, from_status, to_status, actor, comments, metadata
    ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      interviewId,
      eventType,
      fromStatus || null,
      toStatus || null,
      actor,
      comments || null,
      metadata ? JSON.stringify(metadata) : null
    ]
  );
}

function mapInterviewRow(row) {
  return {
    interviewId: row.interview_id,
    scheduleId: row.schedule_id,
    mapId: row.map_id,
    reqId: row.req_id,
    requisitionCode: row.requisition_code,
    candidateId: row.candidate_id,
    roundNo: row.round_no,
    roundType: row.round_type,
    interviewDate: row.interview_date,
    interviewTime: row.interview_time,
    interviewStatus: row.interview_status,
    workflowInstanceId: row.workflow_instance_id,
    meetingLink: row.meeting_link,
    feedbackSubmitted: row.feedback_submitted,
    finalOutcome: row.final_outcome,
    remarks: row.remarks
  };
}

async function getInterviewBundle(pool) {
  const interviews = await pool.query(
    "SELECT * FROM im_interviews ORDER BY created_on DESC"
  );
  const panel = await pool.query(
    "SELECT * FROM im_panel_assignments ORDER BY assigned_on DESC"
  );

  return {
    interviews: interviews.rows.map(mapInterviewRow),
    panelAssignments: panel.rows,
    summary: {
      scheduled: interviews.rows.filter((row) => row.interview_status === "Scheduled").length,
      completed: interviews.rows.filter((row) => row.interview_status === "Completed").length,
      pendingFeedback: interviews.rows.filter((row) => !row.feedback_submitted).length
    }
  };
}

async function scheduleInterview(pool, payload, req) {
  const user = userContext(req);
  const platformConfig = await loadPlatformConfig(pool);
  await assertInterviewModuleEnabled(platformConfig);

  const {
    req_id: reqId,
    map_id: mapId,
    interviewer_id: interviewerId,
    round_no: roundNo = 1,
    round_type: roundType,
    interview_date: interviewDate,
    interview_time: interviewTime,
    remarks,
    interviewer_name: interviewerName,
    interviewer_email: interviewerEmail,
    interviewer_type: interviewerType
  } = payload;

  if (!mapId || !interviewerId || !roundType || !interviewDate || !interviewTime) {
    throw httpError("Required fields are missing.", 400);
  }

  const selectedDate = new Date(interviewDate);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (selectedDate < today) {
    throw httpError("Interview date cannot be in the past.", 400);
  }

  const mdValidation = await validateMasterDataReferences(pool, { round_type: roundType });
  if (!mdValidation.valid) {
    throw httpError(mdValidation.errors.join(" "), 400);
  }

  let candidateId = null;
  let requisitionCode = null;

  const enterpriseMap = await pool.query(
    `SELECT candidate_id, req_id, requisition_code
     FROM rm_candidate_mappings
     WHERE map_id = $1 AND is_active = true`,
    [mapId]
  );

  if (enterpriseMap.rows.length) {
    candidateId = enterpriseMap.rows[0].candidate_id;
    reqId ||= enterpriseMap.rows[0].req_id;
    requisitionCode = enterpriseMap.rows[0].requisition_code;
  } else if (isLegacyDualWriteEnabled() && (await tableExists(pool, "candidate_req_map"))) {
    const mapResult = await pool.query(
      "SELECT candidate_id, req_id FROM candidate_req_map WHERE map_id = $1 AND is_active = true",
      [mapId]
    );
    if (!mapResult.rows.length) {
      throw httpError("Candidate mapping not found.", 404);
    }
    candidateId = mapResult.rows[0].candidate_id;
    reqId ||= mapResult.rows[0].req_id;
  } else {
    throw httpError("Candidate mapping not found.", 404);
  }

  if (!requisitionCode) {
    const rmResult = await pool.query(
      "SELECT requisition_code FROM rm_requisitions WHERE req_id = $1 LIMIT 1",
      [reqId]
    );
    requisitionCode = rmResult.rows[0]?.requisition_code || null;
  }

  const ruleEval = await evaluateInterviewRules(pool, {
    round_type: roundType,
    department: payload.department,
    grade: payload.grade,
    primary_skill: payload.primary_skill,
    action: "schedule_interview"
  }, req);

  const interviewId = generateInterviewId();
  const instance = await workflowService.startWorkflow(
    pool,
    "INTERVIEW",
    {
      instance_id: `WF-INT-${interviewId}`,
      meta: {
        interview_id: interviewId,
        map_id: mapId,
        req_id: reqId,
        round_type: roundType
      }
    },
    req
  );

  await workflowService.advanceWorkflow(
    pool,
    instance.instanceId,
    "advance",
    { stageKey: "requested", actor: user.name, comment: "Interview scheduled" },
    req
  );

  await workflowService.advanceWorkflow(
    pool,
    instance.instanceId,
    "advance",
    { stageKey: "scheduled", actor: user.name, comment: remarks || "" },
    req
  );

  const feedbackReminderHours = platformConfig?.modules?.find(
    (item) => item.key === "interview_management"
  )?.settings?.feedback_reminder_hours || 24;

  await pool.query(
    `INSERT INTO im_interviews (
      interview_id, map_id, req_id, requisition_code, candidate_id, round_no, round_type,
      interview_date, interview_time, interview_status, workflow_instance_id, remarks,
      created_by, modified_by, effective_from
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [
      interviewId,
      mapId,
      reqId,
      requisitionCode,
      candidateId,
      roundNo,
      roundType,
      interviewDate,
      interviewTime,
      "Scheduled",
      instance.instanceId,
      remarks || null,
      user.name,
      user.name,
      new Date()
    ]
  );

  await pool.query(
    `INSERT INTO im_panel_assignments (
      interview_id, panel_id, interviewer_name, interviewer_email, interviewer_type,
      assignment_status, assigned_by, effective_from
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      interviewId,
      interviewerId,
      interviewerName || null,
      interviewerEmail || null,
      interviewerType || "Interviewer",
      "Pending",
      user.name,
      new Date()
    ]
  );

  await taskService.createTask(pool, {
    module: "Interview Management",
    taskType: "Accept Interview Assignment",
    title: `Accept ${roundType} interview assignment`,
    assignee: interviewerName || null,
    assigneeRole: "Interviewer",
    priority: "High",
    slaHours: 8,
    workflowInstanceId: instance.instanceId,
    stageKey: "scheduled",
    businessObjectType: "Interview",
    businessObjectId: interviewId,
    metadata: { roundType, interviewDate, interviewTime }
  }, req);

  await taskService.createTask(pool, {
    module: "Interview Management",
    taskType: "Conduct Interview",
    title: `Conduct ${roundType} interview`,
    assignee: interviewerName || null,
    assigneeRole: "Interviewer",
    slaHours: 72,
    workflowInstanceId: instance.instanceId,
    stageKey: "scheduled",
    businessObjectType: "Interview",
    businessObjectId: interviewId,
    metadata: { interviewDate, interviewTime }
  }, req);

  await recordInterviewHistory(
    pool,
    interviewId,
    "InterviewScheduled",
    user.name,
    null,
    "Scheduled",
    remarks
  );

  await writeEnterpriseAudit(pool, {
    eventType: "InterviewScheduled",
    module: "Interview Management",
    entity: "Interview",
    entityId: interviewId,
    action: `${roundType} interview scheduled`,
    userName: user.name,
    userRole: user.role,
    metadata: { mapId, reqId, ruleEvaluation: ruleEval, feedbackReminderHours }
  });

  const stageName = stageNameForRound(roundType);
  if (isLegacyDualWriteEnabled() && (await tableExists(pool, "candidate_req_map"))) {
    await pool.query(
      "UPDATE candidate_req_map SET stage_name = $1 WHERE map_id = $2",
      [stageName, mapId]
    );
  }

  if (isEnterpriseOperationalSor() && enterpriseMap.rows.length) {
    await pool.query(
      "UPDATE rm_candidate_mappings SET stage_name = $1, modified_on = NOW() WHERE map_id = $2",
      [stageName, mapId]
    );
  }

  return {
    interviewId,
    interview: mapInterviewRow({
      interview_id: interviewId,
      schedule_id: null,
      map_id: mapId,
      req_id: reqId,
      requisition_code: requisitionCode,
      candidate_id: candidateId,
      round_no: roundNo,
      round_type: roundType,
      interview_date: interviewDate,
      interview_time: interviewTime,
      interview_status: "Scheduled",
      workflow_instance_id: instance.instanceId,
      meeting_link: null,
      feedback_submitted: false,
      final_outcome: null,
      remarks
    }),
    workflowInstanceId: instance.instanceId,
    stageName,
    ruleEvaluation: ruleEval,
    toastMessage: "Interview scheduled successfully."
  };
}

async function linkLegacySchedule(pool, interviewId, scheduleId, meetingLink, teamsEventId, req) {
  await pool.query(
    `UPDATE im_interviews
     SET schedule_id = $1, meeting_link = $2, teams_event_id = $3, modified_on = NOW()
     WHERE interview_id = $4`,
    [scheduleId, meetingLink || null, teamsEventId || null, interviewId]
  );

  return getInterview(pool, interviewId);
}

async function getInterview(pool, interviewId) {
  const result = await pool.query(
    "SELECT * FROM im_interviews WHERE interview_id = $1 OR schedule_id = $1",
    [interviewId]
  );

  if (!result.rows.length) {
    throw httpError(`Interview not found: ${interviewId}`, 404);
  }

  return mapInterviewRow(result.rows[0]);
}

async function acceptAssignment(pool, interviewId, req) {
  const user = userContext(req);
  const interview = await getInterview(pool, interviewId);

  await pool.query(
    `UPDATE im_panel_assignments
     SET assignment_status = 'Accepted', accepted_on = NOW(), modified_on = NOW()
     WHERE interview_id = $1 AND assignment_status = 'Pending'`,
    [interview.interviewId]
  );

  const tasks = await taskService.listInbox(pool, { module: "Interview Management" });
  const acceptTask = tasks.find(
    (item) =>
      item.businessObjectId === interview.interviewId
      && item.taskType === "Accept Interview Assignment"
      && item.status !== "Completed"
  );

  if (acceptTask) {
    await taskService.completeTask(pool, acceptTask.taskId, req, "Assignment accepted");
  }

  await recordInterviewHistory(
    pool,
    interview.interviewId,
    "InterviewAccepted",
    user.name,
    interview.interviewStatus,
    interview.interviewStatus
  );

  await writeEnterpriseAudit(pool, {
    eventType: "InterviewAccepted",
    module: "Interview Management",
    entity: "Interview",
    entityId: interview.interviewId,
    action: "Panel member accepted interview assignment",
    userName: user.name,
    userRole: user.role
  });

  return {
    interview,
    toastMessage: "Interview assignment accepted."
  };
}

async function rescheduleInterview(pool, interviewId, payload, req) {
  const user = userContext(req);
  const interview = await getInterview(pool, interviewId);
  const platformConfig = await loadPlatformConfig(pool);
  await assertInterviewModuleEnabled(platformConfig);

  const { interview_date: interviewDate, interview_time: interviewTime, remarks } = payload;

  if (!interviewDate || !interviewTime) {
    throw httpError("Interview date and time are required.", 400);
  }

  await pool.query(
    `UPDATE im_interviews
     SET interview_date = $1, interview_time = $2, remarks = COALESCE($3, remarks),
         modified_by = $4, modified_on = NOW()
     WHERE interview_id = $5`,
    [interviewDate, interviewTime, remarks, user.name, interview.interviewId]
  );

  if (isLegacyDualWriteEnabled() && interview.scheduleId && (await tableExists(pool, "interview_schedule_trn"))) {
    await pool.query(
      `UPDATE interview_schedule_trn
       SET interview_date = $1, interview_time = $2
       WHERE schedule_id = $3`,
      [interviewDate, interviewTime, interview.scheduleId]
    );
  }

  await taskService.createTask(pool, {
    module: "Interview Management",
    taskType: "Conduct Interview",
    title: `Rescheduled: ${interview.roundType} interview`,
    assigneeRole: "Interviewer",
    slaHours: 72,
    workflowInstanceId: interview.workflowInstanceId,
    stageKey: "scheduled",
    businessObjectType: "Interview",
    businessObjectId: interview.interviewId,
    metadata: { interviewDate, interviewTime, rescheduled: true }
  }, req);

  await recordInterviewHistory(
    pool,
    interview.interviewId,
    "InterviewRescheduled",
    user.name,
    interview.interviewStatus,
    "Scheduled",
    remarks,
    { interviewDate, interviewTime }
  );

  await writeEnterpriseAudit(pool, {
    eventType: "InterviewRescheduled",
    module: "Interview Management",
    entity: "Interview",
    entityId: interview.interviewId,
    action: "Interview rescheduled",
    userName: user.name,
    userRole: user.role,
    metadata: { interviewDate, interviewTime }
  });

  return {
    interview: await getInterview(pool, interview.interviewId),
    toastMessage: "Interview rescheduled successfully."
  };
}

async function completeInterview(pool, interviewId, req, comments = "") {
  const user = userContext(req);
  const interview = await getInterview(pool, interviewId);

  if (interview.workflowInstanceId) {
    await workflowService.advanceWorkflow(
      pool,
      interview.workflowInstanceId,
      "advance",
      { stageKey: "completed", actor: user.name, comment: comments },
      req
    );
  }

  await pool.query(
    `UPDATE im_interviews
     SET interview_status = 'Completed', modified_by = $1, modified_on = NOW()
     WHERE interview_id = $2`,
    [user.name, interview.interviewId]
  );

  if (isLegacyDualWriteEnabled() && interview.scheduleId && (await tableExists(pool, "interview_schedule_trn"))) {
    await pool.query(
      "UPDATE interview_schedule_trn SET interview_status = 'Completed' WHERE schedule_id = $1",
      [interview.scheduleId]
    );
  }

  const conductTasks = (await taskService.listInbox(pool, { module: "Interview Management" }))
    .filter(
      (item) =>
        item.businessObjectId === interview.interviewId
        && item.taskType === "Conduct Interview"
        && item.status !== "Completed"
    );

  for (const task of conductTasks) {
    await taskService.completeTask(pool, task.taskId, req, "Interview completed");
  }

  await taskService.createTask(pool, {
    module: "Interview Management",
    taskType: "Submit Interview Feedback",
    title: `Submit feedback for ${interview.roundType}`,
    assigneeRole: "Interviewer",
    slaHours: 24,
    workflowInstanceId: interview.workflowInstanceId,
    stageKey: "feedback",
    businessObjectType: "Interview",
    businessObjectId: interview.interviewId
  }, req);

  await recordInterviewHistory(
    pool,
    interview.interviewId,
    "InterviewCompleted",
    user.name,
    interview.interviewStatus,
    "Completed",
    comments
  );

  await writeEnterpriseAudit(pool, {
    eventType: "InterviewCompleted",
    module: "Interview Management",
    entity: "Interview",
    entityId: interview.interviewId,
    action: "Interview marked completed",
    userName: user.name,
    userRole: user.role
  });

  return {
    interview: await getInterview(pool, interview.interviewId),
    toastMessage: "Interview completed."
  };
}

async function submitFeedback(pool, payload, req) {
  const user = userContext(req);
  const platformConfig = await loadPlatformConfig(pool);
  await assertInterviewModuleEnabled(platformConfig);

  const {
    schedule_id: scheduleId,
    interview_id: interviewIdParam,
    interview_level: interviewLevel,
    area_of_interview: areaOfInterview,
    overall_rating: overallRating,
    strengths,
    improvement_areas: improvementAreas,
    overall_comments: overallComments,
    final_outcome: finalOutcome,
    skills = []
  } = payload;

  let interview = null;

  if (interviewIdParam) {
    interview = await getInterview(pool, interviewIdParam);
  } else if (scheduleId) {
    interview = await getInterview(pool, scheduleId);
  } else {
    throw httpError("schedule_id or interview_id is required.", 400);
  }

  if (interview.feedbackSubmitted) {
    throw httpError("Feedback already submitted for this interview.", 400);
  }

  const ruleEval = await evaluateInterviewRules(pool, {
    round_type: interview.roundType,
    final_outcome: finalOutcome,
    action: "submit_feedback"
  }, req);

  await pool.query(
    `INSERT INTO im_feedback (
      interview_id, schedule_id, interview_level, area_of_interview, overall_rating,
      strengths, improvement_areas, overall_comments, final_outcome, skills,
      submitted_by, effective_from
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      interview.interviewId,
      interview.scheduleId || scheduleId,
      interviewLevel,
      areaOfInterview,
      overallRating,
      strengths,
      improvementAreas,
      overallComments,
      finalOutcome,
      JSON.stringify(skills),
      user.name,
      new Date()
    ]
  );

  if (interview.workflowInstanceId) {
    await workflowService.advanceWorkflow(
      pool,
      interview.workflowInstanceId,
      "advance",
      { stageKey: "feedback", actor: user.name, comment: overallComments || "" },
      req
    );
  }

  await pool.query(
    `UPDATE im_interviews
     SET feedback_submitted = TRUE, final_outcome = $1, interview_status = 'Completed',
         modified_by = $2, modified_on = NOW()
     WHERE interview_id = $3`,
    [finalOutcome, user.name, interview.interviewId]
  );

  const feedbackTasks = (await taskService.listInbox(pool, { module: "Interview Management" }))
    .filter(
      (item) =>
        item.businessObjectId === interview.interviewId
        && item.taskType === "Submit Interview Feedback"
        && item.status !== "Completed"
    );

  for (const task of feedbackTasks) {
    await taskService.completeTask(pool, task.taskId, req, "Feedback submitted");
  }

  await recordInterviewHistory(
    pool,
    interview.interviewId,
    "FeedbackSubmitted",
    user.name,
    "Completed",
    "Feedback Submitted",
    overallComments,
    { finalOutcome, ruleEvaluation: ruleEval }
  );

  await writeEnterpriseAudit(pool, {
    eventType: "FeedbackSubmitted",
    module: "Interview Management",
    entity: "Interview",
    entityId: interview.interviewId,
    action: "Interview feedback submitted",
    userName: user.name,
    userRole: user.role,
    metadata: { finalOutcome, ruleEvaluation: ruleEval }
  });

  await syncLegacyFeedback(pool, interview, payload, user);

  return {
    interview: await getInterview(pool, interview.interviewId),
    toastMessage: "Feedback submitted successfully."
  };
}

function resolveStageFromOutcome(interviewLevel, finalOutcome) {
  if (finalOutcome === "Selected") {
    const map = {
      "L1 Technical": "L1 Technical Cleared",
      "L1 Non-Technical": "L1 Non-Technical Cleared",
      "L2 Technical": "L2 Technical Cleared",
      "L2 Non-Technical": "L2 Non-Technical Cleared",
      "L2 Managerial": "L2 Technical Cleared",
      "HR Round": "HR Cleared",
      "Client Round": "Client Cleared"
    };
    return map[interviewLevel] || "Screening";
  }

  if (finalOutcome === "Rejected") {
    const map = {
      "L1 Technical": "L1 Technical Rejected",
      "L1 Non-Technical": "L1 Non-Technical Rejected",
      "L2 Technical": "L2 Technical Rejected",
      "L2 Non-Technical": "L2 Non-Technical Rejected",
      "HR Round": "HR Rejected",
      "Client Round": "Client Rejected"
    };
    return map[interviewLevel] || "Screening";
  }

  if (finalOutcome === "Hold") {
    const map = {
      "L1 Technical": "L1 Technical On Hold",
      "L1 Non-Technical": "L1 Non-Technical On Hold",
      "L2 Technical": "L2 Technical On Hold",
      "HR Round": "HR On Hold",
      "Client Round": "Client On Hold"
    };
    return map[interviewLevel] || "Screening";
  }

  return null;
}

async function syncLegacyFeedback(pool, interview, payload, user) {
  if (!isLegacyDualWriteEnabled()) {
    return;
  }

  const scheduleId = interview.scheduleId || payload.schedule_id;
  if (!scheduleId || !(await tableExists(pool, "interview_feedback_hdr"))) {
    return;
  }

  const existing = await pool.query(
    "SELECT 1 FROM interview_feedback_hdr WHERE schedule_id = $1",
    [scheduleId]
  );

  if (!existing.rows.length) {
    const header = await pool.query(
      `INSERT INTO interview_feedback_hdr (
        schedule_id, interview_level, area_of_interview, overall_rating,
        strengths, improvement_areas, overall_comments, final_outcome,
        submitted_by, submitted_on, feedback_status
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),'Submitted') RETURNING feedback_id`,
      [
        scheduleId,
        payload.interview_level,
        payload.area_of_interview,
        payload.overall_rating,
        payload.strengths,
        payload.improvement_areas,
        payload.overall_comments,
        payload.final_outcome,
        user.id || user.name
      ]
    );

    for (const skill of payload.skills || []) {
      await pool.query(
        `INSERT INTO interview_feedback_dtl (feedback_id, skill_name, rating, comments)
         VALUES ($1,$2,$3,$4)`,
        [header.rows[0].feedback_id, skill.skill_name, skill.rating, skill.comments]
      );
    }
  }

  if (isLegacyDualWriteEnabled() && (await tableExists(pool, "interview_schedule_trn"))) {
    await pool.query(
      `UPDATE interview_schedule_trn
       SET feedback_submitted = true, interview_status = 'Completed', updated_on = NOW()
       WHERE schedule_id = $1`,
      [scheduleId]
    );
  }

  const newStage = resolveStageFromOutcome(payload.interview_level, payload.final_outcome);
  if (isLegacyDualWriteEnabled() && newStage && interview.mapId && (await tableExists(pool, "candidate_req_map"))) {
    await pool.query(
      "UPDATE candidate_req_map SET stage_name = $1 WHERE map_id = $2",
      [newStage, interview.mapId]
    );
  } else if (newStage && interview.mapId && isEnterpriseOperationalSor()) {
    await pool.query(
      "UPDATE rm_candidate_mappings SET stage_name = $1, modified_on = NOW() WHERE map_id = $2",
      [newStage, interview.mapId]
    );
  }
}

async function reassignPanel(pool, interviewId, payload, req) {
  const user = userContext(req);
  const interview = await getInterview(pool, interviewId);
  const { panel_id: panelId, interviewer_name: interviewerName, interviewer_email: interviewerEmail } = payload;

  const ruleEval = await evaluateInterviewRules(pool, {
    round_type: interview.roundType,
    action: "panel_reassignment"
  }, req);

  await pool.query(
    `UPDATE im_panel_assignments SET assignment_status = 'Reassigned', modified_on = NOW()
     WHERE interview_id = $1 AND assignment_status IN ('Pending', 'Accepted')`,
    [interview.interviewId]
  );

  await pool.query(
    `INSERT INTO im_panel_assignments (
      interview_id, panel_id, interviewer_name, interviewer_email,
      assignment_status, assigned_by, effective_from
    ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      interview.interviewId,
      panelId,
      interviewerName,
      interviewerEmail,
      "Pending",
      user.name,
      new Date()
    ]
  );

  await taskService.createTask(pool, {
    module: "Interview Management",
    taskType: "Accept Interview Assignment",
    title: `Reassigned: accept ${interview.roundType} interview`,
    assignee: interviewerName || null,
    assigneeRole: "Interviewer",
    priority: "High",
    slaHours: 8,
    workflowInstanceId: interview.workflowInstanceId,
    stageKey: "scheduled",
    businessObjectType: "Interview",
    businessObjectId: interview.interviewId,
    metadata: { reassigned: true, ruleEvaluation: ruleEval }
  }, req);

  await writeEnterpriseAudit(pool, {
    eventType: "TaskReassigned",
    module: "Interview Management",
    entity: "Interview Panel",
    entityId: interview.interviewId,
    action: `Panel reassigned to ${interviewerName || panelId}`,
    userName: user.name,
    userRole: user.role,
    metadata: { ruleEvaluation: ruleEval }
  });

  return {
    interview,
    toastMessage: "Panel member reassigned."
  };
}

async function assignPanel(pool, interviewId, panelMembers, req) {
  const user = userContext(req);
  const interview = await getInterview(pool, interviewId);

  const ruleEval = await evaluateInterviewRules(pool, {
    round_type: interview.roundType,
    panel_size: panelMembers.length,
    action: "assign_panel"
  }, req);

  for (const member of panelMembers) {
    await pool.query(
      `INSERT INTO im_panel_assignments (
        interview_id, panel_id, interviewer_name, interviewer_email, interviewer_type,
        assignment_status, assigned_by, effective_from
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        interview.interviewId,
        member.panel_id,
        member.interviewer_name,
        member.interviewer_email,
        member.interviewer_type || "Interviewer",
        "Pending",
        user.name,
        new Date()
      ]
    );

    await taskService.createTask(pool, {
      module: "Interview Management",
      taskType: "Accept Interview Assignment",
      title: `Accept panel assignment for ${interview.roundType}`,
      assignee: member.interviewer_name || null,
      assigneeRole: "Interviewer",
      workflowInstanceId: interview.workflowInstanceId,
      stageKey: "scheduled",
      businessObjectType: "Interview",
      businessObjectId: interview.interviewId
    }, req);
  }

  return {
    interview,
    ruleEvaluation: ruleEval,
    toastMessage: "Panel assigned."
  };
}

async function seedConfiguration(pool, payload, user = { name: "System Seed", role: "Admin" }) {
  const seed = clonePayload(payload);

  for (const interview of seed.interviews || []) {
    await pool.query(
      `INSERT INTO im_interviews (
        interview_id, schedule_id, map_id, req_id, requisition_code, candidate_id,
        round_no, round_type, interview_date, interview_time, interview_status,
        workflow_instance_id, meeting_link, feedback_submitted, final_outcome,
        created_by, modified_by, effective_from
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
      ON CONFLICT (interview_id) DO UPDATE SET interview_status = EXCLUDED.interview_status`,
      [
        interview.interview_id,
        interview.schedule_id || null,
        interview.map_id || null,
        interview.req_id || null,
        interview.requisition_code || null,
        interview.candidate_id || null,
        interview.round_no || 1,
        interview.round_type,
        interview.interview_date,
        interview.interview_time,
        interview.interview_status || "Scheduled",
        interview.workflow_instance_id || null,
        interview.meeting_link || null,
        interview.feedback_submitted || false,
        interview.final_outcome || null,
        user.name,
        user.name,
        new Date()
      ]
    );
  }

  for (const task of seed.tasks || []) {
    await pool.query(
      `INSERT INTO et_tasks (
        module, task_type, title, status, priority, assignee, assignee_role,
        due_at, sla_hours, workflow_instance_id, business_object_type, business_object_id,
        metadata, created_by, effective_from
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        task.module,
        task.task_type,
        task.title,
        task.status || "Pending",
        task.priority || "Normal",
        task.assignee || null,
        task.assignee_role || null,
        task.due_at ? new Date(task.due_at) : new Date(Date.now() + 86400000),
        task.sla_hours || 24,
        task.workflow_instance_id || null,
        task.business_object_type || null,
        task.business_object_id || null,
        JSON.stringify(task.metadata || {}),
        user.name,
        new Date()
      ]
    );
  }
}

module.exports = {
  getDefaultSeedPayload,
  getInterviewBundle,
  scheduleInterview,
  linkLegacySchedule,
  getInterview,
  acceptAssignment,
  rescheduleInterview,
  completeInterview,
  submitFeedback,
  reassignPanel,
  assignPanel,
  validateMasterDataReferences,
  evaluateInterviewRules,
  seedConfiguration
};
