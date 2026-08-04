const businessRulesService = require("./businessRulesService");
const workflowService = require("./workflowService");
const recruitmentService = require("./recruitmentService");
const taskService = require("./taskService");
const approvalRouteResolverService = require("./approvalRouteResolverService");
const approvalRouteRepository = require("../repositories/approvalRouteRepository");
const { writeEnterpriseAudit, userContext } = require("./enterpriseAuditService");

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
    version: Number(row.version)
  };
}

async function getOffer(pool, offerId) {
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

async function getOfferBundle(pool) {
  const offers = await pool.query("SELECT * FROM om_offers ORDER BY created_on DESC");
  const approvals = await pool.query("SELECT * FROM om_offer_approvals ORDER BY sequence_order ASC");
  const negotiations = await pool.query("SELECT * FROM om_offer_negotiations ORDER BY created_on DESC");

  return {
    offers: offers.rows.map(mapOfferRow),
    approvals: approvals.rows,
    negotiations: negotiations.rows,
    summary: {
      draft: offers.rows.filter((row) => row.offer_status === "Draft").length,
      pendingApproval: offers.rows.filter((row) => /pending/i.test(row.offer_status)).length,
      released: offers.rows.filter((row) => row.offer_status === "Released").length,
      accepted: offers.rows.filter((row) => row.offer_status === "Accepted").length
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

  const offeredCtc = Number(context.offered_ctc || context.total_ctc || 0);
  if (offeredCtc <= 0) {
    throw httpError("Offered CTC is required.", 400);
  }

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
      created_by, modified_by, effective_from
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)`,
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
      Number(context.base_salary || offeredCtc * 0.8),
      Number(context.variable_pay || offeredCtc * 0.15),
      Number(context.bonus || offeredCtc * 0.05),
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
      approval_route_id: approvalRouteId
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
async function syncOfferApprovalsFromRoute(pool, offerId, approvalRouteId) {
  await pool.query("DELETE FROM om_offer_approvals WHERE offer_id = $1", [offerId]);

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
        offer_id, approval_step, approver_role, approval_status, sequence_order, effective_from
      ) VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        offerId,
        stepTitle,
        step.approval_type || "Approver",
        index === 0 ? "Pending" : "Waiting",
        sequence,
        new Date()
      ]
    );
  }
}

async function submitOffer(pool, offerId, comment, req) {
  const user = userContext(req);
  const platformConfig = await loadPlatformConfig(pool);
  await assertOfferModuleEnabled(platformConfig);

  const offer = await getOffer(pool, offerId);
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
  const offer = await getOffer(pool, offerId);

  const approvalResult = await pool.query(
    `UPDATE om_offer_approvals
     SET approval_status = 'Approved', approver_name = $1, approved_on = NOW(), comments = $2
     WHERE offer_id = $3 AND approval_step = $4 AND approval_status = 'Pending'
     RETURNING *`,
    [user.name, comment || null, offerId, approvalStep]
  );

  if (!approvalResult.rows.length) {
    throw httpError(`Pending approval step not found: ${approvalStep}`, 404);
  }

  const stageKey = approvalStep.toLowerCase().includes("finance")
    ? "finance"
    : approvalStep.toLowerCase().includes("leadership")
      ? "hm_review"
      : "hm_review";

  if (offer.workflowInstanceId) {
    await workflowService.advanceWorkflow(
      pool,
      offer.workflowInstanceId,
      "approve",
      { stageKey, actor: user.name, comment },
      req
    );
  }

  const pending = await pool.query(
    `SELECT COUNT(*) AS count FROM om_offer_approvals
     WHERE offer_id = $1 AND approval_status = 'Pending'`,
    [offerId]
  );

  const eventType = /finance/i.test(approvalStep)
    ? "FinanceApproved"
    : /leadership/i.test(approvalStep)
      ? "LeadershipApproved"
      : "StageApproved";

  if (Number(pending.rows[0].count) === 0) {
    await pool.query(
      `UPDATE om_offers SET offer_status = 'Approved', modified_by = $1, modified_on = NOW()
       WHERE offer_id = $2`,
      [user.name, offerId]
    );

    if (offer.workflowInstanceId) {
      await workflowService.advanceWorkflow(
        pool,
        offer.workflowInstanceId,
        "approve",
        { stageKey: "approved", actor: user.name, comment: "All approvals complete" },
        req
      );
    }
  }

  const inboxTasks = await taskService.listInbox(pool, { module: "Offer Management" });
  for (const task of inboxTasks.filter(
    (item) => item.businessObjectId === offerId && item.taskType === approvalStep
  )) {
    await taskService.completeTask(pool, task.taskId, req, comment);
  }

  await writeEnterpriseAudit(pool, {
    eventType,
    module: "Offer Management",
    entity: "Offer",
    entityId: offerId,
    action: `${approvalStep} approved`,
    userName: user.name,
    userRole: user.role,
    metadata: { comment }
  });

  return {
    offer: await getOffer(pool, offerId),
    toastMessage: `${approvalStep} approved.`
  };
}

async function negotiateOffer(pool, offerId, payload, req) {
  const user = userContext(req);
  const offer = await getOffer(pool, offerId);

  const ruleEval = await evaluateOfferRules(pool, {
    offered_salary_lpa: Number(payload.proposed_ctc || offer.offeredCtc) / 100000,
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
      Number(payload.proposed_ctc || offer.offeredCtc),
      payload.counter_ctc ? Number(payload.counter_ctc) : null,
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
  const row = (await pool.query("SELECT * FROM om_offers WHERE offer_id = $1", [offerId])).rows[0];
  if (!row) {
    throw httpError(`Offer not found: ${offerId}`, 404);
  }

  await saveRevision(pool, row, payload.reason, user.name);

  const offeredCtc = Number(payload.offered_ctc ?? row.offered_ctc);
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
  const offer = await getOffer(pool, offerId);

  if (!["Approved", "Pending Approval"].includes(offer.offerStatus)) {
    throw httpError("Offer must be approved before release.", 400);
  }

  if (offer.workflowInstanceId) {
    await workflowService.advanceWorkflow(
      pool,
      offer.workflowInstanceId,
      "approve",
      { stageKey: "released", actor: user.name, comment: payload.comment || "" },
      req
    );
  }

  await pool.query(
    `UPDATE om_offers SET offer_status = 'Released', modified_by = $1, modified_on = NOW()
     WHERE offer_id = $2`,
    [user.name, offerId]
  );

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

  await recordOfferHistory(pool, offerId, "OfferReleased", user.name, user.role, offer.offerStatus, "Released");
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
    toastMessage: "Offer released."
  };
}

async function acceptOffer(pool, offerId, req) {
  const user = userContext(req);
  const offer = await getOffer(pool, offerId);

  if (offer.offerStatus !== "Released") {
    throw httpError("Only released offers can be accepted.", 400);
  }

  await pool.query(
    `UPDATE om_offers SET offer_status = 'Accepted', modified_by = $1, modified_on = NOW()
     WHERE offer_id = $2`,
    [user.name, offerId]
  );

  await pool.query(
    `UPDATE om_offer_acceptance
     SET response_status = 'Accepted', accepted_on = NOW(), responded_by = $1
     WHERE offer_id = $2`,
    [user.name, offerId]
  );

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
  const offer = await getOffer(pool, offerId);

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
  const offer = await getOffer(pool, offerId);

  await pool.query(
    `UPDATE om_offers SET offer_status = 'Withdrawn', modified_by = $1, modified_on = NOW()
     WHERE offer_id = $2`,
    [user.name, offerId]
  );

  await recordOfferHistory(pool, offerId, "OfferWithdrawn", user.name, user.role, offer.offerStatus, "Withdrawn", reason);
  await writeEnterpriseAudit(pool, {
    eventType: "OfferWithdrawn",
    module: "Offer Management",
    entity: "Offer",
    entityId: offerId,
    action: "Offer withdrawn",
    userName: user.name,
    userRole: user.role,
    metadata: { reason }
  });

  return {
    offer: await getOffer(pool, offerId),
    toastMessage: "Offer withdrawn."
  };
}

async function requestClarification(pool, offerId, comments, req) {
  const offer = await getOffer(pool, offerId);
  if (!offer.workflowInstanceId) {
    throw httpError("No workflow instance linked to this offer.", 400);
  }

  await workflowService.requestClarification(pool, offer.workflowInstanceId, comments, req);

  return {
    offer,
    toastMessage: "Clarification requested via Workflow Engine."
  };
}

async function submitClarification(pool, offerId, comments, req) {
  const offer = await getOffer(pool, offerId);
  if (!offer.workflowInstanceId) {
    throw httpError("No workflow instance linked to this offer.", 400);
  }

  await workflowService.submitClarification(pool, offer.workflowInstanceId, comments, req);

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
  createOffer,
  submitOffer,
  approveOffer,
  negotiateOffer,
  reviseOffer,
  releaseOffer,
  acceptOffer,
  rejectOffer,
  withdrawOffer,
  requestClarification,
  submitClarification,
  validateMasterDataReferences,
  evaluateOfferRules,
  seedConfiguration
};
