const businessRulesService = require("./businessRulesService");
const workflowService = require("./workflowService");
const masterDataService = require("./masterDataService");
const taskService = require("./taskService");
const { writeEnterpriseAudit, userContext } = require("./enterpriseAuditService");
const { isLegacyDualWriteEnabled, isEnterpriseOperationalSor } = require("../config/operationalCutover");
const { normalizeRating, formatRatingLabel } = require("./operationalMigrationService");
const interviewRepeatStageService = require("./interviewRepeatStageService");
const interviewFeedbackConfidentialityService = require("./interviewFeedbackConfidentialityService");

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

const INTERVIEW_STATUS = {
  SCHEDULED: "Scheduled",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled"
};

const INTERVIEW_OPEN_TASK_TYPES = [
  "Accept Interview Assignment",
  "Conduct Interview",
  "Submit Interview Feedback"
];

function formatInterviewTimeValue(value) {
  if (value == null || value === "") {
    return null;
  }

  if (typeof value === "string") {
    return value.length >= 5 ? value.slice(0, 8) : value;
  }

  return String(value);
}

function formatInterviewDateValue(value) {
  if (value == null || value === "") {
    return null;
  }

  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }

  return String(value).slice(0, 10);
}

function assertInterviewMutableState(interview) {
  if (interview.feedbackSubmitted) {
    throw httpError("Interview cannot be changed after feedback has been submitted.", 400);
  }

  if (interview.interviewStatus === INTERVIEW_STATUS.CANCELLED) {
    throw httpError("Interview is already cancelled.", 400);
  }

  if (interview.interviewStatus === INTERVIEW_STATUS.COMPLETED) {
    throw httpError("Completed interviews cannot be rescheduled or cancelled.", 400);
  }

  if (interview.interviewStatus !== INTERVIEW_STATUS.SCHEDULED) {
    throw httpError("Only scheduled interviews can be rescheduled or cancelled.", 400);
  }
}

function assertFutureInterviewSlot(interviewDate, interviewTime) {
  if (!interviewDate || !interviewTime) {
    throw httpError("Interview date and time are required.", 400);
  }

  const selectedDate = new Date(interviewDate);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  if (Number.isNaN(selectedDate.getTime())) {
    throw httpError("Interview date is invalid.", 400);
  }

  if (selectedDate < today) {
    throw httpError("Interview date cannot be in the past.", 400);
  }

  const slotStart = new Date(`${formatInterviewDateValue(interviewDate)}T${formatInterviewTimeValue(interviewTime)}`);

  if (!Number.isNaN(slotStart.getTime()) && slotStart < new Date()) {
    throw httpError("Interview date and time must be in the future.", 400);
  }
}

function addHoursToDate(date, hours) {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

function buildDueAtFromInterviewSlot(interviewDate, interviewTime, slaHours = 72) {
  const start = new Date(
    `${formatInterviewDateValue(interviewDate)}T${formatInterviewTimeValue(interviewTime)}`
  );

  if (Number.isNaN(start.getTime())) {
    return addHoursToDate(new Date(), slaHours);
  }

  return addHoursToDate(start, slaHours);
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
    remarks: row.remarks,
    cancelledAt: row.cancelled_at,
    cancelledBy: row.cancelled_by,
    cancellationReason: row.cancellation_reason
  };
}

function buildInterviewBundleSummary(rows) {
  return {
    scheduled: rows.filter((row) => row.interview_status === "Scheduled").length,
    completed: rows.filter((row) => row.interview_status === "Completed").length,
    pendingFeedback: rows.filter(
      (row) =>
        !row.feedback_submitted
        && row.interview_status !== INTERVIEW_STATUS.CANCELLED
    ).length
  };
}

async function listScopedInterviewRows(pool, req) {
  if (isAdminUser(req)) {
    const result = await pool.query(
      "SELECT * FROM im_interviews ORDER BY created_on DESC"
    );
    return result.rows;
  }

  const employeeCode = String(req.user?.employee_code || "").trim();
  const panelIds = await resolveCallerPanelIds(pool, req);
  const panelIdList = panelIds.length ? panelIds : [-1];

  const result = await pool.query(
    `SELECT DISTINCT i.*
     FROM im_interviews i
     LEFT JOIN rm_candidate_mappings rcm
       ON rcm.map_id = i.map_id
      AND rcm.is_active = true
     LEFT JOIN cand_mstr cm
       ON cm.candidate_id = COALESCE(rcm.candidate_id, i.candidate_id)
     LEFT JOIN im_panel_assignments ipa
       ON ipa.interview_id = i.interview_id
      AND ipa.assignment_status <> 'Reassigned'
     LEFT JOIN interview_schedule_trn ist
       ON ist.schedule_id = i.schedule_id
     WHERE (
       EXISTS (
         SELECT 1
         FROM rm_recruiter_assignments a
         WHERE a.recruiter_code = $1
           AND a.is_active = true
           AND (
             (i.requisition_code IS NOT NULL AND a.requisition_code = i.requisition_code)
             OR (i.req_id IS NOT NULL AND a.req_id = i.req_id)
           )
       )
       OR ($1 <> '' AND cm.owner_employee_code = $1)
       OR ipa.panel_id = ANY($2::int[])
       OR ist.interviewer_id = ANY($2::int[])
     )
     ORDER BY i.created_on DESC`,
    [employeeCode, panelIdList]
  );

  return result.rows;
}

async function listScopedPanelAssignmentRows(pool, req, interviewIds) {
  if (!interviewIds.length) {
    return [];
  }

  const result = await pool.query(
    `SELECT *
     FROM im_panel_assignments
     WHERE interview_id = ANY($1::varchar[])
     ORDER BY assigned_on DESC`,
    [interviewIds]
  );

  return result.rows;
}

async function getInterviewBundle(pool, req) {
  if (!req?.user) {
    throw httpError("Authentication required.", 401);
  }

  const interviewRows = await listScopedInterviewRows(pool, req);
  const canReadHr =
    await interviewFeedbackConfidentialityService.canReadHrInterviewFeedback(pool, req);
  const bundleRows = interviewRows.map((row) =>
    interviewFeedbackConfidentialityService.redactHrInterviewEnterpriseRow(row, canReadHr)
  );
  const interviewIds = bundleRows.map((row) => row.interview_id);
  const panelRows = await listScopedPanelAssignmentRows(pool, req, interviewIds);

  const interviews = bundleRows.map(mapInterviewRow);

  return interviewFeedbackConfidentialityService.sanitizeInterviewBundleForCaller(
    pool,
    req,
    {
      interviews,
      panelAssignments: panelRows,
      summary: buildInterviewBundleSummary(bundleRows)
    }
  );
}

async function scheduleInterview(pool, payload, req) {
  const user = userContext(req);
  const platformConfig = await loadPlatformConfig(pool);
  await assertInterviewModuleEnabled(platformConfig);

  const {
    map_id: mapId,
    interviewer_id: interviewerId,
    round_type: roundType,
    interview_date: interviewDate,
    interview_time: interviewTime,
    remarks,
    interviewer_name: interviewerName,
    interviewer_email: interviewerEmail,
    interviewer_type: interviewerType
  } = payload;

  let resolvedReqId = payload.req_id ?? null;

  if (!mapId || !interviewerId || !roundType || !interviewDate || !interviewTime) {
    throw httpError("Required fields are missing.", 400);
  }

  const recruitmentService = require("./recruitmentService");
  await recruitmentService.assertAuthorizedMappingAccess(pool, req, mapId);

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
    `SELECT mapping_id, candidate_id, req_id, requisition_code, stage_name
     FROM rm_candidate_mappings
     WHERE map_id = $1 AND is_active = true`,
    [mapId]
  );

  if (enterpriseMap.rows.length) {
    candidateId = enterpriseMap.rows[0].candidate_id;
    resolvedReqId ||= enterpriseMap.rows[0].req_id;
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
    resolvedReqId ||= mapResult.rows[0].req_id;
  } else {
    throw httpError("Candidate mapping not found.", 404);
  }

  if (!requisitionCode) {
    const rmResult = await pool.query(
      "SELECT requisition_code FROM rm_requisitions WHERE req_id = $1 LIMIT 1",
      [resolvedReqId]
    );
    requisitionCode = rmResult.rows[0]?.requisition_code || null;
  }

  if (requisitionCode) {
    const requisitionResult = await pool.query(
      `SELECT requisition_code, req_status
       FROM rm_requisitions
       WHERE requisition_code = $1`,
      [requisitionCode]
    );
    const requisition = requisitionResult.rows[0];

    if (requisition) {
      const { assertRequisitionOpenForRecruiting } = require("./requisitionFulfillmentService");
      assertRequisitionOpenForRecruiting(requisition);
    }
  }

  const runScheduleMutations = async (db) => {
  const { repeatMetadata } = await interviewRepeatStageService.assertRepeatScheduleAuthorized(
    db,
    req,
    mapId,
    roundType,
    payload
  );

  const roundNo = await interviewRepeatStageService.allocateSessionRoundNo(
    db,
    mapId,
    roundType
  );

  const ruleEval = await evaluateInterviewRules(db, {
    round_type: roundType,
    department: payload.department,
    grade: payload.grade,
    primary_skill: payload.primary_skill,
    action: "schedule_interview"
  }, req);

  const interviewId = generateInterviewId();
  const instance = await workflowService.startWorkflow(
    db,
    "INTERVIEW",
    {
      instance_id: `WF-INT-${interviewId}`,
      meta: {
        interview_id: interviewId,
        map_id: mapId,
        req_id: resolvedReqId,
        round_type: roundType
      }
    },
    req
  );

  await workflowService.advanceWorkflow(
    db,
    instance.instanceId,
    "advance",
    { stageKey: "requested", actor: user.name, comment: "Interview scheduled" },
    req
  );

  await workflowService.advanceWorkflow(
    db,
    instance.instanceId,
    "advance",
    { stageKey: "scheduled", actor: user.name, comment: remarks || "" },
    req
  );

  const feedbackReminderHours = platformConfig?.modules?.find(
    (item) => item.key === "interview_management"
  )?.settings?.feedback_reminder_hours || 24;

  await db.query(
    `INSERT INTO im_interviews (
      interview_id, map_id, req_id, requisition_code, candidate_id, round_no, round_type,
      interview_date, interview_time, interview_status, workflow_instance_id, remarks,
      created_by, modified_by, effective_from
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [
      interviewId,
      mapId,
      resolvedReqId,
      requisitionCode,
      candidateId,
      roundNo,
      roundType,
      interviewDate,
      interviewTime,
      "Scheduled",
      instance.instanceId,
      remarks || null,
      user.employeeCode || user.name,
      user.name,
      new Date()
    ]
  );

  await db.query(
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

  const taskTx = db !== pool ? { client: db } : null;

  await taskService.createTask(db, {
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
  }, req, taskTx);

  await taskService.createTask(db, {
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
  }, req, taskTx);

  await recordInterviewHistory(
    db,
    interviewId,
    "InterviewScheduled",
    user.name,
    null,
    "Scheduled",
    repeatMetadata?.repeatReason || remarks,
    repeatMetadata || null
  );

  await writeEnterpriseAudit(db, {
    eventType: "InterviewScheduled",
    module: "Interview Management",
    entity: "Interview",
    entityId: interviewId,
    action: `${roundType} interview scheduled`,
    userName: user.name,
    userRole: user.role,
    metadata: { mapId, reqId: resolvedReqId, ruleEvaluation: ruleEval, feedbackReminderHours }
  });

  const stageName = stageNameForRound(roundType);

  if (isEnterpriseOperationalSor() && enterpriseMap.rows.length) {
    const recruitmentService = require("./recruitmentService");
    await recruitmentService.applyGovernedCandidateStageTransition(
      db,
      mapId,
      stageName,
      remarks || "",
      req,
      {
        pipelineEventType: "InterviewScheduledStage",
        skipIfUnchanged: true,
        useOperationalStageName: true,
        policyClient: db !== pool ? db : null,
        historyMetadata: {
          interviewId,
          roundType,
          reqId: resolvedReqId,
          ruleEvaluation: ruleEval
        }
      }
    );
  } else if (
    isLegacyDualWriteEnabled()
    && (await tableExists(db, "candidate_req_map"))
  ) {
    await db.query(
      "UPDATE candidate_req_map SET stage_name = $1 WHERE map_id = $2",
      [stageName, mapId]
    );
  }

  return {
    interviewId,
    interview: mapInterviewRow({
      interview_id: interviewId,
      schedule_id: null,
      map_id: mapId,
      req_id: resolvedReqId,
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
  };

  if (candidateId) {
    const candidateOfferHoldService = require("./candidateOfferHoldService");
    return candidateOfferHoldService.withCandidatePolicyTransaction(
      pool,
      candidateId,
      async (client) => {
        await candidateOfferHoldService.assertNoActiveHoldUnderPolicyLock(
          client,
          candidateId,
          req
        );
        return runScheduleMutations(client);
      }
    );
  }

  return runScheduleMutations(pool);
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

async function resolveActiveInterviewPanelRow(pool, interviewerId) {
  if (
    interviewerId === null
    || interviewerId === undefined
    || String(interviewerId).trim() === ""
  ) {
    return {};
  }

  if (!(await tableExists(pool, "interview_panel_mstr"))) {
    return {};
  }

  const panelResult = await pool.query(
    `SELECT panel_id, interviewer_name, email_id, interviewer_type
     FROM interview_panel_mstr
     WHERE panel_id = $1
       AND is_active = true`,
    [interviewerId]
  );

  if (!panelResult.rows.length) {
    throw httpError("Interviewer not found or inactive", 404);
  }

  return panelResult.rows[0];
}

async function loadCandidateContactForInterviewMap(pool, mapId) {
  let candidateResult = await pool.query(
    `SELECT CONCAT(cm.first_name, ' ', cm.last_name) AS candidate_name,
            cm.email_id AS candidate_email
     FROM cand_mstr cm
     INNER JOIN rm_candidate_mappings rcm ON rcm.candidate_id = cm.candidate_id
     WHERE rcm.map_id = $1
       AND rcm.is_active = true`,
    [mapId]
  ).catch(() => ({ rows: [] }));

  if (!candidateResult.rows.length && (await tableExists(pool, "candidate_req_map"))) {
    candidateResult = await pool.query(
      `SELECT CONCAT(cm.first_name, ' ', cm.last_name) AS candidate_name,
              cm.email_id AS candidate_email
       FROM cand_mstr cm
       INNER JOIN candidate_req_map crm ON crm.candidate_id = cm.candidate_id
       WHERE crm.map_id = $1`,
      [mapId]
    ).catch(() => ({ rows: [] }));
  }

  return candidateResult.rows[0] || {};
}

/**
 * Canonical interview schedule — enterprise SoR plus optional Teams/email/legacy trn.
 */
async function scheduleInterviewCanonical(pool, body, req, helpers = {}) {
  const panelRow = await resolveActiveInterviewPanelRow(pool, body.interviewer_id);

  const enterprise = await scheduleInterview(
    pool,
    {
      ...body,
      interviewer_name: body.interviewer_name || panelRow.interviewer_name,
      interviewer_email: body.interviewer_email || panelRow.email_id,
      interviewer_type: body.interviewer_type || panelRow.interviewer_type
    },
    req
  );

  let teamsLink = null;
  let teamsEventId = null;
  let legacyScheduleRow = null;

  if (helpers.createInterviewMeeting) {
    const candidateContact = await loadCandidateContactForInterviewMap(
      pool,
      body.map_id
    );
    const candidateName = candidateContact.candidate_name;
    const candidateEmail = candidateContact.candidate_email;

    try {
      const meeting = await helpers.createInterviewMeeting(
        body.interview_date,
        body.interview_time,
        body.round_type,
        candidateName,
        candidateEmail,
        panelRow.email_id,
        req.user?.email_id
      );
      teamsLink = meeting?.joinUrl || meeting?.teamsLink || null;
      teamsEventId = meeting?.eventId || meeting?.teamsEventId || null;

      const recruiterEmail = req.user?.email_id || null;
      const interviewNotificationService = require("./interviewNotificationService");

      if (
        helpers.sendInterviewEmail
        && candidateEmail
        && candidateName
        && recruiterEmail
      ) {
        await interviewNotificationService.notifyInterviewScheduled(
          pool,
          {
            interviewId: enterprise.interviewId,
            candidateEmail,
            candidateName,
            roundType: body.round_type,
            interviewDate: body.interview_date,
            interviewTime: body.interview_time,
            teamsLink,
            recruiterEmail,
            mapId: body.map_id,
            reqId: body.req_id
          },
          { deliverInterviewEmail: helpers.sendInterviewEmail }
        );
      }
    } catch (teamsError) {
      console.warn("Teams meeting skipped:", teamsError.message);
    }
  }

  if (await tableExists(pool, "interview_schedule_trn")) {
    const scheduleResult = await pool.query(
      `INSERT INTO interview_schedule_trn (
        req_id, map_id, interviewer_id, round_no, round_type,
        interview_date, interview_time, meeting_link, teams_event_id, remarks, created_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [
        body.req_id,
        body.map_id,
        body.interviewer_id,
        enterprise.interview?.roundNo
          || enterprise.interview?.round_no
          || body.round_no
          || 1,
        body.round_type,
        body.interview_date,
        body.interview_time,
        teamsLink,
        teamsEventId,
        body.remarks || null,
        req.user?.employee_code || null
      ]
    );

    legacyScheduleRow = scheduleResult.rows[0];

    await linkLegacySchedule(
      pool,
      enterprise.interviewId,
      legacyScheduleRow.schedule_id,
      teamsLink,
      teamsEventId,
      req
    );
  }

  try {
    const interviewNotificationService = require("./interviewNotificationService");
    await interviewNotificationService.notifyInterviewParticipants(pool, {
      interviewId: enterprise.interviewId,
      outcomeKey: "interview_scheduled",
      actorEmployeeCode: req.user?.employee_code || null
    });
  } catch (bellError) {
    console.error("[interview bell] schedule:", bellError.message);
  }

  return {
    ...enterprise,
    teamsLink,
    teamsEventId,
    legacyScheduleRow
  };
}

async function fetchInterviewRowByLookup(pool, interviewId) {
  const result = await pool.query(
    "SELECT * FROM im_interviews WHERE interview_id = $1 OR schedule_id::text = $1 LIMIT 1",
    [interviewId]
  );

  return result.rows[0] || null;
}

/**
 * Same visibility rules as GET /api/v1/interviews bundle (listScopedInterviewRows).
 * Admin retains unrestricted read access.
 */
async function assertInterviewScheduleMutateAccess(pool, req, interviewRow) {
  if (!req?.user) {
    throw httpError("Authentication required.", 401);
  }

  if (isAdminUser(req)) {
    return;
  }

  const mapId = interviewRow.map_id;

  if (!mapId) {
    throw httpError(
      "Enterprise Access Denied. You are not authorized to manage this interview.",
      403
    );
  }

  const recruitmentService = require("./recruitmentService");
  await recruitmentService.assertAuthorizedMappingAccess(pool, req, mapId);
}

async function syncLegacyScheduleMirror(
  pool,
  scheduleId,
  { interviewDate, interviewTime, interviewStatus }
) {
  if (!scheduleId || !(await tableExists(pool, "interview_schedule_trn"))) {
    return;
  }

  const sets = [];
  const values = [];
  let index = 1;

  if (interviewDate != null) {
    sets.push(`interview_date = $${index++}`);
    values.push(interviewDate);
  }

  if (interviewTime != null) {
    sets.push(`interview_time = $${index++}`);
    values.push(interviewTime);
  }

  if (interviewStatus != null) {
    sets.push(`interview_status = $${index++}`);
    values.push(interviewStatus);
  }

  if (!sets.length) {
    return;
  }

  values.push(scheduleId);
  await pool.query(
    `UPDATE interview_schedule_trn SET ${sets.join(", ")} WHERE schedule_id = $${index}`,
    values
  );
}

async function listOpenInterviewTasks(pool, interviewId) {
  const result = await pool.query(
    `SELECT task_id, task_type, status
     FROM et_tasks
     WHERE module = 'Interview Management'
       AND business_object_type = 'Interview'
       AND business_object_id = $1
       AND status NOT IN ('Completed', 'Cancelled')
     ORDER BY created_on ASC`,
    [interviewId]
  );

  return result.rows;
}

async function cancelOpenInterviewTasks(
  pool,
  interviewId,
  req,
  comments = "",
  txOptions = null
) {
  const queryable = txOptions?.client || pool;
  const openTasks = await listOpenInterviewTasks(queryable, interviewId);

  for (const row of openTasks) {
    if (!INTERVIEW_OPEN_TASK_TYPES.includes(row.task_type)) {
      continue;
    }

    await taskService.cancelTask(pool, row.task_id, req, comments, txOptions);
  }
}

async function syncRescheduleConductInterviewTask(
  pool,
  interview,
  interviewDate,
  interviewTime,
  req
) {
  const dueAt = buildDueAtFromInterviewSlot(interviewDate, interviewTime, 72);
  const title = `Conduct ${interview.roundType} interview`;
  const metadata = {
    interviewDate,
    interviewTime,
    rescheduled: true
  };

  const openConduct = await pool.query(
    `SELECT task_id
     FROM et_tasks
     WHERE module = 'Interview Management'
       AND task_type = 'Conduct Interview'
       AND business_object_type = 'Interview'
       AND business_object_id = $1
       AND status NOT IN ('Completed', 'Cancelled')
     ORDER BY created_on DESC
     LIMIT 1`,
    [interview.interviewId]
  );

  if (openConduct.rows.length) {
    await pool.query(
      `UPDATE et_tasks
       SET title = $1, due_at = $2, metadata = $3::jsonb, modified_on = NOW()
       WHERE task_id = $4`,
      [title, dueAt, JSON.stringify(metadata), openConduct.rows[0].task_id]
    );
    return;
  }

  await taskService.createTask(pool, {
    module: "Interview Management",
    taskType: "Conduct Interview",
    title,
    assigneeRole: "Interviewer",
    slaHours: 72,
    dueAt: dueAt.toISOString(),
    workflowInstanceId: interview.workflowInstanceId,
    stageKey: "scheduled",
    businessObjectType: "Interview",
    businessObjectId: interview.interviewId,
    metadata
  }, req);
}

async function assertInterviewReadAccess(pool, req, interviewRow) {
  if (!req?.user) {
    throw httpError("Authentication required.", 401);
  }

  if (isAdminUser(req)) {
    return;
  }

  const employeeCode = String(req.user?.employee_code || "").trim();
  const panelIds = await resolveCallerPanelIds(pool, req);
  const panelIdList = panelIds.length ? panelIds : [-1];

  const result = await pool.query(
    `SELECT 1
     FROM im_interviews i
     LEFT JOIN rm_candidate_mappings rcm
       ON rcm.map_id = i.map_id
      AND rcm.is_active = true
     LEFT JOIN cand_mstr cm
       ON cm.candidate_id = COALESCE(rcm.candidate_id, i.candidate_id)
     LEFT JOIN im_panel_assignments ipa
       ON ipa.interview_id = i.interview_id
      AND ipa.assignment_status <> 'Reassigned'
     LEFT JOIN interview_schedule_trn ist
       ON ist.schedule_id = i.schedule_id
     WHERE i.interview_id = $3
       AND (
         EXISTS (
           SELECT 1
           FROM rm_recruiter_assignments a
           WHERE a.recruiter_code = $1
             AND a.is_active = true
             AND (
               (i.requisition_code IS NOT NULL AND a.requisition_code = i.requisition_code)
               OR (i.req_id IS NOT NULL AND a.req_id = i.req_id)
             )
         )
         OR ($1 <> '' AND cm.owner_employee_code = $1)
         OR ipa.panel_id = ANY($2::int[])
         OR ist.interviewer_id = ANY($2::int[])
       )
     LIMIT 1`,
    [employeeCode, panelIdList, interviewRow.interview_id]
  );

  if (!result.rows.length) {
    throw httpError(
      "Enterprise Access Denied. You are not authorized to view this interview.",
      403
    );
  }
}

async function getInterviewForRequest(pool, interviewId, req) {
  const row = await fetchInterviewRowByLookup(pool, interviewId);

  if (!row) {
    throw httpError(`Interview not found: ${interviewId}`, 404);
  }

  await assertInterviewReadAccess(pool, req, row);
  const canReadHr =
    await interviewFeedbackConfidentialityService.canReadHrInterviewFeedback(pool, req);
  const redacted = interviewFeedbackConfidentialityService.redactHrInterviewEnterpriseRow(
    row,
    canReadHr
  );
  return interviewFeedbackConfidentialityService.redactHrInterviewBundleDto(
    mapInterviewRow(redacted),
    canReadHr
  );
}

async function getInterview(pool, interviewId) {
  const row = await fetchInterviewRowByLookup(pool, interviewId);

  if (!row) {
    throw httpError(`Interview not found: ${interviewId}`, 404);
  }

  return mapInterviewRow(row);
}

async function acceptAssignment(pool, interviewId, req) {
  const user = userContext(req);
  const row = await fetchInterviewRowByLookup(pool, interviewId);

  if (!row) {
    throw httpError(`Interview not found: ${interviewId}`, 404);
  }

  await assertInterviewPanelActionAccess(pool, req, row);
  const interview = mapInterviewRow(row);

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
  const row = await fetchInterviewRowByLookup(pool, interviewId);

  if (!row) {
    throw httpError(`Interview not found: ${interviewId}`, 404);
  }

  await assertInterviewScheduleMutateAccess(pool, req, row);
  const interview = mapInterviewRow(row);
  const platformConfig = await loadPlatformConfig(pool);
  await assertInterviewModuleEnabled(platformConfig);

  assertInterviewMutableState(interview);

  const { interview_date: interviewDate, interview_time: interviewTime, remarks } = payload;
  assertFutureInterviewSlot(interviewDate, interviewTime);

  const previousDate = formatInterviewDateValue(interview.interviewDate);
  const previousTime = formatInterviewTimeValue(interview.interviewTime);

  const historyMetadata = {
    previous_interview_date: previousDate,
    previous_interview_time: previousTime,
    interview_date: interviewDate,
    interview_time: interviewTime
  };

  const runRescheduleMutations = async (db) => {
    await db.query(
      `UPDATE im_interviews
       SET interview_date = $1, interview_time = $2, remarks = COALESCE($3, remarks),
           modified_by = $4, modified_on = NOW()
       WHERE interview_id = $5`,
      [interviewDate, interviewTime, remarks, user.name, interview.interviewId]
    );

    await syncLegacyScheduleMirror(db, interview.scheduleId, {
      interviewDate,
      interviewTime
    });

    await syncRescheduleConductInterviewTask(
      db,
      interview,
      interviewDate,
      interviewTime,
      req
    );

    await recordInterviewHistory(
      db,
      interview.interviewId,
      "InterviewRescheduled",
      user.name,
      interview.interviewStatus,
      INTERVIEW_STATUS.SCHEDULED,
      remarks,
      historyMetadata
    );

    await writeEnterpriseAudit(db, {
      eventType: "InterviewRescheduled",
      module: "Interview Management",
      entity: "Interview",
      entityId: interview.interviewId,
      action: "Interview rescheduled",
      userName: user.name,
      userRole: user.role,
      metadata: historyMetadata
    });
  };

  if (interview.candidateId) {
    const candidateOfferHoldService = require("./candidateOfferHoldService");
    await candidateOfferHoldService.withCandidatePolicyTransaction(
      pool,
      interview.candidateId,
      async (client) => {
        await candidateOfferHoldService.assertNoActiveHoldUnderPolicyLock(
          client,
          interview.candidateId,
          req
        );
        await runRescheduleMutations(client);
      }
    );
  } else {
    await runRescheduleMutations(pool);
  }

  try {
    const interviewNotificationService = require("./interviewNotificationService");
    await interviewNotificationService.notifyInterviewParticipants(pool, {
      interviewId: interview.interviewId,
      outcomeKey: "interview_rescheduled",
      actorEmployeeCode: user.employeeCode
    });
  } catch (bellError) {
    console.error("[interview bell] reschedule:", bellError.message);
  }

  return {
    interview: await getInterview(pool, interview.interviewId),
    toastMessage: "Interview rescheduled successfully."
  };
}

async function cancelInterviewForOfferHold(pool, interviewId, req, metadata = {}) {
  const {
    CANCELLATION_REASON_OFFER_HOLD
  } = require("./candidateOfferHoldService");

  return cancelInterview(
    pool,
    interviewId,
    {
      cancellation_reason: CANCELLATION_REASON_OFFER_HOLD,
      notes: metadata.offerId
        ? `Offer ${metadata.offerId} released`
        : "Offer Hold activation"
    },
    req,
    { bypassScheduleAccess: true }
  );
}

async function cancelInterview(pool, interviewId, payload, req, options = {}) {
  const user = userContext(req);
  const row = await fetchInterviewRowByLookup(pool, interviewId);

  if (!row) {
    throw httpError(`Interview not found: ${interviewId}`, 404);
  }

  if (!options.bypassScheduleAccess) {
    await assertInterviewScheduleMutateAccess(pool, req, row);
  }
  const interview = mapInterviewRow(row);
  const platformConfig = await loadPlatformConfig(pool);
  await assertInterviewModuleEnabled(platformConfig);

  assertInterviewMutableState(interview);

  const cancellationReason = String(
    payload?.cancellation_reason || payload?.cancellationReason || ""
  ).trim();
  const notes = String(payload?.notes || "").trim();

  if (!cancellationReason) {
    throw httpError("Cancellation reason is required.", 400);
  }

  const reasonText = notes
    ? `${cancellationReason} — ${notes}`
    : cancellationReason;

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(
      `UPDATE im_interviews
       SET interview_status = $1,
           cancelled_at = NOW(),
           cancelled_by = $2,
           cancellation_reason = $3,
           modified_by = $2,
           modified_on = NOW()
       WHERE interview_id = $4`,
      [INTERVIEW_STATUS.CANCELLED, user.name, reasonText, interview.interviewId]
    );

    await syncLegacyScheduleMirror(client, interview.scheduleId, {
      interviewStatus: INTERVIEW_STATUS.CANCELLED
    });

    await cancelOpenInterviewTasks(
      pool,
      interview.interviewId,
      req,
      "Interview cancelled",
      { client }
    );

    await recordInterviewHistory(
      client,
      interview.interviewId,
      "InterviewCancelled",
      user.name,
      interview.interviewStatus,
      INTERVIEW_STATUS.CANCELLED,
      reasonText,
      { cancellation_reason: cancellationReason, notes: notes || null }
    );

    await writeEnterpriseAudit(client, {
      eventType: "InterviewCancelled",
      module: "Interview Management",
      entity: "Interview",
      entityId: interview.interviewId,
      action: "Interview cancelled",
      userName: user.name,
      userRole: user.role,
      metadata: {
        cancellation_reason: cancellationReason,
        notes: notes || null
      }
    });

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  try {
    const interviewNotificationService = require("./interviewNotificationService");
    await interviewNotificationService.notifyInterviewParticipants(pool, {
      interviewId: interview.interviewId,
      outcomeKey: "interview_cancelled",
      actorEmployeeCode: user.employeeCode
    });
  } catch (bellError) {
    console.error("[interview bell] cancel:", bellError.message);
  }

  return {
    interview: await getInterview(pool, interview.interviewId),
    toastMessage: "Interview cancelled successfully."
  };
}

async function completeInterview(pool, interviewId, req, comments = "") {
  const user = userContext(req);
  const row = await fetchInterviewRowByLookup(pool, interviewId);

  if (!row) {
    throw httpError(`Interview not found: ${interviewId}`, 404);
  }

  await assertInterviewReadAccess(pool, req, row);
  const interview = mapInterviewRow(row);

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

function isAdminUser(req) {
  return String(req.user?.role_name || "").trim() === "Admin";
}

async function resolveCallerPanelIds(pool, req) {
  const employeeCode = String(req.user?.employee_code || "").trim();
  const userId = req.user?.user_id;

  if (!employeeCode && !userId) {
    return [];
  }

  const result = await pool.query(
    `SELECT panel_id
     FROM interview_panel_mstr
     WHERE is_active = true
       AND (
         ($1 <> '' AND employee_code = $1)
         OR ($2::int IS NOT NULL AND user_id = $2)
       )`,
    [employeeCode, userId || null]
  );

  return result.rows.map((row) => row.panel_id);
}

async function resolveInterviewScheduleContext(pool, { scheduleId, interviewId }) {
  const lookupKey = scheduleId ?? interviewId;
  if (lookupKey == null || lookupKey === "") {
    throw httpError("schedule_id or interview_id is required.", 400);
  }

  const enterprise = await pool.query(
    `SELECT interview_id, schedule_id
     FROM im_interviews
     WHERE schedule_id::text = $1::text OR interview_id = $1
     LIMIT 1`,
    [lookupKey]
  );

  if (enterprise.rows.length) {
    return enterprise.rows[0];
  }

  if (scheduleId != null && scheduleId !== "" && (await tableExists(pool, "interview_schedule_trn"))) {
    const legacy = await pool.query(
      `SELECT schedule_id, NULL::varchar AS interview_id
       FROM interview_schedule_trn
       WHERE schedule_id = $1
       LIMIT 1`,
      [scheduleId]
    );

    if (legacy.rows.length) {
      return legacy.rows[0];
    }
  }

  return null;
}

async function isCallerAssignedToInterview(pool, panelIds, context) {
  if (!panelIds.length) {
    return false;
  }

  const scheduleId = context.schedule_id;
  const interviewId = context.interview_id;

  if (scheduleId && (await tableExists(pool, "interview_schedule_trn"))) {
    const legacy = await pool.query(
      `SELECT 1
       FROM interview_schedule_trn
       WHERE schedule_id = $1 AND interviewer_id = ANY($2::int[])
       LIMIT 1`,
      [scheduleId, panelIds]
    );

    if (legacy.rows.length) {
      return true;
    }
  }

  if (interviewId) {
    const enterprise = await pool.query(
      `SELECT 1
       FROM im_panel_assignments
       WHERE interview_id = $1
         AND panel_id = ANY($2::int[])
         AND assignment_status <> 'Reassigned'
       LIMIT 1`,
      [interviewId, panelIds]
    );

    if (enterprise.rows.length) {
      return true;
    }
  }

  if (scheduleId) {
    const bySchedule = await pool.query(
      `SELECT 1
       FROM im_interviews i
       INNER JOIN im_panel_assignments ipa ON ipa.interview_id = i.interview_id
       WHERE i.schedule_id = $1
         AND ipa.panel_id = ANY($2::int[])
         AND ipa.assignment_status <> 'Reassigned'
       LIMIT 1`,
      [scheduleId, panelIds]
    );

    if (bySchedule.rows.length) {
      return true;
    }
  }

  return false;
}

async function isCallerRecruiterAssignedToScheduleContext(pool, employeeCode, context) {
  const code = String(employeeCode || "").trim();
  if (!code) {
    return false;
  }

  const scheduleId = context.schedule_id;
  const interviewId = context.interview_id;

  const recruiterMatchSql = `
    EXISTS (
      SELECT 1
      FROM rm_recruiter_assignments a
      WHERE a.recruiter_code = $1
        AND a.is_active = true
        AND (
          (target.requisition_code IS NOT NULL AND a.requisition_code = target.requisition_code)
          OR (target.req_id IS NOT NULL AND a.req_id = target.req_id)
        )
    )`;

  if (interviewId) {
    const byInterview = await pool.query(
      `SELECT 1
       FROM im_interviews target
       WHERE target.interview_id = $2
         AND ${recruiterMatchSql}
       LIMIT 1`,
      [code, interviewId]
    );

    if (byInterview.rows.length) {
      return true;
    }
  }

  if (scheduleId) {
    const byEnterpriseSchedule = await pool.query(
      `SELECT 1
       FROM im_interviews target
       WHERE target.schedule_id = $2
         AND ${recruiterMatchSql}
       LIMIT 1`,
      [code, scheduleId]
    );

    if (byEnterpriseSchedule.rows.length) {
      return true;
    }

    if (await tableExists(pool, "interview_schedule_trn")) {
      const byLegacySchedule = await pool.query(
        `SELECT 1
         FROM interview_schedule_trn target
         LEFT JOIN req_mstr rm ON rm.req_id = target.req_id
         WHERE target.schedule_id = $2
           AND EXISTS (
             SELECT 1
             FROM rm_recruiter_assignments a
             WHERE a.recruiter_code = $1
               AND a.is_active = true
               AND (
                 (target.req_id IS NOT NULL AND a.req_id = target.req_id)
                 OR (
                   rm.req_code IS NOT NULL
                   AND a.requisition_code IS NOT NULL
                   AND a.requisition_code = rm.req_code
                 )
               )
           )
         LIMIT 1`,
        [code, scheduleId]
      );

      if (byLegacySchedule.rows.length) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Panel-only actions (e.g. accept assignment) require an active panel row on the interview.
 */
async function assertInterviewPanelActionAccess(pool, req, interviewRow) {
  if (!req?.user) {
    throw httpError("Authentication required.", 401);
  }

  if (isAdminUser(req)) {
    return;
  }

  const panelIds = await resolveCallerPanelIds(pool, req);

  if (!panelIds.length) {
    throw httpError(
      "Enterprise Access Denied. You are not authorized to perform this interview action.",
      403
    );
  }

  const assigned = await isCallerAssignedToInterview(pool, panelIds, {
    interview_id: interviewRow.interview_id,
    schedule_id: interviewRow.schedule_id
  });

  if (!assigned) {
    throw httpError(
      "Enterprise Access Denied. You are not authorized to perform this interview action.",
      403
    );
  }
}

/**
 * Feedback read: Admin; active panel on the interview; or active recruiter assigned to
 * the interview requisition (aligned with interview schedule list scoping).
 */
async function assertInterviewFeedbackAccess(pool, req, { scheduleId, interviewId } = {}) {
  if (!req?.user) {
    throw httpError("Authentication required.", 401);
  }

  if (isAdminUser(req)) {
    return;
  }

  const context = await resolveInterviewScheduleContext(pool, { scheduleId, interviewId });

  if (!context) {
    throw httpError("Interview schedule not found.", 404);
  }

  const panelIds = await resolveCallerPanelIds(pool, req);

  if (panelIds.length) {
    const panelAssigned = await isCallerAssignedToInterview(pool, panelIds, context);
    if (panelAssigned) {
      return;
    }
  }

  const employeeCode = String(req.user?.employee_code || "").trim();
  const recruiterAssigned = await isCallerRecruiterAssignedToScheduleContext(
    pool,
    employeeCode,
    context
  );

  if (recruiterAssigned) {
    return;
  }

  throw httpError(
    "Enterprise Access Denied. You are not authorized to access feedback for this interview.",
    403
  );
}

async function assertInterviewFeedbackReadAccess(pool, req, { scheduleId, interviewId } = {}) {
  try {
    await assertInterviewFeedbackAccess(pool, req, { scheduleId, interviewId });
  } catch (error) {
    if (error.status !== 403) {
      throw error;
    }

    const mayReadHr =
      await interviewFeedbackConfidentialityService.canReadHrInterviewFeedback(
        pool,
        req
      );

    if (!mayReadHr) {
      throw error;
    }

    const context = await resolveInterviewScheduleContext(pool, {
      scheduleId,
      interviewId
    });

    if (!context) {
      throw error;
    }

    const recruitmentService = require("./recruitmentService");

    if (!context.map_id) {
      throw error;
    }

    await recruitmentService.assertAuthorizedMappingAccess(pool, req, context.map_id);
  }

  await interviewFeedbackConfidentialityService.assertInterviewFeedbackConfidentiality(
    pool,
    req,
    { scheduleId, interviewId }
  );
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

  await assertInterviewFeedbackAccess(pool, req, {
    scheduleId: interview.scheduleId || scheduleId,
    interviewId: interview.interviewId
  });

  if (interview.feedbackSubmitted) {
    throw httpError("Feedback already submitted for this interview.", 400);
  }

  const ruleEval = await evaluateInterviewRules(pool, {
    round_type: interview.roundType,
    final_outcome: finalOutcome,
    action: "submit_feedback"
  }, req);

  // Enterprise persistence expects numeric overall_rating (im_feedback).
  // API/UI continue to send business labels; normalize only at write time.
  const normalizedOverallRating = normalizeRating(overallRating);
  if (normalizedOverallRating == null) {
    throw httpError("Invalid overall_rating.", 400);
  }

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
      normalizedOverallRating,
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

  // Always flip legacy schedule flag when linked — Interviewer Home reads this row.
  // Full feedback hdr/dtl dual-write remains gated in syncLegacyFeedback.
  const linkedScheduleId = interview.scheduleId || scheduleId;
  if (linkedScheduleId && (await tableExists(pool, "interview_schedule_trn"))) {
    await pool.query(
      `UPDATE interview_schedule_trn
       SET feedback_submitted = true, interview_status = 'Completed', updated_on = NOW()
       WHERE schedule_id = $1`,
      [linkedScheduleId]
    );
  }

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

  await syncLegacyFeedback(pool, interview, payload, user, req);

  try {
    const interviewNotificationService = require("./interviewNotificationService");
    await interviewNotificationService.notifyFeedbackSubmitted(pool, {
      interviewId: interview.interviewId,
      scheduleId: interview.scheduleId || scheduleId,
      actorEmployeeCode: user.employeeCode
    });
  } catch (bellError) {
    console.error("[interview bell] feedback:", bellError.message);
  }

  return {
    interview: await getInterview(pool, interview.interviewId),
    toastMessage: "Feedback submitted successfully."
  };
}

/**
 * Enterprise SoR read for View Feedback.
 * Returns the legacy-compatible ViewFeedback response shape from im_feedback.
 */
async function getFeedbackBySchedule(pool, scheduleId, req) {
  if (scheduleId == null || scheduleId === "") {
    throw httpError("schedule_id is required.", 400);
  }

  await assertInterviewFeedbackReadAccess(pool, req, { scheduleId });

  const result = await pool.query(
    `
    SELECT
      f.feedback_id,
      f.schedule_id,
      f.interview_id,
      f.interview_level,
      f.area_of_interview,
      f.overall_rating,
      f.strengths,
      f.improvement_areas,
      f.overall_comments,
      f.final_outcome,
      f.skills,
      i.round_type,
      TO_CHAR(i.interview_date, 'DD-MM-YYYY') AS interview_date,
      TO_CHAR(i.interview_time, 'HH24:MI') AS interview_time,
      cm.candidate_code,
      CONCAT(cm.first_name, ' ', cm.last_name) AS candidate_name,
      COALESCE(rm.req_code, i.requisition_code) AS req_code,
      rm.job_title,
      (
        SELECT p.interviewer_name
        FROM im_panel_assignments p
        WHERE p.interview_id = i.interview_id
        ORDER BY p.assigned_on DESC NULLS LAST, p.assignment_id DESC
        LIMIT 1
      ) AS interviewer_name
    FROM im_feedback f
    LEFT JOIN im_interviews i
      ON i.interview_id = f.interview_id
    LEFT JOIN cand_mstr cm
      ON cm.candidate_id = i.candidate_id
    LEFT JOIN req_mstr rm
      ON rm.req_id = i.req_id
    WHERE f.schedule_id = $1
    ORDER BY f.feedback_id DESC
    LIMIT 1
    `,
    [scheduleId]
  );

  if (!result.rows.length) {
    return {
      success: true,
      feedbackExists: false
    };
  }

  const row = result.rows[0];
  let skills = row.skills;

  if (typeof skills === "string") {
    try {
      skills = JSON.parse(skills);
    } catch (_error) {
      skills = [];
    }
  }

  if (!Array.isArray(skills)) {
    skills = [];
  }

  const details = skills
    .filter((skill) => skill && String(skill.skill_name || "").trim())
    .map((skill, index) => ({
      detail_id: index + 1,
      feedback_id: row.feedback_id,
      skill_name: skill.skill_name,
      rating: Number(skill.rating) || 0,
      comments: skill.comments || ""
    }));

  return {
    success: true,
    feedbackExists: true,
    header: {
      feedback_id: row.feedback_id,
      schedule_id: row.schedule_id,
      interview_id: row.interview_id,
      interview_level: row.interview_level,
      area_of_interview: row.area_of_interview,
      overall_rating: formatRatingLabel(row.overall_rating) ?? row.overall_rating,
      strengths: row.strengths,
      improvement_areas: row.improvement_areas,
      overall_comments: row.overall_comments,
      final_outcome: row.final_outcome,
      candidate_code: row.candidate_code,
      candidate_name: row.candidate_name,
      req_code: row.req_code,
      job_title: row.job_title,
      interviewer_name: row.interviewer_name,
      round_type: row.round_type,
      interview_date: row.interview_date,
      interview_time: row.interview_time
    },
    details
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

async function syncLegacyFeedback(pool, interview, payload, user, req) {
  const scheduleId = interview.scheduleId || payload.schedule_id;
  const newStage = resolveStageFromOutcome(payload.interview_level, payload.final_outcome);

  if (isLegacyDualWriteEnabled()) {
    if (scheduleId && (await tableExists(pool, "interview_feedback_hdr"))) {
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
    }

    if (scheduleId && (await tableExists(pool, "interview_schedule_trn"))) {
      await pool.query(
        `UPDATE interview_schedule_trn
         SET feedback_submitted = true, interview_status = 'Completed', updated_on = NOW()
         WHERE schedule_id = $1`,
        [scheduleId]
      );
    }

    if (
      newStage
      && interview.mapId
      && (await tableExists(pool, "candidate_req_map"))
    ) {
      const legacyMap = await pool.query(
        "SELECT stage_name FROM candidate_req_map WHERE map_id = $1 LIMIT 1",
        [interview.mapId]
      );
      const legacyStageName = legacyMap.rows[0]?.stage_name || null;
      const interviewRoundType = payload.interview_level || interview.roundType;

      const legacySessions = await interviewRepeatStageService.listInterviewsForMap(
        pool,
        interview.mapId
      );
      const legacyAppliesRank = interviewRepeatStageService
        .shouldApplyPipelineStageFromInterviewFeedback(
          legacyStageName,
          interviewRoundType
        );
      const legacyIsCurrentDecision = interviewRepeatStageService
        .isInterviewCurrentStageDecision(
          legacySessions.find((row) => row.interview_id === interview.interviewId)
            || {
              interview_id: interview.interviewId,
              round_type: interviewRoundType,
              feedback_submitted: true,
              final_outcome: payload.final_outcome,
              interview_status: "Completed"
            },
          legacySessions
        );

      if (legacyAppliesRank && legacyIsCurrentDecision) {
        await pool.query(
          "UPDATE candidate_req_map SET stage_name = $1 WHERE map_id = $2",
          [newStage, interview.mapId]
        );
      }
    }
  }

  if (newStage && interview.mapId && isEnterpriseOperationalSor()) {
    const recruitmentService = require("./recruitmentService");
    const mappingStageResult = await pool.query(
      `SELECT stage_name
       FROM rm_candidate_mappings
       WHERE map_id = $1 AND is_active = true
       LIMIT 1`,
      [interview.mapId]
    );
    const mappingStageName = mappingStageResult.rows[0]?.stage_name || null;
    const interviewRoundType = payload.interview_level || interview.roundType;
    const allSessions = await interviewRepeatStageService.listInterviewsForMap(
      pool,
      interview.mapId
    );
    const shouldApplyPipeline = interviewRepeatStageService
      .shouldApplyPipelineStageFromInterviewFeedback(
        mappingStageName,
        interviewRoundType
      );
    const isCurrentStageDecision = interviewRepeatStageService
      .isInterviewCurrentStageDecision(
        allSessions.find((row) => row.interview_id === interview.interviewId)
          || {
            interview_id: interview.interviewId,
            round_type: interviewRoundType,
            feedback_submitted: true,
            final_outcome: payload.final_outcome,
            interview_status: "Completed",
            modified_on: new Date()
          },
        allSessions
      );

    if (shouldApplyPipeline && isCurrentStageDecision) {
      await recruitmentService.applyGovernedCandidateStageTransition(
        pool,
        interview.mapId,
        newStage,
        payload.overall_comments || "",
        req,
        {
          pipelineEventType: "InterviewOutcomeStage",
          skipIfUnchanged: true,
          useOperationalStageName: true,
          historyMetadata: {
            interviewId: interview.interviewId,
            scheduleId,
            interviewLevel: payload.interview_level,
            finalOutcome: payload.final_outcome,
            stageBucket: interviewRepeatStageService.resolveInterviewStageBucket(
              interviewRoundType
            )
          }
        }
      );
    } else {
      await writeEnterpriseAudit(pool, {
        eventType: "InterviewOutcomeStageSkipped",
        module: "Interview Management",
        entity: "Interview",
        entityId: interview.interviewId,
        action: !shouldApplyPipeline
          ? "Interview feedback recorded without pipeline regression on advanced stage"
          : "Interview feedback recorded without pipeline update for non-current stage decision",
        userName: user.name,
        userRole: user.role,
        metadata: {
          mappingStageName,
          interviewRoundType,
          resolvedOutcomeStage: newStage,
          finalOutcome: payload.final_outcome,
          shouldApplyPipeline,
          isCurrentStageDecision
        }
      });
    }
  }
}

async function reassignPanel(pool, interviewId, payload, req, txOptions = null) {
  const queryable = txOptions?.client || pool;
  const user = userContext(req);
  const row = await fetchInterviewRowByLookup(queryable, interviewId);

  if (!row) {
    throw httpError(`Interview not found: ${interviewId}`, 404);
  }

  await assertInterviewReadAccess(queryable, req, row);
  const interview = mapInterviewRow(row);
  const { panel_id: panelId, interviewer_name: interviewerName, interviewer_email: interviewerEmail } = payload;

  const ruleEval = await evaluateInterviewRules(queryable, {
    round_type: interview.roundType,
    action: "panel_reassignment"
  }, req);

  await queryable.query(
    `UPDATE im_panel_assignments SET assignment_status = 'Reassigned', modified_on = NOW()
     WHERE interview_id = $1 AND assignment_status IN ('Pending', 'Accepted')`,
    [interview.interviewId]
  );

  await queryable.query(
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

  await taskService.createTask(
    queryable,
    {
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
    },
    req,
    txOptions
  );

  await writeEnterpriseAudit(queryable, {
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
  const row = await fetchInterviewRowByLookup(pool, interviewId);

  if (!row) {
    throw httpError(`Interview not found: ${interviewId}`, 404);
  }

  await assertInterviewReadAccess(pool, req, row);
  const interview = mapInterviewRow(row);

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

async function getFeedbackDetailsBySchedule(pool, scheduleId, req) {
  const normalizedScheduleId = String(scheduleId || "").trim();

  if (!normalizedScheduleId) {
    throw httpError("schedule_id is required.", 400);
  }

  await assertInterviewFeedbackAccess(pool, req, { scheduleId: normalizedScheduleId });

  const result = await pool.query(
    `
    SELECT
      ist.schedule_id,
      ist.map_id,
      ist.round_type AS interview_level,
      cm.candidate_code,
      CONCAT(cm.first_name, ' ', cm.last_name) AS candidate_name,
      COALESCE(rr_by_id.req_id, rr_by_code.req_id, rm.req_id, ist.req_id) AS req_id,
      COALESCE(rr_by_id.requisition_code, rr_by_code.requisition_code, rm.req_code) AS req_code,
      COALESCE(rm.client_name, rr_by_id.department, rr_by_code.department) AS client_name,
      COALESCE(rr_by_id.position_title, rr_by_code.position_title, rm.job_title) AS job_title,
      ip.interviewer_name,
      ip.employee_code AS interviewer_code
    FROM interview_schedule_trn ist
    LEFT JOIN im_interviews i
      ON i.schedule_id = ist.schedule_id
    LEFT JOIN rm_candidate_mappings rcm
      ON rcm.map_id = ist.map_id
     AND rcm.is_active = true
    LEFT JOIN candidate_req_map crm
      ON crm.map_id = ist.map_id
    INNER JOIN cand_mstr cm
      ON cm.candidate_id = COALESCE(rcm.candidate_id, crm.candidate_id)
    LEFT JOIN rm_requisitions rr_by_id
      ON rr_by_id.req_id = COALESCE(i.req_id, rcm.req_id, ist.req_id)
    LEFT JOIN rm_requisitions rr_by_code
      ON rr_by_code.requisition_code = COALESCE(i.requisition_code, rcm.requisition_code)
    LEFT JOIN req_mstr rm
      ON rm.req_id = COALESCE(crm.req_id, ist.req_id)
    INNER JOIN interview_panel_mstr ip
      ON ip.panel_id = ist.interviewer_id
    WHERE ist.schedule_id = $1
    `,
    [normalizedScheduleId]
  );

  if (!result.rows.length) {
    throw httpError("Interview Schedule Not Found", 404);
  }

  return result.rows[0];
}

async function listInterviewFeedbackSummariesForMap(pool, mapId, req, options = {}) {
  const recruitmentService = require("./recruitmentService");
  await recruitmentService.assertAuthorizedMappingAccess(pool, req, mapId);

  const rows = await interviewFeedbackConfidentialityService.listInterviewRowsWithSchedulerForMap(
    pool,
    mapId
  );

  const recruiterSchedulerOnly =
    options.recruiterSchedulerOnly
    ?? (
      interviewFeedbackConfidentialityService.isRecruiterUser(req)
      && !isAdminUser(req)
    );

  return await interviewFeedbackConfidentialityService.buildFeedbackSummariesFromRows(
    rows,
    req,
    { recruiterSchedulerOnly, pool }
  );
}

async function getPermittedFeedbackHistoryForMap(pool, mapId, req, options = {}) {
  const recruitmentService = require("./recruitmentService");
  const anchorScheduleId = options.anchorScheduleId || null;

  if (
    interviewFeedbackConfidentialityService.isInterviewerUser(req)
    && !isAdminUser(req)
  ) {
    if (!anchorScheduleId) {
      throw httpError("anchor_schedule_id is required for interviewer feedback history.", 400);
    }

    await assertInterviewFeedbackAccess(pool, req, {
      scheduleId: anchorScheduleId
    });
  } else {
    await recruitmentService.assertAuthorizedMappingAccess(pool, req, mapId);
  }

  const rows = await interviewFeedbackConfidentialityService.listInterviewRowsWithSchedulerForMap(
    pool,
    mapId
  );

  const recruiterSchedulerOnly =
    interviewFeedbackConfidentialityService.isRecruiterUser(req)
    && !isAdminUser(req);

  const summaries = await interviewFeedbackConfidentialityService.buildFeedbackSummariesFromRows(
    rows,
    req,
    { recruiterSchedulerOnly, pool }
  );

  const currentScheduleId = anchorScheduleId
    ? String(anchorScheduleId)
    : null;

  return summaries
    .filter((row) => row.hasFeedbackRecord)
    .filter((row) => {
      if (!currentScheduleId) {
        return true;
      }

      return String(row.scheduleId) !== currentScheduleId;
    });
}

async function listRecruiterScheduledFeedbackHistory(pool, req) {
  if (
    !interviewFeedbackConfidentialityService.isRecruiterUser(req)
    && !isAdminUser(req)
  ) {
    throw httpError(
      "Enterprise Access Denied. You are not authorized to view recruiter scheduled feedback history.",
      403
    );
  }

  const employeeCode = String(req.user?.employee_code || "").trim();
  const user = userContext(req);

  if (!employeeCode && !user.name) {
    return [];
  }

  const result = await pool.query(
    `
    SELECT
      i.interview_id,
      i.schedule_id,
      i.map_id,
      i.round_no,
      i.round_type,
      i.interview_date,
      i.interview_time,
      i.interview_status,
      i.feedback_submitted,
      i.final_outcome,
      i.created_by,
      i.created_on,
      i.modified_on,
      ist.created_by AS schedule_created_by,
      f.feedback_id,
      f.final_outcome AS feedback_outcome,
      f.submitted_on,
      cm.candidate_code,
      CONCAT(cm.first_name, ' ', cm.last_name) AS candidate_name,
      COALESCE(rr.requisition_code, rm.req_code) AS req_code
    FROM im_interviews i
    INNER JOIN rm_candidate_mappings rcm
      ON rcm.map_id = i.map_id
     AND rcm.is_active = true
    INNER JOIN cand_mstr cm ON cm.candidate_id = rcm.candidate_id
    LEFT JOIN interview_schedule_trn ist ON ist.schedule_id = i.schedule_id
    LEFT JOIN rm_requisitions rr ON rr.req_id = i.req_id
    LEFT JOIN req_mstr rm ON rm.req_id = i.req_id
    LEFT JOIN LATERAL (
      SELECT feedback_id, final_outcome, submitted_on
      FROM im_feedback
      WHERE interview_id = i.interview_id
      ORDER BY feedback_id DESC
      LIMIT 1
    ) f ON TRUE
    WHERE f.feedback_id IS NOT NULL
      AND (
        $1::boolean = true
        OR (
          EXISTS (
            SELECT 1
            FROM rm_recruiter_assignments a
            WHERE a.is_active = true
              AND a.recruiter_code = $2
              AND (
                a.requisition_code = rcm.requisition_code
                OR a.req_id = i.req_id
              )
          )
          AND (
            i.created_by = $2
            OR i.created_by = $3
            OR ist.created_by = $2
          )
        )
      )
    ORDER BY f.submitted_on DESC NULLS LAST, i.created_on DESC
    `,
    [
      isAdminUser(req),
      employeeCode || null,
      user.name || null
    ]
  );

  const summaries = await interviewFeedbackConfidentialityService.buildFeedbackSummariesFromRows(
    result.rows,
    req,
    {
      recruiterSchedulerOnly: !isAdminUser(req),
      pool
    }
  );

  return summaries.map((row, index) => ({
    ...row,
    mapId: result.rows[index]?.map_id || null,
    candidateCode: result.rows[index]?.candidate_code || null,
    candidateName: result.rows[index]?.candidate_name || null,
    reqCode: result.rows[index]?.req_code || null
  }));
}

async function getInterviewProgressByMapId(pool, mapId, req) {
  const normalizedMapId = String(mapId || "").trim();

  if (!normalizedMapId) {
    throw httpError("map_id is required.", 400);
  }

  const recruitmentService = require("./recruitmentService");
  await recruitmentService.assertAuthorizedMappingAccess(pool, req, normalizedMapId);

  let mapping = null;

  const enterpriseMapping = await pool.query(
    `SELECT rcm.map_id, rcm.stage_name, rcm.candidate_id, rcm.requisition_code,
            cm.candidate_code,
            CONCAT(cm.first_name, ' ', cm.last_name) AS candidate_name
     FROM rm_candidate_mappings rcm
     LEFT JOIN cand_mstr cm ON cm.candidate_id = rcm.candidate_id
     WHERE rcm.map_id = $1
     LIMIT 1`,
    [normalizedMapId]
  );

  mapping = enterpriseMapping.rows[0] || null;

  if (!mapping && await tableExists(pool, "candidate_req_map")) {
    const legacyMapping = await pool.query(
      `SELECT crm.map_id, crm.stage_name, crm.candidate_id,
              cm.candidate_code,
              CONCAT(cm.first_name, ' ', cm.last_name) AS candidate_name,
              rm.req_code AS requisition_code
       FROM candidate_req_map crm
       LEFT JOIN cand_mstr cm ON cm.candidate_id = crm.candidate_id
       LEFT JOIN req_mstr rm ON rm.req_id = crm.req_id
       WHERE crm.map_id = $1
       LIMIT 1`,
      [normalizedMapId]
    );
    mapping = legacyMapping.rows[0] || null;
  }

  let interviewRows = [];

  const enterpriseInterviews = await pool.query(
    `SELECT
        i.interview_id,
        i.schedule_id,
        i.map_id,
        i.round_no,
        i.round_type,
        i.interview_date,
        i.interview_time,
        i.interview_status,
        i.feedback_submitted,
        i.final_outcome,
        i.remarks,
        i.modified_on,
        COALESCE(ipm.interviewer_name, ipm2.interviewer_name) AS interviewer_name,
        ipa.assignment_status
     FROM im_interviews i
     LEFT JOIN LATERAL (
       SELECT panel_id, assignment_status
       FROM im_panel_assignments
       WHERE interview_id = i.interview_id
       ORDER BY assigned_on DESC NULLS LAST
       LIMIT 1
     ) ipa ON true
     LEFT JOIN interview_panel_mstr ipm ON ipm.panel_id = ipa.panel_id
     LEFT JOIN interview_schedule_trn ist ON ist.schedule_id = i.schedule_id
     LEFT JOIN interview_panel_mstr ipm2 ON ipm2.panel_id = ist.interviewer_id
     WHERE i.map_id = $1
     ORDER BY COALESCE(i.round_no, 0) ASC,
              i.interview_date ASC NULLS LAST,
              i.interview_time ASC NULLS LAST`,
    [normalizedMapId]
  );

  interviewRows = enterpriseInterviews.rows;

  if (interviewRows.length === 0 && await tableExists(pool, "interview_schedule_trn")) {
    const legacyInterviews = await pool.query(
      `SELECT
          ist.schedule_id,
          ist.map_id,
          ist.round_no,
          ist.round_type,
          ist.interview_date,
          ist.interview_time,
          ist.interview_status,
          ist.feedback_submitted,
          ist.remarks,
          ist.updated_on AS modified_on,
          ipm.interviewer_name,
          NULL::varchar AS final_outcome,
          NULL::varchar AS assignment_status
       FROM interview_schedule_trn ist
       LEFT JOIN interview_panel_mstr ipm ON ipm.panel_id = ist.interviewer_id
       WHERE ist.map_id = $1
       ORDER BY COALESCE(ist.round_no, 0) ASC,
                ist.interview_date ASC NULLS LAST,
                ist.interview_time ASC NULLS LAST`,
      [normalizedMapId]
    );
    interviewRows = legacyInterviews.rows;
  }

  const rounds = interviewRows.map((row) => ({
    interviewId: row.interview_id || null,
    scheduleId: row.schedule_id,
    roundNo: row.round_no,
    roundType: row.round_type,
    interviewDate: row.interview_date,
    interviewTime: row.interview_time,
    interviewStatus: row.interview_status,
    feedbackSubmitted: Boolean(row.feedback_submitted),
    finalOutcome: row.final_outcome || null,
    interviewerName: row.interviewer_name || null,
    assignmentStatus: row.assignment_status || null,
    remarks: row.remarks || null,
    actionOn: row.modified_on || null,
    createdOn: row.created_on || null
  }));

  const stageGroups = await interviewRepeatStageService.buildInterviewProgressStageGroups(
    pool,
    normalizedMapId,
    rounds
  );

  const schedulerRows =
    await interviewFeedbackConfidentialityService.listInterviewRowsWithSchedulerForMap(
      pool,
      normalizedMapId
    );

  const recruiterSchedulerOnly =
    interviewFeedbackConfidentialityService.isRecruiterUser(req)
    && !isAdminUser(req);

  const filteredStageGroups =
    await interviewFeedbackConfidentialityService.filterStageGroupsForCaller(
      stageGroups,
      req,
      schedulerRows,
      { recruiterSchedulerOnly, pool }
    );

  const filteredRounds =
    await interviewFeedbackConfidentialityService.filterProgressRoundsForCaller(
      rounds,
      req,
      schedulerRows,
      { recruiterSchedulerOnly, pool }
    );

  const feedbackSummaries = await listInterviewFeedbackSummariesForMap(
    pool,
    normalizedMapId,
    req,
    { recruiterSchedulerOnly }
  );

  return {
    mapId: normalizedMapId,
    candidateCode: mapping?.candidate_code || null,
    candidateName: mapping?.candidate_name || null,
    requisitionCode: mapping?.requisition_code || null,
    currentStage: mapping?.stage_name || null,
    rounds: filteredRounds,
    stageGroups: filteredStageGroups,
    feedbackSummaries
  };
}

module.exports = {
  getDefaultSeedPayload,
  buildInterviewBundleSummary,
  getInterviewBundle,
  getFeedbackDetailsBySchedule,
  getInterviewProgressByMapId,
  listInterviewFeedbackSummariesForMap,
  getPermittedFeedbackHistoryForMap,
  listRecruiterScheduledFeedbackHistory,
  assertInterviewFeedbackReadAccess,
  getRepeatSchedulePrecheck: interviewRepeatStageService.getRepeatSchedulePrecheck,
  scheduleInterview,
  scheduleInterviewCanonical,
  linkLegacySchedule,
  getInterview,
  getInterviewForRequest,
  assertInterviewReadAccess,
  assertInterviewPanelActionAccess,
  acceptAssignment,
  rescheduleInterview,
  cancelInterview,
  cancelInterviewForOfferHold,
  completeInterview,
  assertInterviewScheduleMutateAccess,
  INTERVIEW_STATUS,
  assertInterviewMutableState,
  assertFutureInterviewSlot,
  submitFeedback,
  getFeedbackBySchedule,
  assertInterviewFeedbackAccess,
  reassignPanel,
  assignPanel,
  validateMasterDataReferences,
  evaluateInterviewRules,
  seedConfiguration
};
