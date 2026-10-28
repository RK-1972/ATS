const businessRulesService = require("./businessRulesService");
const workflowService = require("./workflowService");
const recruitmentService = require("./recruitmentService");
const taskService = require("./taskService");
const approvalRouteResolverService = require("./approvalRouteResolverService");
const approvalRouteRepository = require("../repositories/approvalRouteRepository");
const offerLetterService = require("./offerLetterService");
const { writeEnterpriseAudit, userContext } = require("./enterpriseAuditService");
const offerApprovalWorkflowService = require("./offerApprovalWorkflowService");
const {
  assertCanWriteOfferRecord,
  isTaLeadRole
} = require("./offerCapabilityAuth");
const {
  buildSubmissionVersionMetaPatch,
  MIRROR_VERSION_STATUS_PUBLISHED
} = offerApprovalWorkflowService;
const { assertStrictlyPositiveNumber, assertOptionalStrictlyPositiveNumber } = require("../utils/nonNegativeNumericValidation");

const SEED_PATH = require("path").join(__dirname, "..", "seed", "offers.seed.json");

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

function generateOfferId() {
  return `OFF-${new Date().getFullYear()}-${String(Date.now()).slice(-5)}`;
}

const PAY_FREQUENCY_VALUES = [
  "One Time",
  "Monthly",
  "Quarterly",
  "Half Yearly",
  "Yearly"
];

function normalizeCommercialFields(payload = {}) {
  const variablePay = Number(payload.variable_pay ?? payload.variablePay ?? 0);
  const joiningBonus = Number(payload.joining_bonus ?? payload.joiningBonus ?? 0);
  const expectedJoiningDate =
    payload.expected_joining_date || payload.expectedJoiningDate || null;

  return {
    expected_joining_date: expectedJoiningDate,
    variable_pay: Number.isFinite(variablePay) ? variablePay : 0,
    variable_pay_frequency:
      variablePay > 0
        ? payload.variable_pay_frequency || payload.variablePayFrequency || null
        : null,
    joining_bonus: Number.isFinite(joiningBonus) ? joiningBonus : 0,
    joining_bonus_frequency:
      joiningBonus > 0
        ? payload.joining_bonus_frequency || payload.joiningBonusFrequency || null
        : null
  };
}

function validateCommercialOfferFields(payload = {}) {
  const commercial = normalizeCommercialFields(payload);
  const errors = [];

  if (!commercial.expected_joining_date) {
    errors.push("Expected joining date is required.");
  } else {
    const selected = new Date(commercial.expected_joining_date);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    selected.setHours(0, 0, 0, 0);

    if (Number.isNaN(selected.getTime())) {
      errors.push("Expected joining date is invalid.");
    } else if (selected < today) {
      errors.push("Expected joining date cannot be earlier than today.");
    }
  }

  if (commercial.variable_pay < 0) {
    errors.push("Variable pay cannot be negative.");
  } else if (commercial.variable_pay > 0) {
    if (!commercial.variable_pay_frequency) {
      errors.push("Variable pay frequency is required when variable pay is greater than 0.");
    } else if (!PAY_FREQUENCY_VALUES.includes(commercial.variable_pay_frequency)) {
      errors.push("Variable pay frequency is invalid.");
    }
  }

  if (commercial.joining_bonus < 0) {
    errors.push("Joining bonus cannot be negative.");
  } else if (commercial.joining_bonus > 0) {
    if (!commercial.joining_bonus_frequency) {
      errors.push("Joining bonus frequency is required when joining bonus is greater than 0.");
    } else if (!PAY_FREQUENCY_VALUES.includes(commercial.joining_bonus_frequency)) {
      errors.push("Joining bonus frequency is invalid.");
    }
  }

  return errors;
}

function computeVariance(approvedBudget, offeredCtc) {
  const approved = Number(approvedBudget || 0);
  const offered = Number(offeredCtc || 0);
  const varianceAmount = offered - approved;
  const variancePct = approved > 0 ? Number(((varianceAmount / approved) * 100).toFixed(2)) : 0;
  return { varianceAmount, variancePct };
}

async function loadPlatformConfig(pool) {
  const result = await pool.query(
    "SELECT published_payload FROM pc_config_state WHERE id = 1"
  );
  return result.rows[0]?.published_payload || null;
}

async function assertOfferModuleEnabled(platformConfig) {
  const offerModule = platformConfig?.modules?.find((item) => item.key === "offer_management");
  if (platformConfig && offerModule && !offerModule.enabled) {
    throw httpError("Offer Management module is disabled in Platform Configuration.", 400);
  }
}

// business_unit and department inherit from rm_requisitions (client_mstr / project_mstr
// labels) and are not Enterprise Master fields — exclude from md_records validation.
const OFFER_MASTER_DATA_CHECKS = [
  { field: "grade", entityType: "grades" },
  {
    field: "location",
    entityType: "cities",
    alternateEntityTypes: ["work_locations"]
  },
  { field: "employment_type", entityType: "employment_types" },
  { field: "currency", entityType: "currencies" },
  { field: "template_code", entityType: "offer_templates" },
  { field: "salary_band_code", entityType: "salary_bands" }
];

async function validateMasterDataReferences(pool, data) {
  return recruitmentService.validateMasterDataFields(pool, data, OFFER_MASTER_DATA_CHECKS);
}

async function evaluateOfferRules(pool, context, req) {
  return businessRulesService.simulateRules(pool, context, req);
}

async function recordOfferHistory(pool, offerId, eventType, actor, actorRole, fromStatus, toStatus, comments, metadata) {
  await pool.query(
    `INSERT INTO om_offer_history (
      offer_id, event_type, from_status, to_status, actor, actor_role, comments, metadata
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      offerId,
      eventType,
      fromStatus || null,
      toStatus || null,
      actor,
      actorRole || null,
      comments || null,
      metadata ? JSON.stringify(metadata) : null
    ]
  );
}

async function saveRevision(pool, offerRow, reason, userName) {
  await pool.query(
    `INSERT INTO om_offer_revisions (offer_id, version, revision_status, payload, reason, revised_by)
     VALUES ($1,$2,'Published',$3,$4,$5)`,
    [
      offerRow.offer_id,
      offerRow.version,
      JSON.stringify(offerRow),
      reason || null,
      userName
    ]
  );
}

function mapOfferRow(row) {
  return {
    offerId: row.offer_id,
    approvedPositionId: row.approved_position_id,
    requisitionCode: row.requisition_code,
    candidateId: row.candidate_id,
    mappingId: row.mapping_id,
    interviewId: row.interview_id,
    recruiterId: row.recruiter_id,
    hiringManager: row.hiring_manager,
    candidateName: row.candidate_name,
    positionTitle: row.position_title,
    grade: row.grade,
    department: row.department,
    location: row.location,
    businessUnit: row.business_unit,
    employmentType: row.employment_type,
    approvedBudget: Number(row.approved_budget),
    offeredCtc: Number(row.offered_ctc),
    varianceAmount: Number(row.variance_amount),
    variancePct: Number(row.variance_pct),
    currency: row.currency,
    offerStatus: row.offer_status,
    workflowInstanceId: row.workflow_instance_id,
    validityDays: row.validity_days,
    validUntil: row.valid_until,
    version: Number(row.version),
    expectedJoiningDate: row.expected_joining_date,
    variablePay: Number(row.variable_pay ?? 0),
    variablePayFrequency: row.variable_pay_frequency || null,
    joiningBonus: Number(row.joining_bonus ?? 0),
    joiningBonusFrequency: row.joining_bonus_frequency || null,
    createdBy: row.created_by,
    modifiedBy: row.modified_by,
    createdOn: row.created_on,
    modifiedOn: row.modified_on
  };
}

function isAdminUser(req) {
  return String(req?.user?.role_name || "").trim() === "Admin";
}

function resolveOfferActorIdentity(req) {
  const employeeCode = String(req?.user?.employee_code || "").trim();
  const displayName = String(
    req?.user?.full_name || req?.user?.email_id || ""
  ).trim();
  return { employeeCode, displayName };
}

async function listScopedOfferRows(pool, req) {
  if (!req?.user) {
    throw httpError("Authentication required.", 401);
  }

  if (isAdminUser(req)) {
    const result = await pool.query("SELECT * FROM om_offers ORDER BY created_on DESC");
    return result.rows;
  }

  const { employeeCode, displayName } = resolveOfferActorIdentity(req);

  const result = await pool.query(
    `SELECT DISTINCT o.*
     FROM om_offers o
     LEFT JOIN rm_candidate_mappings m
       ON m.mapping_id = o.mapping_id
       OR m.map_id = o.mapping_id
     LEFT JOIN cand_mstr c
       ON c.candidate_id = COALESCE(o.candidate_id, m.candidate_id)
     WHERE (
       ($1 <> '' AND o.created_by = $1)
       OR ($1 <> '' AND o.recruiter_id = $1)
       OR ($2 <> '' AND o.recruiter_id = $2)
       OR ($2 <> '' AND o.created_by = $2)
       OR EXISTS (
         SELECT 1
         FROM rm_recruiter_assignments a
         WHERE a.recruiter_code = $2
           AND a.is_active = true
           AND a.requisition_code = o.requisition_code
       )
       OR ($2 <> '' AND c.owner_employee_code = $2)
     )
     ORDER BY o.created_on DESC`,
    [displayName, employeeCode]
  );

  return result.rows;
}

async function assertOfferReadAccess(pool, req, offerId) {
  if (!req?.user) {
    throw httpError("Authentication required.", 401);
  }

  if (isAdminUser(req) || isTaLeadRole(req)) {
    return;
  }

  const scopedRows = await listScopedOfferRows(pool, req);
  const allowed = scopedRows.some((row) => String(row.offer_id) === String(offerId));

  if (!allowed) {
    throw httpError(
      "Enterprise Access Denied. You are not authorized to access this offer.",
      403
    );
  }
}

async function resolvePendingApprovalTaskId(pool, workflowInstanceId, approvalStep) {
  const result = await pool.query(
    `SELECT t.task_id
     FROM wf_tasks t
     WHERE t.instance_id = $1
       AND LOWER(t.status) = 'pending'
       AND t.title = $2
     ORDER BY t.created_on ASC, t.task_id ASC
     LIMIT 1`,
    [workflowInstanceId, approvalStep]
  );

  return result.rows[0]?.task_id || null;
}

function parseWorkflowExecutionContext(raw) {
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

function buildOfferClarificationRounds(executionContext) {
  const rounds = [];
  const completed = Array.isArray(executionContext.clarification_history)
    ? executionContext.clarification_history
    : [];

  completed.forEach((entry, index) => {
    rounds.push({
      round: index + 1,
      requested_by: entry.requested_by || null,
      requested_by_role: entry.requested_by_role || null,
      requested_on: entry.requested_on || null,
      request_comments: entry.comments || null,
      responded_by: entry.submitted_by || null,
      responded_by_role: entry.submitted_by_role || null,
      responded_on: entry.submitted_on || null,
      response_comments: entry.response_comments || null,
      pending: false
    });
  });

  const current = executionContext.clarification;
  if (current && String(current.status || "").toLowerCase() === "requested") {
    rounds.push({
      round: rounds.length + 1,
      requested_by: current.requested_by || null,
      requested_by_role: current.requested_by_role || null,
      requested_on: current.requested_on || null,
      request_comments: current.comments || null,
      responded_by: null,
      responded_on: null,
      response_comments: null,
      pending: true
    });
  }

  return rounds;
}

async function buildOfferClarificationFields(queryable, instanceRow, req = null) {
  const emptyFields = {
    clarificationRounds: [],
    clarificationPending: null,
    clarificationHeldApprovalTaskId: null,
    workflowPausedForClarification: false,
    canRejectDuringClarification: false
  };

  if (!instanceRow) {
    return emptyFields;
  }

  const executionContext = parseWorkflowExecutionContext(instanceRow.execution_context);
  const clarificationRounds = buildOfferClarificationRounds(executionContext);
  const pendingRound = clarificationRounds.find((item) => item.pending);

  const hold = executionContext.clarification || null;
  const isPausedWithHold =
    String(instanceRow.status || "") === "Paused" && Boolean(hold?.task_id);

  let canRejectDuringClarification = false;

  if (
    isPausedWithHold
    && hold?.assignment_id
    && req?.user?.employee_code
    && queryable
  ) {
    const assignmentResult = await queryable.query(
      `SELECT assignee
       FROM wf_assignments
       WHERE assignment_id = $1
         AND task_id = $2
       LIMIT 1`,
      [Number(hold.assignment_id), Number(hold.task_id)]
    );
    const heldAssignee = String(assignmentResult.rows[0]?.assignee || "").trim();
    const actorCode = String(req.user.employee_code || "").trim();
    canRejectDuringClarification = Boolean(
      heldAssignee && actorCode && heldAssignee === actorCode
    );
  }

  return {
    clarificationRounds,
    clarificationPending: pendingRound
      ? {
          ...pendingRound,
          request_comments: pendingRound.request_comments
        }
      : null,
    clarificationHeldApprovalTaskId: isPausedWithHold ? Number(hold.task_id) : null,
    workflowPausedForClarification:
      String(instanceRow.status || "") === "Paused" && Boolean(pendingRound),
    canRejectDuringClarification
  };
}

async function resolveActiveOfferApprovalTaskId(queryable, workflowInstanceId, req) {
  const result = await queryable.query(
    `SELECT t.task_id
     FROM wf_tasks t
     INNER JOIN wf_assignments a ON a.task_id = t.task_id AND a.active = TRUE
     WHERE t.instance_id = $1
       AND LOWER(TRIM(t.status)) = 'pending'
       AND LOWER(TRIM(COALESCE(t.task_type, 'approval'))) IN ('approval', 'approve')
     ORDER BY t.task_id ASC
     LIMIT 1`,
    [workflowInstanceId]
  );

  const taskId = result.rows[0]?.task_id;
  if (!taskId) {
    throw httpError("No active pending approval task found for this offer.", 404);
  }

  await workflowService.assertActiveAssignee(queryable, taskId, req);
  return taskId;
}

async function getOffer(pool, offerId, req = null) {
  const result = await pool.query("SELECT * FROM om_offers WHERE offer_id = $1", [offerId]);
  if (!result.rows.length) {
    throw httpError(`Offer not found: ${offerId}`, 404);
  }

  if (req?.user) {
    await assertOfferReadAccess(pool, req, offerId);
  }

  const row = result.rows[0];
  let clarificationFields = {
    clarificationRounds: [],
    clarificationPending: null,
    clarificationHeldApprovalTaskId: null,
    workflowPausedForClarification: false,
    canRejectDuringClarification: false
  };

  if (row.workflow_instance_id) {
    const instanceResult = await pool.query(
      `SELECT status, execution_context
       FROM wf_instances
       WHERE instance_id = $1`,
      [row.workflow_instance_id]
    );
    clarificationFields = await buildOfferClarificationFields(
      pool,
      instanceResult.rows[0],
      req
    );
  }

  return {
    ...mapOfferRow(row),
    ...clarificationFields
  };
}

async function getOfferRowForApprovalResponse(pool, offerId) {
  const result = await pool.query("SELECT * FROM om_offers WHERE offer_id = $1", [offerId]);
  if (!result.rows.length) {
    throw httpError(`Offer not found: ${offerId}`, 404);
  }

  return mapOfferRow(result.rows[0]);
}

async function loadRecruitmentContext(pool, payload) {
  const context = { ...payload };

  if (payload.requisition_code) {
    const reqResult = await pool.query(
      "SELECT * FROM rm_requisitions WHERE requisition_code = $1",
      [payload.requisition_code]
    );
    const req = reqResult.rows[0];
    if (req) {
      context.approved_position_id = context.approved_position_id || req.approved_position_id;
      context.position_title = context.position_title || req.position_title;
      context.grade = context.grade || req.grade;
      context.department = context.department || req.department;
      context.location = context.location || req.location;
      context.business_unit = context.business_unit || req.business_unit;
      context.employment_type = context.employment_type || req.employment_type;
      context.approved_budget = context.approved_budget ?? Number(req.budget_approved);
      context.hiring_manager = context.hiring_manager || req.hiring_manager;
    }
  }

  if (payload.approved_position_id && !context.approved_budget) {
    const posResult = await pool.query(
      "SELECT * FROM wp_approved_positions WHERE position_id = $1",
      [payload.approved_position_id]
    );
    const pos = posResult.rows[0];
    if (pos) {
      context.approved_budget = Number(pos.budget_approved);
      context.position_title = context.position_title || pos.position_title;
      context.grade = context.grade || pos.grade;
      context.department = context.department || pos.department;
    }
  }

  if (payload.mapping_id) {
    const mapResult = await pool.query(
      "SELECT * FROM rm_candidate_mappings WHERE mapping_id = $1 OR map_id = $1",
      [payload.mapping_id]
    );
    const mapping = mapResult.rows[0];
    if (mapping) {
      context.candidate_id = context.candidate_id || mapping.candidate_id;
      context.requisition_code = context.requisition_code || mapping.requisition_code;
    }
  }

  return context;
}

async function getOfferBundle(pool, req) {
  const offerRows = await listScopedOfferRows(pool, req);
  const offerIds = offerRows.map((row) => row.offer_id);

  let approvals = { rows: [] };
  let negotiations = { rows: [] };

  if (offerIds.length) {
    approvals = await pool.query(
      `SELECT *
       FROM om_offer_approvals
       WHERE offer_id = ANY($1::varchar[])
       ORDER BY sequence_order ASC`,
      [offerIds]
    );
    negotiations = await pool.query(
      `SELECT *
       FROM om_offer_negotiations
       WHERE offer_id = ANY($1::varchar[])
       ORDER BY created_on DESC`,
      [offerIds]
    );
  }

  const instanceIds = offerRows
    .filter((row) => row.workflow_instance_id)
    .map((row) => row.workflow_instance_id);
  const instanceMap = new Map();

  if (instanceIds.length) {
    const instances = await pool.query(
      `SELECT instance_id, status, execution_context
       FROM wf_instances
       WHERE instance_id = ANY($1::varchar[])`,
      [instanceIds]
    );
    instances.rows.forEach((instanceRow) => {
      instanceMap.set(instanceRow.instance_id, instanceRow);
    });
  }

  const offers = await Promise.all(
    offerRows.map(async (row) => ({
      ...mapOfferRow(row),
      ...(await buildOfferClarificationFields(
        pool,
        row.workflow_instance_id ? instanceMap.get(row.workflow_instance_id) : null,
        req
      ))
    }))
  );

  return {
    offers,
    approvals: approvals.rows,
    negotiations: negotiations.rows,
    summary: {
      draft: offerRows.filter((row) => row.offer_status === "Draft").length,
      pendingApproval: offerRows.filter((row) => /pending/i.test(row.offer_status)).length,
      released: offerRows.filter((row) => row.offer_status === "Released").length,
      accepted: offerRows.filter((row) => row.offer_status === "Accepted").length
    }
  };
}

async function createOffer(pool, payload, req) {
  const user = userContext(req);
  const platformConfig = await loadPlatformConfig(pool);
  await assertOfferModuleEnabled(platformConfig);

  const context = await loadRecruitmentContext(pool, payload);

  if (!context.requisition_code && !context.approved_position_id) {
    throw httpError("Offer must link to an approved position or requisition.", 400);
  }

  if (!context.candidate_id && !context.mapping_id) {
    throw httpError("Offer must link to a candidate mapping.", 400);
  }

  if (context.requisition_code) {
    const requisitionResult = await pool.query(
      `SELECT requisition_code, req_status
       FROM rm_requisitions
       WHERE requisition_code = $1`,
      [context.requisition_code]
    );
    const requisition = requisitionResult.rows[0];

    if (!requisition) {
      throw httpError(`Requisition not found: ${context.requisition_code}`, 404);
    }

    const { assertRequisitionOpenForRecruiting } = require("./requisitionFulfillmentService");
    assertRequisitionOpenForRecruiting(requisition);
  }

  const mappingRef =
    payload.mapping_id ?? payload.map_id ?? context.mapping_id ?? context.map_id;
  if (mappingRef) {
    const mappingAccess = await recruitmentService.resolveMappingContextForOfferRaise(
      pool,
      mappingRef
    );
    const offerRaiseEligibilityService = require("./offerRaiseEligibilityService");
    await offerRaiseEligibilityService.assertMappingEligibleForOfferRaise(
      pool,
      mappingAccess.mapping,
      mappingAccess.legacyRow
    );
  } else {
    throw httpError("Offer must link to a candidate mapping.", 400);
  }

  const offeredCtc = assertStrictlyPositiveNumber(
    context.offered_ctc || context.total_ctc,
    "Offered CTC"
  );

  const commercialErrors = validateCommercialOfferFields(context);
  if (commercialErrors.length) {
    throw httpError(commercialErrors.join(" "), 400);
  }

  const commercial = normalizeCommercialFields(context);

  const mdValidation = await validateMasterDataReferences(pool, {
    grade: context.grade,
    location: context.location,
    employment_type: context.employment_type || "Full-time",
    currency: context.currency || "INR"
  });

  if (!mdValidation.valid) {
    throw httpError(mdValidation.errors.join(" "), 400);
  }

  const approvedBudget = Number(context.approved_budget || 0);
  const { varianceAmount, variancePct } = computeVariance(approvedBudget, offeredCtc);
  const validityDays = platformConfig?.modules?.find((item) => item.key === "offer_management")
    ?.settings?.default_validity_days || 7;

  const ruleEval = await evaluateOfferRules(pool, {
    offered_salary_lpa: offeredCtc / 100000,
    approved_budget_lpa: approvedBudget / 100000,
    grade: context.grade,
    department: context.department,
    location: context.location,
    action: "create_offer"
  }, req);

  const offerId = context.offer_id || generateOfferId();
  const instance = await workflowService.startWorkflow(
    pool,
    "OFFER",
    {
      instance_id: `WF-OFF-${offerId}`,
      meta: {
        offer_id: offerId,
        requisition_code: context.requisition_code,
        candidate_id: context.candidate_id,
        offered_ctc_lpa: offeredCtc / 100000
      },
      department: context.department,
      grade: context.grade
    },
    req
  );

  const validUntil = new Date();
  validUntil.setDate(validUntil.getDate() + validityDays);

  await pool.query(
    `INSERT INTO om_offers (
      offer_id, approved_position_id, requisition_code, candidate_id, mapping_id, interview_id,
      recruiter_id, hiring_manager, candidate_name, position_title, grade, department, location,
      business_unit, employment_type, approved_budget, offered_ctc, variance_amount, variance_pct,
      currency, offer_status, workflow_instance_id, validity_days, valid_until,
      expected_joining_date, variable_pay, variable_pay_frequency, joining_bonus, joining_bonus_frequency,
      created_by, modified_by, effective_from
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32)`,
    [
      offerId,
      context.approved_position_id || null,
      context.requisition_code || null,
      context.candidate_id || null,
      context.mapping_id || null,
      context.interview_id || null,
      context.recruiter_id || user.name,
      context.hiring_manager || null,
      context.candidate_name || null,
      context.position_title || null,
      context.grade || null,
      context.department || null,
      context.location || null,
      context.business_unit || null,
      context.employment_type || "Full-time",
      approvedBudget,
      offeredCtc,
      varianceAmount,
      variancePct,
      context.currency || "INR",
      "Draft",
      instance.instanceId,
      validityDays,
      validUntil,
      commercial.expected_joining_date,
      commercial.variable_pay,
      commercial.variable_pay_frequency,
      commercial.joining_bonus,
      commercial.joining_bonus_frequency,
      user.name,
      user.name,
      new Date()
    ]
  );

  await pool.query(
    `INSERT INTO om_offer_compensation (
      offer_id, base_salary, variable_pay, bonus, benefits, total_ctc, currency, salary_band_code, effective_from
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      offerId,
      Number(context.base_salary || context.compensation?.base_salary || offeredCtc * 0.8),
      Number(context.compensation?.variable_pay || offeredCtc * 0.15),
      Number(context.compensation?.bonus || context.bonus || offeredCtc * 0.05),
      Number(context.benefits || 0),
      offeredCtc,
      context.currency || "INR",
      context.salary_band_code || null,
      new Date()
    ]
  );

  await pool.query(
    `INSERT INTO om_offer_acceptance (offer_id, response_status, effective_from)
     VALUES ($1,'Pending',$2)`,
    [offerId, new Date()]
  );

  await taskService.createTask(pool, {
    module: "Offer Management",
    taskType: "Prepare Offer",
    title: `Prepare offer for ${context.candidate_name || context.candidate_id}`,
    assigneeRole: "Recruiter",
    workflowInstanceId: instance.instanceId,
    stageKey: "draft",
    businessObjectType: "Offer",
    businessObjectId: offerId,
    metadata: { offeredCtc, variancePct }
  }, req);

  await recordOfferHistory(pool, offerId, "OfferCreated", user.name, user.role, null, "Draft");
  await writeEnterpriseAudit(pool, {
    eventType: "OfferCreated",
    module: "Offer Management",
    entity: "Offer",
    entityId: offerId,
    action: `Offer draft created at ${offeredCtc}`,
    userName: user.name,
    userRole: user.role,
    metadata: { ruleEvaluation: ruleEval, variancePct }
  });

  return {
    offer: await getOffer(pool, offerId),
    ruleEvaluation: ruleEval,
    toastMessage: "Offer draft created."
  };
}

/**
 * Mirror Budget submit: stamp workflow execution_context then expand approval route
 * into wf_tasks + wf_assignments via the shared Workflow Engine helper.
 */
async function publishOfferWorkflowAssignments(pool, offer, req, approvalRouteId) {
  if (!offer.workflowInstanceId) {
    throw httpError("Offer workflow instance is missing.", 400);
  }

  const instance = await workflowService.getInstanceById(pool, offer.workflowInstanceId);
  if (!instance) {
    throw httpError(`Workflow instance not found: ${offer.workflowInstanceId}`, 404);
  }

  const rawContext = instance.executionContext;
  const context =
    rawContext && typeof rawContext === "object"
      ? rawContext
      : typeof rawContext === "string"
        ? (() => {
            try {
              return JSON.parse(rawContext);
            } catch {
              return {};
            }
          })()
        : {};
  const meta = context.meta && typeof context.meta === "object" ? context.meta : {};

  const nextContext = {
    ...context,
    meta: {
      ...meta,
      process_id: offer.workflowInstanceId,
      document_type: "OFFER",
      offer_id: offer.offerId,
      requisition_id: offer.requisitionCode || offer.offerId,
      department: offer.department,
      position_title: offer.positionTitle,
      grade: offer.grade,
      approval_route_id: approvalRouteId,
      offered_ctc_lpa: Number(offer.offeredCtc || 0) / 100000,
      ...buildSubmissionVersionMetaPatch(offer.version)
    },
    department: offer.department,
    grade: offer.grade,
    approval_route_id: approvalRouteId
  };

  await pool.query(
    `UPDATE wf_instances
     SET execution_context = $1, modified_on = NOW()
     WHERE instance_id = $2`,
    [JSON.stringify(nextContext), offer.workflowInstanceId]
  );

  const assignedBy = req.user?.employee_code || userContext(req).name;

  return workflowService.createApprovalRouteWorkflowTasks(
    pool,
    offer.workflowInstanceId,
    approvalRouteId,
    {
      stageKey: "approval",
      assignedBy,
      requisitionCode: offer.offerId
    }
  );
}

/** Replace Offer workspace approval rows with route-expanded step titles. */
async function syncOfferApprovalsFromRoute(pool, offerId, approvalRouteId, submissionVersion) {
  await pool.query("DELETE FROM om_offer_approvals WHERE offer_id = $1", [offerId]);

  const versionRow = await pool.query(
    `SELECT version FROM om_offers WHERE offer_id = $1`,
    [offerId]
  );
  const version = Number(
    submissionVersion ?? versionRow.rows[0]?.version ?? 1
  );

  const steps = await approvalRouteRepository.getApprovalRouteSteps(
    pool,
    approvalRouteId
  );

  if (!steps.length) {
    throw httpError("Approval route has no steps to publish.", 400);
  }

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    const sequence = step.sequence_no ?? step.step_no ?? index + 1;
    const stepTitle = `Approval Step ${sequence} — ${offerId}`;

    await pool.query(
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
        version,
        MIRROR_VERSION_STATUS_PUBLISHED,
        new Date()
      ]
    );
  }
}

async function submitOffer(pool, offerId, comment, req) {
  const user = userContext(req);
  const platformConfig = await loadPlatformConfig(pool);
  await assertOfferModuleEnabled(platformConfig);

  const offer = await getOffer(pool, offerId, req);
  if (offer.offerStatus !== "Draft") {
    throw httpError("Only draft offers can be submitted.", 400);
  }

  if (!offer.workflowInstanceId) {
    throw httpError("Offer workflow instance is missing.", 400);
  }

  const ruleEval = await evaluateOfferRules(pool, {
    offered_salary_lpa: offer.offeredCtc / 100000,
    approved_budget_lpa: offer.approvedBudget / 100000,
    grade: offer.grade,
    department: offer.department,
    location: offer.location,
    action: "submit_offer"
  }, req);

  const approvalRouteId = await approvalRouteResolverService.resolveApprovalRoute(
    pool,
    "OFFER",
    {
      department: offer.department,
      designation: offer.positionTitle,
      grade: offer.grade,
      amount: offer.offeredCtc
    }
  );

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await workflowService.advanceWorkflow(
      client,
      offer.workflowInstanceId,
      "approve",
      { stageKey: "draft", actor: user.name, comment },
      req
    );

    const threshold = platformConfig?.budget?.max_budget_variance_pct ?? 10;
    if (offer.variancePct > threshold) {
      await writeEnterpriseAudit(client, {
        eventType: "BudgetExceptionTriggered",
        module: "Offer Management",
        entity: "Offer",
        entityId: offerId,
        action: `Budget variance ${offer.variancePct}% exceeds ${threshold}%`,
        userName: user.name,
        userRole: user.role,
        metadata: { ruleEvaluation: ruleEval }
      });
    }

    const approvalTasks = await publishOfferWorkflowAssignments(
      client,
      offer,
      req,
      approvalRouteId
    );

    if (!Array.isArray(approvalTasks) || approvalTasks.length === 0) {
      throw httpError(
        "Offer approval route did not publish any workflow assignments.",
        500
      );
    }

    const assignmentCheck = await client.query(
      `SELECT COUNT(*) AS count
       FROM wf_assignments a
       INNER JOIN wf_tasks t ON t.task_id = a.task_id
       WHERE t.instance_id = $1
         AND t.task_type = 'approval'
         AND t.title LIKE 'Approval Step %'
         AND a.active = TRUE`,
      [offer.workflowInstanceId]
    );

    if (Number(assignmentCheck.rows[0]?.count || 0) === 0) {
      throw httpError(
        "Offer submit did not create an active workflow assignment for Approver 1.",
        500
      );
    }

    await syncOfferApprovalsFromRoute(client, offerId, approvalRouteId);

    await client.query(
      `UPDATE om_offers SET offer_status = 'Pending Approval', modified_by = $1, modified_on = NOW()
       WHERE offer_id = $2`,
      [user.name, offerId]
    );

    await recordOfferHistory(
      client,
      offerId,
      "OfferSubmitted",
      user.name,
      user.role,
      "Draft",
      "Pending Approval",
      comment
    );

    await writeEnterpriseAudit(client, {
      eventType: "OfferSubmitted",
      module: "Offer Management",
      entity: "Offer",
      entityId: offerId,
      action: "Offer submitted for approval",
      userName: user.name,
      userRole: user.role,
      metadata: { ruleEvaluation: ruleEval, approvalRouteId, approvalTasks }
    });

    await client.query("COMMIT");

    return {
      offer: await getOffer(pool, offerId),
      ruleEvaluation: ruleEval,
      toastMessage: "Offer submitted for approval."
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function approveOffer(pool, offerId, approvalStep, comment, req) {
  const user = userContext(req);

  const offerApprovalWorkflowService = require("./offerApprovalWorkflowService");
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const { offerRow } = await offerApprovalWorkflowService.assertOfferApprovalMayProceed(
      client,
      offerId
    );
    const workflowInstanceId = offerRow.workflow_instance_id;

    const taskId = await resolvePendingApprovalTaskId(
      client,
      workflowInstanceId,
      approvalStep
    );

    if (!taskId) {
      throw httpError(`Pending approval task not found for step: ${approvalStep}`, 404);
    }

    await workflowService.assertActiveAssignee(client, taskId, req);

    const approvalResult = await client.query(
      `UPDATE om_offer_approvals
       SET approval_status = 'Approved', approver_name = $1, approved_on = NOW(), comments = $2
       WHERE offer_id = $3
         AND approval_step = $4
         AND approval_status = 'Pending'
         AND version_status = $5
         AND version = $6
       RETURNING *`,
      [
        user.name,
        comment || null,
        offerId,
        approvalStep,
        MIRROR_VERSION_STATUS_PUBLISHED,
        Number(offerRow.version)
      ]
    );

    if (!approvalResult.rows.length) {
      throw httpError(`Pending approval step not found: ${approvalStep}`, 404);
    }

    const routeCompletion = await workflowService.completeTask(client, taskId, req, {
      comments: comment,
      requireActiveAssignee: false
    });
    const workflowRouteCompleted = Boolean(routeCompletion?.workflowCompleted);

    const stageKey = approvalStep.toLowerCase().includes("finance")
      ? "finance"
      : approvalStep.toLowerCase().includes("leadership")
        ? "hm_review"
        : "hm_review";

    await workflowService.advanceWorkflow(
      client,
      workflowInstanceId,
      "approve",
      { stageKey, actor: user.name, comment },
      req
    );

    const pending = await client.query(
      `SELECT COUNT(*) AS count FROM om_offer_approvals
       WHERE offer_id = $1
         AND approval_status IN ('Pending', 'Waiting')
         AND version_status = $2
         AND version = $3`,
      [offerId, MIRROR_VERSION_STATUS_PUBLISHED, Number(offerRow.version)]
    );

    const eventType = /finance/i.test(approvalStep)
      ? "FinanceApproved"
      : /leadership/i.test(approvalStep)
        ? "LeadershipApproved"
        : "StageApproved";

    if (Number(pending.rows[0].count) === 0 && !workflowRouteCompleted) {
      await client.query(
        `UPDATE om_offers SET offer_status = 'Approved', modified_by = $1, modified_on = NOW()
         WHERE offer_id = $2`,
        [user.name, offerId]
      );

      await offerLetterService.ensureAwaitingLetterForOffer(client, offerId);

      await workflowService.advanceWorkflow(
        client,
        workflowInstanceId,
        "approve",
        { stageKey: "approved", actor: user.name, comment: "All approvals complete" },
        req
      );
    }

    const linkedInboxTasks = await client.query(
      `SELECT task_id
       FROM et_tasks
       WHERE module = 'Offer Management'
         AND business_object_id = $1
         AND status <> 'Completed'
         AND (task_type = $2 OR workflow_task_id = $3)`,
      [offerId, approvalStep, taskId]
    );

    for (const row of linkedInboxTasks.rows) {
      await taskService.completeTask(client, row.task_id, req, comment, {
        skipIfWorkflowTaskAlreadyCompleted: true
      });
    }

    await writeEnterpriseAudit(client, {
      eventType,
      module: "Offer Management",
      entity: "Offer",
      entityId: offerId,
      action: `${approvalStep} approved`,
      userName: user.name,
      userRole: user.role,
      metadata: { comment }
    });

    await client.query("COMMIT");

    return {
      offer: await getOfferRowForApprovalResponse(pool, offerId),
      toastMessage: `${approvalStep} approved.`
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

async function negotiateOffer(pool, offerId, payload, req) {
  const user = userContext(req);
  const offer = await getOffer(pool, offerId, req);

  const proposedCtc = assertStrictlyPositiveNumber(
    payload.proposed_ctc ?? offer.offeredCtc,
    "Proposed CTC"
  );

  const counterCtc = assertOptionalStrictlyPositiveNumber(
    payload.counter_ctc,
    "Counter CTC"
  );

  const ruleEval = await evaluateOfferRules(pool, {
    offered_salary_lpa: proposedCtc / 100000,
    approved_budget_lpa: offer.approvedBudget / 100000,
    grade: offer.grade,
    action: "negotiate_offer"
  }, req);

  const roundResult = await pool.query(
    "SELECT COUNT(*) AS count FROM om_offer_negotiations WHERE offer_id = $1",
    [offerId]
  );
  const roundNo = Number(roundResult.rows[0].count) + 1;

  await pool.query(
    `INSERT INTO om_offer_negotiations (
      offer_id, round_no, proposed_ctc, counter_ctc, negotiation_status, initiated_by, notes, effective_from
    ) VALUES ($1,$2,$3,$4,'Open',$5,$6,$7)`,
    [
      offerId,
      roundNo,
      proposedCtc,
      counterCtc,
      user.name,
      payload.notes || null,
      new Date()
    ]
  );

  await taskService.createTask(pool, {
    module: "Offer Management",
    taskType: "Review Negotiation",
    title: `Review negotiation round ${roundNo} for ${offerId}`,
    assigneeRole: "TA Leader",
    businessObjectType: "Offer",
    businessObjectId: offerId,
    metadata: { roundNo, ruleEvaluation: ruleEval }
  }, req);

  await recordOfferHistory(pool, offerId, "OfferNegotiated", user.name, user.role, offer.offerStatus, offer.offerStatus, payload.notes);

  return {
    offer,
    roundNo,
    ruleEvaluation: ruleEval,
    toastMessage: "Negotiation recorded."
  };
}

async function reviseOffer(pool, offerId, payload, req) {
  const user = userContext(req);
  await assertOfferReadAccess(pool, req, offerId);
  const row = (await pool.query("SELECT * FROM om_offers WHERE offer_id = $1", [offerId])).rows[0];
  if (!row) {
    throw httpError(`Offer not found: ${offerId}`, 404);
  }

  const blockedStatuses = new Set(["Pending Approval", "Approved", "Withdrawn"]);
  if (blockedStatuses.has(String(row.offer_status))) {
    throw httpError(
      `Offer cannot be revised in status ${row.offer_status}. Use pending-approval correction or post-release workflows.`,
      409
    );
  }

  await saveRevision(pool, row, payload.reason, user.name);

  const offeredCtc = assertStrictlyPositiveNumber(
    payload.offered_ctc ?? row.offered_ctc,
    "Offered CTC"
  );
  const { varianceAmount, variancePct } = computeVariance(row.approved_budget, offeredCtc);
  const nextVersion = Number((Number(row.version) + 0.1).toFixed(1));

  await pool.query(
    `UPDATE om_offers
     SET offered_ctc = $1, variance_amount = $2, variance_pct = $3, version = $4,
         modified_by = $5, modified_on = NOW()
     WHERE offer_id = $6`,
    [offeredCtc, varianceAmount, variancePct, nextVersion, user.name, offerId]
  );

  await pool.query(
    `UPDATE om_offer_compensation SET total_ctc = $1, modified_on = NOW() WHERE offer_id = $2`,
    [offeredCtc, offerId]
  );

  await recordOfferHistory(pool, offerId, "OfferRevised", user.name, user.role, row.offer_status, row.offer_status, payload.reason);

  return {
    offer: await getOffer(pool, offerId),
    toastMessage: "Offer revised."
  };
}

async function releaseOffer(pool, offerId, payload, req) {
  const user = userContext(req);
  await getOffer(pool, offerId, req);

  const candidateOfferHoldService = require("./candidateOfferHoldService");
  let activatedHold = null;

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await offerApprovalWorkflowService.assertCurrentSubmissionFullyApproved(client, offerId);

    const offerLock = await client.query(
      `SELECT *
       FROM om_offers
       WHERE offer_id = $1
       FOR UPDATE`,
      [offerId]
    );

    if (!offerLock.rows[0]) {
      throw httpError(`Offer not found: ${offerId}`, 404);
    }

    const lockedOffer = offerLock.rows[0];
    const workflowInstanceId = lockedOffer.workflow_instance_id;

    if (workflowInstanceId) {
      await workflowService.advanceWorkflow(
        client,
        workflowInstanceId,
        "approve",
        { stageKey: "released", actor: user.name, comment: payload.comment || "" },
        req
      );
    }

    await client.query(
      `UPDATE om_offers SET offer_status = 'Released', modified_by = $1, modified_on = NOW()
       WHERE offer_id = $2`,
      [user.name, offerId]
    );

    const holdResult = await candidateOfferHoldService.activateHoldOnOfferRelease(
      client,
      lockedOffer,
      req
    );
    activatedHold = holdResult.hold;

    await client.query("COMMIT");
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

  let holdActivationSummary = null;

  if (activatedHold) {
    holdActivationSummary = await candidateOfferHoldService.runHoldActivationSideEffects(
      pool,
      activatedHold,
      req
    );

    await writeEnterpriseAudit(pool, {
      eventType: "OfferHoldActivated",
      module: "Recruitment Management",
      entity: "Candidate",
      entityId: String(activatedHold.candidate_id),
      action: "Offer Hold activated on offer release",
      userName: user.name,
      userRole: user.role,
      metadata: {
        offer_id: offerId,
        hold_id: activatedHold.hold_id,
        side_effects: holdActivationSummary
      }
    });
  }

  const offer = await getOffer(pool, offerId, req);

  if (payload.template_code) {
    await pool.query(
      `INSERT INTO om_offer_documents (
        offer_id, template_code, document_type, document_status, content_ref, generated_by, effective_from
      ) VALUES ($1,$2,'Offer Letter','Generated',$3,$4,$5)`,
      [
        offerId,
        payload.template_code,
        payload.content_ref || `offer-letter-${offerId}`,
        user.name,
        new Date()
      ]
    );
  }

  await taskService.createTask(pool, {
    module: "Offer Management",
    taskType: "Follow-up Acceptance",
    title: `Follow up offer acceptance for ${offerId}`,
    assigneeRole: "Recruiter",
    slaHours: 48,
    businessObjectType: "Offer",
    businessObjectId: offerId
  }, req);

  const releaseTasks = (await taskService.listInbox(pool, { module: "Offer Management" }))
    .filter((item) => item.businessObjectId === offerId && item.taskType === "Release Offer");
  for (const task of releaseTasks) {
    await taskService.completeTask(pool, task.taskId, req);
  }

  await recordOfferHistory(pool, offerId, "OfferReleased", user.name, user.role, "Approved", "Released");
  await writeEnterpriseAudit(pool, {
    eventType: "OfferReleased",
    module: "Offer Management",
    entity: "Offer",
    entityId: offerId,
    action: "Offer released to candidate",
    userName: user.name,
    userRole: user.role
  });

  return {
    offer: await getOffer(pool, offerId),
    toastMessage: "Offer released.",
    offerHold: activatedHold
      ? {
          hold_id: activatedHold.hold_id,
          candidate_id: activatedHold.candidate_id,
          activation_side_effects: holdActivationSummary
        }
      : null
  };
}

async function acceptOffer(pool, offerId, req) {
  const user = userContext(req);
  const offer = await getOffer(pool, offerId, req);

  if (offer.offerStatus !== "Released") {
    throw httpError("Only released offers can be accepted.", 400);
  }

  if (!offer.requisitionCode) {
    throw httpError("Offer must be linked to a requisition before acceptance.", 400);
  }

  if (!offer.candidateId) {
    throw httpError("Offer must be linked to a candidate before acceptance.", 400);
  }

  const {
    assertRequisitionOpenForRecruiting,
    assertNoDuplicateAcceptedOffer,
    assertReservedCapacityAvailable,
    lockRequisitionForUpdate
  } = require("./requisitionFulfillmentService");

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const offerLock = await client.query(
      `SELECT *
       FROM om_offers
       WHERE offer_id = $1
       FOR UPDATE`,
      [offerId]
    );

    if (!offerLock.rows[0]) {
      throw httpError(`Offer not found: ${offerId}`, 404);
    }

    const lockedOffer = offerLock.rows[0];

    if (lockedOffer.offer_status !== "Released") {
      throw httpError("Only released offers can be accepted.", 400);
    }

    const requisition = await lockRequisitionForUpdate(
      client,
      lockedOffer.requisition_code
    );

    assertRequisitionOpenForRecruiting(requisition);

    await assertNoDuplicateAcceptedOffer(
      client,
      lockedOffer.requisition_code,
      lockedOffer.candidate_id,
      offerId
    );

    await assertReservedCapacityAvailable(client, requisition, offerId);

    await client.query(
      `UPDATE om_offers
       SET offer_status = 'Accepted', modified_by = $1, modified_on = NOW()
       WHERE offer_id = $2`,
      [user.name, offerId]
    );

    await client.query(
      `UPDATE om_offer_acceptance
       SET response_status = 'Accepted', accepted_on = NOW(), responded_by = $1
       WHERE offer_id = $2`,
      [user.name, offerId]
    );

    await client.query("COMMIT");
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

  const followUpTasks = (await taskService.listInbox(pool, { module: "Offer Management" }))
    .filter((item) => item.businessObjectId === offerId && item.taskType === "Follow-up Acceptance");
  for (const task of followUpTasks) {
    await taskService.completeTask(pool, task.taskId, req, "Offer accepted");
  }

  await recordOfferHistory(pool, offerId, "OfferAccepted", user.name, user.role, "Released", "Accepted");
  await writeEnterpriseAudit(pool, {
    eventType: "OfferAccepted",
    module: "Offer Management",
    entity: "Offer",
    entityId: offerId,
    action: "Candidate accepted offer",
    userName: user.name,
    userRole: user.role
  });

  return {
    offer: await getOffer(pool, offerId),
    toastMessage: "Offer accepted."
  };
}

async function rejectOffer(pool, offerId, reason, req) {
  const user = userContext(req);
  const offer = await getOffer(pool, offerId, req);

  if (offer.offerStatus !== "Released") {
    throw httpError("Only released offers can be declined.", 400);
  }

  await pool.query(
    `UPDATE om_offers SET offer_status = 'Declined', modified_by = $1, modified_on = NOW()
     WHERE offer_id = $2`,
    [user.name, offerId]
  );

  await pool.query(
    `UPDATE om_offer_acceptance
     SET response_status = 'Declined', declined_on = NOW(), decline_reason = $1, responded_by = $2
     WHERE offer_id = $3`,
    [reason || null, user.name, offerId]
  );

  if (offer.workflowInstanceId) {
    await workflowService.advanceWorkflow(
      pool,
      offer.workflowInstanceId,
      "reject",
      { stageKey: "released", actor: user.name, comment: reason },
      req
    );
  }

  await recordOfferHistory(pool, offerId, "OfferRejected", user.name, user.role, offer.offerStatus, "Declined", reason);
  await writeEnterpriseAudit(pool, {
    eventType: "OfferRejected",
    module: "Offer Management",
    entity: "Offer",
    entityId: offerId,
    action: "Offer declined by candidate",
    userName: user.name,
    userRole: user.role,
    metadata: { reason }
  });

  return {
    offer: await getOffer(pool, offerId),
    toastMessage: "Offer declined."
  };
}

async function withdrawOffer(pool, offerId, reason, req) {
  const user = userContext(req);
  const trimmedReason = String(reason || "").trim();

  if (!trimmedReason) {
    throw httpError("A reason is required to withdraw or discard this offer.", 400);
  }

  await getOffer(pool, offerId, req);

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await assertCanWriteOfferRecord(client, req, offerId);

    const offerLock = await client.query(
      `SELECT offer_id, offer_status, workflow_instance_id, version
       FROM om_offers
       WHERE offer_id = $1
       FOR UPDATE`,
      [offerId]
    );

    if (!offerLock.rows[0]) {
      throw httpError(`Offer not found: ${offerId}`, 404);
    }

    const locked = offerLock.rows[0];
    const priorStatus = locked.offer_status;
    const terminalStatuses = new Set(["Accepted", "Declined", "Withdrawn"]);

    if (terminalStatuses.has(String(priorStatus))) {
      throw httpError(`Offer cannot be withdrawn from status: ${priorStatus}.`, 409);
    }

    if (String(priorStatus) === "Pending Approval") {
      await offerApprovalWorkflowService.assertNoOpenOfferClarification(
        client,
        locked.workflow_instance_id
      );

      await offerApprovalWorkflowService.terminateOfferWorkflowForRecruiterWithdrawal(
        client,
        { offerId, instanceId: locked.workflow_instance_id },
        req,
        { reason: trimmedReason }
      );
    }

    await client.query(
      `UPDATE om_offers SET offer_status = 'Withdrawn', modified_by = $1, modified_on = NOW()
       WHERE offer_id = $2`,
      [user.name, offerId]
    );

    await recordOfferHistory(
      client,
      offerId,
      "OfferWithdrawn",
      user.name,
      user.role,
      priorStatus,
      "Withdrawn",
      trimmedReason,
      {
        withdrawal_type: "recruiter_discard",
        workflow_instance_id: locked.workflow_instance_id || null
      }
    );

    await writeEnterpriseAudit(client, {
      eventType: "OfferWithdrawn",
      module: "Offer Management",
      entity: "Offer",
      entityId: offerId,
      action: "Offer discarded by authorized user",
      previousValue: priorStatus,
      newValue: "Withdrawn",
      userName: user.name,
      userRole: user.role,
      metadata: {
        reason: trimmedReason,
        withdrawal_type: "recruiter_discard",
        workflow_instance_id: locked.workflow_instance_id || null
      }
    });

    await client.query("COMMIT");

    return {
      offer: await getOffer(pool, offerId),
      toastMessage: "Offer withdrawn."
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

async function invalidateOfferLetterForAmendment(queryable, offerId) {
  const generatedDocumentRepository = require("../repositories/generatedDocumentRepository");

  await generatedDocumentRepository.supersedeGeneratedDocumentsForBusinessObject(
    queryable,
    "OFFER",
    offerId
  );

  const letterResult = await queryable.query(
    `SELECT letter_id FROM om_offer_letters WHERE offer_id = $1`,
    [offerId]
  );

  for (const row of letterResult.rows) {
    await queryable.query(
      `DELETE FROM om_offer_letter_ctc WHERE letter_id = $1`,
      [row.letter_id]
    );
  }

  await queryable.query(`DELETE FROM om_offer_letters WHERE offer_id = $1`, [offerId]);
}

async function correctAndResubmitPendingApproval(pool, offerId, payload, req) {
  const user = userContext(req);
  const correctionReason = String(payload?.reason || payload?.correction_reason || "").trim();

  if (!correctionReason) {
    throw httpError("A correction reason is required.", 400);
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await assertCanWriteOfferRecord(client, req, offerId);

    const { offerRow, instanceRow } =
      await offerApprovalWorkflowService.assertOfferCorrectionMayProceed(client, offerId);

    const priorSnapshot = {
      offered_ctc: Number(offerRow.offered_ctc),
      expected_joining_date: offerRow.expected_joining_date,
      variable_pay: Number(offerRow.variable_pay ?? 0),
      variable_pay_frequency: offerRow.variable_pay_frequency,
      joining_bonus: Number(offerRow.joining_bonus ?? 0),
      joining_bonus_frequency: offerRow.joining_bonus_frequency,
      version: Number(offerRow.version)
    };

    const mergedCommercial = normalizeCommercialFields({
      expected_joining_date:
        payload.expected_joining_date ?? payload.expectedJoiningDate ?? offerRow.expected_joining_date,
      variable_pay: payload.variable_pay ?? payload.variablePay ?? offerRow.variable_pay,
      variable_pay_frequency:
        payload.variable_pay_frequency
        ?? payload.variablePayFrequency
        ?? offerRow.variable_pay_frequency,
      joining_bonus: payload.joining_bonus ?? payload.joiningBonus ?? offerRow.joining_bonus,
      joining_bonus_frequency:
        payload.joining_bonus_frequency
        ?? payload.joiningBonusFrequency
        ?? offerRow.joining_bonus_frequency
    });

    const offeredCtc = assertStrictlyPositiveNumber(
      payload.offered_ctc ?? payload.offeredCtc ?? offerRow.offered_ctc,
      "Offered CTC"
    );

    const commercialErrors = validateCommercialOfferFields({
      ...mergedCommercial,
      offered_ctc: offeredCtc
    });

    if (commercialErrors.length) {
      throw httpError(commercialErrors.join(" "), 400);
    }

    await saveRevision(client, offerRow, correctionReason, user.name);

    const { varianceAmount, variancePct } = computeVariance(
      offerRow.approved_budget,
      offeredCtc
    );
    const nextVersion = Number((Number(offerRow.version) + 0.1).toFixed(1));

    await client.query(
      `UPDATE om_offers
       SET offered_ctc = $1,
           variance_amount = $2,
           variance_pct = $3,
           version = $4,
           expected_joining_date = $5,
           variable_pay = $6,
           variable_pay_frequency = $7,
           joining_bonus = $8,
           joining_bonus_frequency = $9,
           modified_by = $10,
           modified_on = NOW()
       WHERE offer_id = $11`,
      [
        offeredCtc,
        varianceAmount,
        variancePct,
        nextVersion,
        mergedCommercial.expected_joining_date,
        mergedCommercial.variable_pay,
        mergedCommercial.variable_pay_frequency,
        mergedCommercial.joining_bonus,
        mergedCommercial.joining_bonus_frequency,
        user.name,
        offerId
      ]
    );

    await client.query(
      `UPDATE om_offer_compensation
       SET total_ctc = $1,
           variable_pay = $2,
           bonus = $3,
           modified_on = NOW()
       WHERE offer_id = $4`,
      [
        offeredCtc,
        mergedCommercial.variable_pay,
        mergedCommercial.joining_bonus,
        offerId
      ]
    );

    await offerApprovalWorkflowService.cancelPendingOfferApprovalWork(
      client,
      { offerId, instanceId: instanceRow.instance_id },
      null
    );
    await offerApprovalWorkflowService.cancelPendingOfferInboxTasks(client, offerId);

    const refreshedRow = (
      await client.query(`SELECT * FROM om_offers WHERE offer_id = $1`, [offerId])
    ).rows[0];
    const updatedOffer = mapOfferRow(refreshedRow);

    const approvalRouteId = await approvalRouteResolverService.resolveApprovalRoute(
      client,
      "OFFER",
      {
        department: updatedOffer.department,
        designation: updatedOffer.positionTitle,
        grade: updatedOffer.grade,
        amount: updatedOffer.offeredCtc
      }
    );

    await publishOfferWorkflowAssignments(client, updatedOffer, req, approvalRouteId);

    const approvalTasks = await workflowService.createApprovalRouteWorkflowTasks(
      client,
      instanceRow.instance_id,
      approvalRouteId,
      {
        stageKey: "approval",
        assignedBy: req.user?.employee_code || user.name,
        requisitionCode: offerId,
        forceFreshRouteExpansion: true
      }
    );

    if (!Array.isArray(approvalTasks) || approvalTasks.length === 0) {
      throw httpError(
        "Corrected offer approval route did not publish any workflow assignments.",
        500
      );
    }

    await offerApprovalWorkflowService.refreshOfferApprovalMirrorPreservingApproved(
      client,
      offerId,
      approvalRouteId,
      nextVersion
    );

    await client.query(
      `UPDATE wf_instances
       SET status = 'Running', modified_by = $1, modified_on = NOW()
       WHERE instance_id = $2`,
      [user.name, instanceRow.instance_id]
    );

    const nextSnapshot = {
      offered_ctc: offeredCtc,
      expected_joining_date: mergedCommercial.expected_joining_date,
      variable_pay: mergedCommercial.variable_pay,
      variable_pay_frequency: mergedCommercial.variable_pay_frequency,
      joining_bonus: mergedCommercial.joining_bonus,
      joining_bonus_frequency: mergedCommercial.joining_bonus_frequency,
      version: nextVersion,
      approval_route_id: approvalRouteId
    };

    await recordOfferHistory(
      client,
      offerId,
      "OfferCorrectedResubmitted",
      user.name,
      user.role,
      "Pending Approval",
      "Pending Approval",
      correctionReason,
      {
        prior: priorSnapshot,
        next: nextSnapshot,
        workflow_instance_id: instanceRow.instance_id
      }
    );

    await writeEnterpriseAudit(client, {
      eventType: "OfferCorrectedResubmitted",
      module: "Offer Management",
      entity: "Offer",
      entityId: offerId,
      action: "Pending approval offer corrected and resubmitted",
      previousValue: JSON.stringify(priorSnapshot),
      newValue: JSON.stringify(nextSnapshot),
      userName: user.name,
      userRole: user.role,
      metadata: {
        reason: correctionReason,
        approval_route_id: approvalRouteId,
        cancelled_tasks: true
      }
    });

    await client.query("COMMIT");

    return {
      offer: await getOffer(pool, offerId),
      toastMessage: "Offer corrected and resubmitted for approval."
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

async function amendApprovedUnreleasedOffer(pool, offerId, payload, req) {
  const user = userContext(req);
  const amendmentReason = String(payload?.reason || payload?.amendment_reason || "").trim();

  if (!amendmentReason) {
    throw httpError("An amendment reason is required.", 400);
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await assertCanWriteOfferRecord(client, req, offerId);

    const { offerRow, instanceRow } =
      await offerApprovalWorkflowService.assertOfferAmendmentMayProceed(client, offerId);

    const priorSnapshot = {
      offered_ctc: Number(offerRow.offered_ctc),
      expected_joining_date: offerRow.expected_joining_date,
      variable_pay: Number(offerRow.variable_pay ?? 0),
      variable_pay_frequency: offerRow.variable_pay_frequency,
      joining_bonus: Number(offerRow.joining_bonus ?? 0),
      joining_bonus_frequency: offerRow.joining_bonus_frequency,
      version: Number(offerRow.version),
      offer_status: offerRow.offer_status
    };

    const mergedCommercial = normalizeCommercialFields({
      expected_joining_date:
        payload.expected_joining_date ?? payload.expectedJoiningDate ?? offerRow.expected_joining_date,
      variable_pay: payload.variable_pay ?? payload.variablePay ?? offerRow.variable_pay,
      variable_pay_frequency:
        payload.variable_pay_frequency
        ?? payload.variablePayFrequency
        ?? offerRow.variable_pay_frequency,
      joining_bonus: payload.joining_bonus ?? payload.joiningBonus ?? offerRow.joining_bonus,
      joining_bonus_frequency:
        payload.joining_bonus_frequency
        ?? payload.joiningBonusFrequency
        ?? offerRow.joining_bonus_frequency
    });

    const offeredCtc = assertStrictlyPositiveNumber(
      payload.offered_ctc ?? payload.offeredCtc ?? offerRow.offered_ctc,
      "Offered CTC"
    );

    const commercialErrors = validateCommercialOfferFields({
      ...mergedCommercial,
      offered_ctc: offeredCtc
    });

    if (commercialErrors.length) {
      throw httpError(commercialErrors.join(" "), 400);
    }

    await saveRevision(client, offerRow, amendmentReason, user.name);

    const { varianceAmount, variancePct } = computeVariance(
      offerRow.approved_budget,
      offeredCtc
    );
    const nextVersion = Number((Number(offerRow.version) + 0.1).toFixed(1));

    await client.query(
      `UPDATE om_offers
       SET offered_ctc = $1,
           variance_amount = $2,
           variance_pct = $3,
           version = $4,
           offer_status = 'Pending Approval',
           expected_joining_date = $5,
           variable_pay = $6,
           variable_pay_frequency = $7,
           joining_bonus = $8,
           joining_bonus_frequency = $9,
           modified_by = $10,
           modified_on = NOW()
       WHERE offer_id = $11`,
      [
        offeredCtc,
        varianceAmount,
        variancePct,
        nextVersion,
        mergedCommercial.expected_joining_date,
        mergedCommercial.variable_pay,
        mergedCommercial.variable_pay_frequency,
        mergedCommercial.joining_bonus,
        mergedCommercial.joining_bonus_frequency,
        user.name,
        offerId
      ]
    );

    await client.query(
      `UPDATE om_offer_compensation
       SET total_ctc = $1,
           variable_pay = $2,
           bonus = $3,
           modified_on = NOW()
       WHERE offer_id = $4`,
      [
        offeredCtc,
        mergedCommercial.variable_pay,
        mergedCommercial.joining_bonus,
        offerId
      ]
    );

    await invalidateOfferLetterForAmendment(client, offerId);

    await offerApprovalWorkflowService.cancelPendingOfferApprovalWork(
      client,
      { offerId, instanceId: instanceRow.instance_id },
      null
    );
    await offerApprovalWorkflowService.cancelPendingOfferInboxTasks(client, offerId);

    const refreshedRow = (
      await client.query(`SELECT * FROM om_offers WHERE offer_id = $1`, [offerId])
    ).rows[0];
    const updatedOffer = mapOfferRow(refreshedRow);

    const approvalRouteId = await approvalRouteResolverService.resolveApprovalRoute(
      client,
      "OFFER",
      {
        department: updatedOffer.department,
        designation: updatedOffer.positionTitle,
        grade: updatedOffer.grade,
        amount: updatedOffer.offeredCtc
      }
    );

    await publishOfferWorkflowAssignments(client, updatedOffer, req, approvalRouteId);

    const approvalTasks = await workflowService.createApprovalRouteWorkflowTasks(
      client,
      instanceRow.instance_id,
      approvalRouteId,
      {
        stageKey: "approval",
        assignedBy: req.user?.employee_code || user.name,
        requisitionCode: offerId,
        forceFreshRouteExpansion: true
      }
    );

    if (!Array.isArray(approvalTasks) || approvalTasks.length === 0) {
      throw httpError(
        "Amended offer approval route did not publish any workflow assignments.",
        500
      );
    }

    await offerApprovalWorkflowService.refreshOfferApprovalMirrorPreservingApproved(
      client,
      offerId,
      approvalRouteId,
      nextVersion
    );

    await client.query(
      `UPDATE wf_instances
       SET status = 'Running',
           completed_on = NULL,
           modified_by = $1,
           modified_on = NOW()
       WHERE instance_id = $2`,
      [user.name, instanceRow.instance_id]
    );

    const nextSnapshot = {
      offered_ctc: offeredCtc,
      expected_joining_date: mergedCommercial.expected_joining_date,
      variable_pay: mergedCommercial.variable_pay,
      variable_pay_frequency: mergedCommercial.variable_pay_frequency,
      joining_bonus: mergedCommercial.joining_bonus,
      joining_bonus_frequency: mergedCommercial.joining_bonus_frequency,
      version: nextVersion,
      approval_route_id: approvalRouteId,
      offer_status: "Pending Approval"
    };

    await recordOfferHistory(
      client,
      offerId,
      "OfferAmendedResubmitted",
      user.name,
      user.role,
      "Approved",
      "Pending Approval",
      amendmentReason,
      {
        prior: priorSnapshot,
        next: nextSnapshot,
        workflow_instance_id: instanceRow.instance_id
      }
    );

    await writeEnterpriseAudit(client, {
      eventType: "OfferAmendedResubmitted",
      module: "Offer Management",
      entity: "Offer",
      entityId: offerId,
      action: "Approved offer amended and resubmitted for approval",
      previousValue: JSON.stringify(priorSnapshot),
      newValue: JSON.stringify(nextSnapshot),
      userName: user.name,
      userRole: user.role,
      metadata: {
        reason: amendmentReason,
        approval_route_id: approvalRouteId,
        cancelled_tasks: true
      }
    });

    await client.query("COMMIT");

    return {
      offer: await getOffer(pool, offerId),
      toastMessage: "Offer amended and resubmitted for approval."
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

async function requestClarification(pool, offerId, comments, req) {
  const clarificationComments = String(comments || "").trim();
  if (!clarificationComments) {
    throw httpError("Clarification comments are required.", 400);
  }

  await assertOfferReadAccess(pool, req, offerId);

  const offerRow = await pool.query(
    `SELECT offer_id, workflow_instance_id, offer_status
     FROM om_offers
     WHERE offer_id = $1`,
    [offerId]
  );

  if (!offerRow.rows[0]) {
    throw httpError(`Offer not found: ${offerId}`, 404);
  }

  const workflowInstanceId = offerRow.rows[0].workflow_instance_id;
  if (!workflowInstanceId) {
    throw httpError("No workflow instance linked to this offer.", 400);
  }

  const offerWorkflowCompletionService = require("./offerWorkflowCompletionService");
  await offerWorkflowCompletionService.assertOfferClarificationRequestorResolvable(pool, offerId);

  const taskId = await resolveActiveOfferApprovalTaskId(pool, workflowInstanceId, req);

  await workflowService.requestClarificationMyActiveApproval(
    pool,
    taskId,
    clarificationComments,
    req
  );

  const offer = await getOffer(pool, offerId, req);

  return {
    offer,
    toastMessage: "Clarification request sent. Workflow paused."
  };
}

async function submitClarification(pool, offerId, comments, req) {
  const clarificationComments = String(comments || "").trim();
  if (!clarificationComments) {
    throw httpError("Clarification response is required.", 400);
  }

  const { assertCanSubmitOfferClarification } = require("./offerCapabilityAuth");
  await assertCanSubmitOfferClarification(pool, req, offerId);

  const offerRow = await pool.query(
    `SELECT offer_id, workflow_instance_id
     FROM om_offers
     WHERE offer_id = $1`,
    [offerId]
  );

  if (!offerRow.rows[0]) {
    throw httpError(`Offer not found: ${offerId}`, 404);
  }

  const workflowInstanceId = offerRow.rows[0].workflow_instance_id;
  if (!workflowInstanceId) {
    throw httpError("No workflow instance linked to this offer.", 400);
  }

  await workflowService.submitClarification(
    pool,
    workflowInstanceId,
    clarificationComments,
    req
  );

  const offer = await getOffer(pool, offerId, req);

  return {
    offer,
    toastMessage: "Clarification submitted. Workflow resumed."
  };
}

async function seedConfiguration(pool, payload, user = { name: "System Seed", role: "Admin" }) {
  const seed = clonePayload(payload);

  for (const offer of seed.offers || []) {
    const { varianceAmount, variancePct } = computeVariance(offer.approved_budget, offer.offered_ctc);

    await pool.query(
      `INSERT INTO om_offers (
        offer_id, approved_position_id, requisition_code, candidate_id, mapping_id, interview_id,
        recruiter_id, hiring_manager, candidate_name, position_title, grade, department, location,
        business_unit, employment_type, approved_budget, offered_ctc, variance_amount, variance_pct,
        currency, offer_status, workflow_instance_id, validity_days, valid_until,
        created_by, modified_by, effective_from
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
      ON CONFLICT (offer_id) DO UPDATE SET offer_status = EXCLUDED.offer_status, modified_on = NOW()`,
      [
        offer.offer_id,
        offer.approved_position_id || null,
        offer.requisition_code || null,
        offer.candidate_id || null,
        offer.mapping_id || null,
        offer.interview_id || null,
        offer.recruiter_id || null,
        offer.hiring_manager || null,
        offer.candidate_name || null,
        offer.position_title || null,
        offer.grade || null,
        offer.department || null,
        offer.location || null,
        offer.business_unit || null,
        offer.employment_type || "Full-time",
        offer.approved_budget || 0,
        offer.offered_ctc || 0,
        varianceAmount,
        variancePct,
        offer.currency || "INR",
        offer.offer_status || "Draft",
        offer.workflow_instance_id || null,
        offer.validity_days || 7,
        offer.valid_until || null,
        user.name,
        user.name,
        new Date()
      ]
    );

    if (offer.compensation) {
      await pool.query("DELETE FROM om_offer_compensation WHERE offer_id = $1", [offer.offer_id]);
      await pool.query(
        `INSERT INTO om_offer_compensation (
          offer_id, base_salary, variable_pay, bonus, benefits, total_ctc, currency, effective_from
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          offer.offer_id,
          offer.compensation.base_salary || offer.offered_ctc * 0.8,
          offer.compensation.variable_pay || offer.offered_ctc * 0.15,
          offer.compensation.bonus || offer.offered_ctc * 0.05,
          offer.compensation.benefits || 0,
          offer.offered_ctc,
          offer.currency || "INR",
          new Date()
        ]
      );
    }

    for (const approval of offer.approvals || []) {
      await pool.query(
        `INSERT INTO om_offer_approvals (
          offer_id, approval_step, approver_role, approver_name, approval_status, sequence_order, effective_from
        ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          offer.offer_id,
          approval.approval_step,
          approval.approver_role,
          approval.approver_name || null,
          approval.approval_status || "Pending",
          approval.sequence_order || 1,
          new Date()
        ]
      );
    }
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
        task.business_object_type || "Offer",
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
  getOfferBundle,
  getOffer,
  listScopedOfferRows,
  assertOfferReadAccess,
  createOffer,
  submitOffer,
  approveOffer,
  negotiateOffer,
  reviseOffer,
  releaseOffer,
  acceptOffer,
  rejectOffer,
  withdrawOffer,
  correctAndResubmitPendingApproval,
  amendApprovedUnreleasedOffer,
  requestClarification,
  submitClarification,
  buildOfferClarificationRounds,
  validateMasterDataReferences,
  evaluateOfferRules,
  seedConfiguration
};
