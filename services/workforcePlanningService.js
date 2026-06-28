const businessRulesService = require("./businessRulesService");
const workflowService = require("./workflowService");
const masterDataService = require("./masterDataService");
const { writeEnterpriseAudit, userContext } = require("./enterpriseAuditService");

const SEED_PATH = require("path").join(__dirname, "..", "seed", "workforcePlanning.seed.json");

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

function configsEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function fetchConfigState(pool) {
  const result = await pool.query("SELECT * FROM wp_config_state WHERE id = 1");
  return result.rows[0] || null;
}

async function ensureConfigState(pool) {
  const existing = await fetchConfigState(pool);

  if (existing) {
    return existing;
  }

  const seed = getDefaultSeedPayload();
  await pool.query(
    `INSERT INTO wp_config_state (
      id, draft_payload, published_payload, version, version_status,
      effective_from, created_by, modified_by
    ) VALUES (1, $1, $2, 1.0, 'Published', NOW(), 'System', 'System')`,
    [JSON.stringify(seed), JSON.stringify(seed)]
  );

  await syncNormalizedTables(pool, seed, "System", 1.0, "Published");
  return fetchConfigState(pool);
}

function buildBundle(row) {
  const draft = clonePayload(row.draft_payload);
  const published = clonePayload(row.published_payload);

  return {
    config: draft,
    baseline: published,
    isDirty: !configsEqual(draft, published),
    version: String(Number(row.version).toFixed(1)),
    versionStatus: row.version_status
  };
}

async function getWorkforceBundle(pool) {
  const row = await ensureConfigState(pool);
  return buildBundle(row);
}

async function persistDraft(pool, draft, userName) {
  await pool.query(
    `UPDATE wp_config_state
     SET draft_payload = $1, modified_by = $2, modified_on = NOW()
     WHERE id = 1`,
    [JSON.stringify(draft), userName]
  );

  return draft;
}

async function loadPlatformConfig(pool) {
  const result = await pool.query(
    "SELECT published_payload FROM pc_config_state WHERE id = 1"
  );
  return result.rows[0]?.published_payload || null;
}

async function validateMasterDataReferences(pool, request) {
  const errors = [];
  const departments = await masterDataService.listByEntityType(pool, "departments");
  const grades = await masterDataService.listByEntityType(pool, "grades");

  const departmentNames = new Set(departments.map((row) => row.name.toLowerCase()));
  const gradeCodes = new Set(grades.map((row) => row.code.toLowerCase()));
  const gradeNames = new Set(grades.map((row) => row.name.toLowerCase()));

  if (request.department && !departmentNames.has(request.department.toLowerCase())) {
    const partial = departments.find((row) =>
      row.name.toLowerCase().includes(request.department.toLowerCase())
      || request.department.toLowerCase().includes(row.name.toLowerCase())
    );
    if (!partial) {
      errors.push(`Department "${request.department}" not found in Master Data.`);
    }
  }

  if (request.grade) {
    const gradeKey = request.grade.toLowerCase();
    if (!gradeCodes.has(gradeKey) && !gradeNames.has(gradeKey)) {
      const partial = grades.find((row) =>
        row.code.toLowerCase().includes(gradeKey)
        || row.name.toLowerCase().includes(gradeKey)
      );
      if (!partial) {
        errors.push(`Grade "${request.grade}" not found in Master Data.`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

async function evaluateBudgetRules(pool, request, platformConfig) {
  const budgetThreshold = platformConfig?.budget?.max_budget_variance_pct ?? 10;
  const proposedLpa = Number(request.proposed_budget || 0) / 100000;

  const context = {
    department: request.department,
    grade: request.grade,
    offered_salary_lpa: proposedLpa,
    approved_budget_lpa: proposedLpa * 0.9,
    headcount: request.headcount,
    employment_type: "Full-time"
  };

  const simulation = await businessRulesService.simulateRules(pool, context, {
    user: { full_name: "Rule Engine", role_name: "System" }
  });

  const requiresFinance = simulation.approvers.some((item) =>
    /finance/i.test(item)
  ) || simulation.triggered_rules.some((item) => /budget|finance/i.test(item));

  const requiresLeadership = simulation.triggered_rules.some((item) =>
    /grade|leadership|location/i.test(item)
  );

  return {
    simulation,
    budgetThreshold,
    requiresFinance,
    requiresLeadership,
    nextApprover: requiresFinance ? "Finance" : requiresLeadership ? "TA Leader" : null
  };
}

function findQueueRequest(bundle, requestId) {
  return bundle.approval_queue.find((item) => item.id === requestId);
}

function nowIso() {
  return new Date().toISOString();
}

function appendTimelineEntry(request, step, actor, comment) {
  return {
    ...request,
    timeline: [
      ...(request.timeline || []),
      { step, actor, date: nowIso(), comment: comment || null }
    ],
    history: [
      ...(request.history || []),
      { action: step, actor, date: nowIso(), comment: comment || null }
    ]
  };
}

async function syncNormalizedTables(pool, payload, userName, version, versionStatus) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const effectiveFrom = new Date();
    const meta = payload.meta || {};
    const dashboard = payload.dashboard || {};

    await client.query(
      `INSERT INTO wp_workforce_plans (
        id, fiscal_year, org_name, currency, version, version_status,
        effective_from, last_updated, modified_by
      ) VALUES (1,$1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (id) DO UPDATE SET
        fiscal_year = EXCLUDED.fiscal_year,
        org_name = EXCLUDED.org_name,
        currency = EXCLUDED.currency,
        version = EXCLUDED.version,
        version_status = EXCLUDED.version_status,
        effective_from = EXCLUDED.effective_from,
        last_updated = EXCLUDED.last_updated,
        modified_by = EXCLUDED.modified_by,
        modified_on = NOW()`,
      [
        meta.fiscal_year,
        meta.org_name,
        meta.currency || "INR",
        version,
        versionStatus,
        effectiveFrom,
        meta.last_updated ? new Date(meta.last_updated) : new Date(),
        userName
      ]
    );

    await client.query("DELETE FROM wp_position_requests");
    await client.query("DELETE FROM wp_budget_requests");

    for (const request of payload.budget_requests || []) {
      const queueItem = (payload.approval_queue || []).find((item) => item.id === request.id);

      await client.query(
        `INSERT INTO wp_budget_requests (
          request_id, department, position_title, grade, headcount, proposed_budget,
          justification, status, submitted_by, submitted_on, priority, current_approver,
          workflow_instance_id, version, version_status, effective_from, modified_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [
          request.id,
          request.department,
          request.position,
          request.grade || null,
          request.headcount || 1,
          request.proposed_budget || 0,
          request.justification || null,
          request.status,
          request.submitted_by || null,
          request.submitted_on || null,
          request.priority || "Medium",
          queueItem?.current_approver || null,
          queueItem?.workflow_instance_id || null,
          version,
          versionStatus,
          effectiveFrom,
          userName
        ]
      );

      await client.query(
        `INSERT INTO wp_position_requests (
          position_request_id, budget_request_id, department, position_title, grade,
          headcount, status, version, version_status, effective_from, created_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          request.id,
          request.id,
          request.department,
          request.position,
          request.grade || null,
          request.headcount || 1,
          request.status,
          version,
          versionStatus,
          effectiveFrom,
          userName
        ]
      );
    }

    await client.query("DELETE FROM wp_approved_positions");
    for (const position of payload.approved_positions || []) {
      await client.query(
        `INSERT INTO wp_approved_positions (
          position_id, source_request_id, department, position_title, grade, headcount,
          budget_approved, budget_consumed, remaining_budget, expiry_date,
          requisitions_created, status, version, version_status, effective_from, modified_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [
          position.id,
          position.source_request_id || null,
          position.department,
          position.position,
          position.grade || null,
          position.headcount || 1,
          position.budget_approved || 0,
          position.budget_consumed || 0,
          position.remaining_budget || 0,
          position.expiry_date || null,
          position.requisitions_created || 0,
          position.status || "Active",
          version,
          versionStatus,
          effectiveFrom,
          userName
        ]
      );
    }

    await client.query("DELETE FROM wp_budget_utilization");
    const analytics = payload.analytics || {};
    await client.query(
      `INSERT INTO wp_budget_utilization (
        fiscal_year, total_approved_budget, budget_consumed, budget_utilization_pct,
        savings, overspend, version, version_status, effective_from
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        meta.fiscal_year || "FY",
        dashboard.total_approved_budget || analytics.budget_vs_actual?.approved || 0,
        dashboard.budget_consumed || analytics.budget_vs_actual?.actual || 0,
        dashboard.budget_utilization_pct || 0,
        analytics.savings || 0,
        analytics.overspend || 0,
        version,
        versionStatus,
        effectiveFrom
      ]
    );

    await client.query("DELETE FROM wp_department_headcount");
    for (const row of analytics.department_utilization || []) {
      await client.query(
        `INSERT INTO wp_department_headcount (
          department, approved_budget, utilized_budget, utilization_pct,
          version, version_status, effective_from
        ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          row.department,
          row.approved || 0,
          row.utilized || 0,
          row.pct || 0,
          version,
          versionStatus,
          effectiveFrom
        ]
      );
    }

    await client.query("DELETE FROM wp_budget_exceptions");
    for (const ex of payload.budget_exceptions || []) {
      await client.query(
        `INSERT INTO wp_budget_exceptions (
          exception_id, candidate_name, position_title, department, approved_budget,
          offered_ctc, variance_amount, variance_pct, workflow_status, approver,
          comments, req_code, version, version_status, effective_from, created_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [
          ex.id,
          ex.candidate_name || null,
          ex.position,
          ex.department,
          ex.approved_budget || 0,
          ex.offered_ctc || 0,
          ex.variance_amount || 0,
          ex.variance_pct || 0,
          ex.workflow_status || "Pending",
          ex.approver || null,
          ex.comments || null,
          ex.req_code || null,
          version,
          versionStatus,
          effectiveFrom,
          userName
        ]
      );
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function ensureWorkflowInstance(pool, request, req) {
  if (request.workflow_instance_id) {
    return request.workflow_instance_id;
  }

  const instance = await workflowService.startWorkflow(
    pool,
    "REQUISITION",
    {
      instance_id: `WF-BR-${request.id}`,
      meta: {
        process_id: `WF-BR-${request.id}`,
        department: request.department,
        position_title: request.position,
        requisition_id: request.id
      },
      department: request.department,
      grade: request.grade
    },
    req
  );

  return instance.instanceId;
}

async function approveBudgetRequest(pool, requestId, comment, req) {
  const user = userContext(req);
  const row = await ensureConfigState(pool);
  const draft = clonePayload(row.draft_payload);
  const request = findQueueRequest(draft, requestId);

  if (!request) {
    throw httpError(`Budget request not found: ${requestId}`, 404);
  }

  const mdValidation = await validateMasterDataReferences(pool, request);
  if (!mdValidation.valid) {
    throw httpError(mdValidation.errors.join(" "), 400);
  }

  const platformConfig = await loadPlatformConfig(pool);
  const workforceModule = platformConfig?.modules?.find((item) => item.key === "recruitment");
  if (platformConfig && workforceModule && !workforceModule.enabled) {
    throw httpError("Recruitment module is disabled in Platform Configuration.", 400);
  }

  const ruleEval = await evaluateBudgetRules(pool, request, platformConfig);
  const instanceId = await ensureWorkflowInstance(pool, request, req);

  let nextStatus = "Approved";
  let nextApprover = null;
  let approvedPosition = null;

  if (request.status === "Pending TA Lead" && ruleEval.requiresFinance) {
    nextStatus = "Pending Finance";
    nextApprover = "Finance";
  } else if (request.status === "Pending Finance" || !ruleEval.requiresFinance) {
    nextStatus = "Approved";
    approvedPosition = {
      id: `AP-2026-${String(draft.approved_positions.length + 90).padStart(4, "0")}`,
      department: request.department,
      position: request.position,
      grade: request.grade,
      headcount: request.headcount,
      budget_approved: request.proposed_budget,
      budget_consumed: 0,
      remaining_budget: request.proposed_budget,
      expiry_date: "2026-12-31",
      requisitions_created: 0,
      status: "Active",
      source_request_id: request.id
    };
    draft.approved_positions = [approvedPosition, ...draft.approved_positions];
    draft.dashboard.approved_headcount += request.headcount;
    draft.dashboard.vacant_positions += request.headcount;
  }

  const updatedRequest = appendTimelineEntry(
    {
      ...request,
      status: nextStatus,
      current_approver: nextApprover,
      workflow_instance_id: instanceId
    },
    nextStatus === "Approved" ? "Approved" : "Approved by TA Lead",
    user.name,
    comment
  );

  draft.approval_queue = draft.approval_queue.map((item) =>
    item.id === requestId ? updatedRequest : item
  );
  draft.budget_requests = draft.budget_requests.map((item) =>
    item.id === requestId ? { ...item, status: nextStatus } : item
  );

  if (nextStatus === "Approved") {
    await workflowService.advanceWorkflow(
      pool,
      instanceId,
      "approve",
      { stageKey: "position_budget_approval", actor: user.name, comment },
      req
    );
  }

  draft.meta.last_updated = nowIso();
  await persistDraft(pool, draft, user.name);

  await writeEnterpriseAudit(pool, {
    eventType: nextStatus === "Approved" ? "BudgetApproved" : "BudgetRouted",
    module: "Workforce Planning",
    entity: "Budget Request",
    entityId: requestId,
    action: nextStatus === "Approved"
      ? `Budget approved for ${request.position}`
      : `Budget routed to ${nextApprover}`,
    previousValue: request.status,
    newValue: nextStatus,
    userName: user.name,
    userRole: user.role,
    metadata: { comment, ruleEvaluation: ruleEval.simulation }
  });

  if (approvedPosition) {
    await pool.query(
      `INSERT INTO wp_position_lifecycle (position_id, event_type, from_status, to_status, actor, comments)
       VALUES ($1,'Approved','Draft','Active',$2,$3)`,
      [approvedPosition.id, user.name, comment || null]
    );

    await writeEnterpriseAudit(pool, {
      eventType: "PositionApproved",
      module: "Workforce Planning",
      entity: "Approved Position",
      entityId: approvedPosition.id,
      action: `Position ${request.position} added to catalogue`,
      userName: user.name,
      userRole: user.role
    });
  }

  return {
    workforce: draft,
    approvedPosition,
    request: updatedRequest,
    ruleEvaluation: ruleEval,
    hiringProcessUpdate: approvedPosition
      ? { linkedPositionId: approvedPosition.id }
      : undefined,
    toastMessage: nextStatus === "Approved"
      ? "Budget request approved."
      : `Routed to ${nextApprover} for approval.`
  };
}

async function rejectBudgetRequest(pool, requestId, comment, req) {
  const user = userContext(req);
  const row = await ensureConfigState(pool);
  const draft = clonePayload(row.draft_payload);
  const request = findQueueRequest(draft, requestId);

  if (!request) {
    throw httpError(`Budget request not found: ${requestId}`, 404);
  }

  const updatedRequest = appendTimelineEntry(
    { ...request, status: "Rejected" },
    "Rejected",
    user.name,
    comment
  );

  draft.approval_queue = draft.approval_queue.map((item) =>
    item.id === requestId ? updatedRequest : item
  );
  draft.budget_requests = draft.budget_requests.map((item) =>
    item.id === requestId ? { ...item, status: "Rejected" } : item
  );
  draft.meta.last_updated = nowIso();

  if (request.workflow_instance_id) {
    await workflowService.advanceWorkflow(
      pool,
      request.workflow_instance_id,
      "reject",
      { stageKey: "position_budget_approval", actor: user.name, comment },
      req
    );
  }

  await persistDraft(pool, draft, user.name);

  await writeEnterpriseAudit(pool, {
    eventType: "BudgetRejected",
    module: "Workforce Planning",
    entity: "Budget Request",
    entityId: requestId,
    action: `Budget rejected for ${request.position}`,
    previousValue: request.status,
    newValue: "Rejected",
    userName: user.name,
    userRole: user.role,
    metadata: { comment }
  });

  return {
    workforce: draft,
    request: updatedRequest,
    toastMessage: "Budget request rejected."
  };
}

async function sendBackBudgetRequest(pool, requestId, comment, req) {
  const user = userContext(req);
  const row = await ensureConfigState(pool);
  const draft = clonePayload(row.draft_payload);
  const request = findQueueRequest(draft, requestId);

  if (!request) {
    throw httpError(`Budget request not found: ${requestId}`, 404);
  }

  const updatedRequest = appendTimelineEntry(
    {
      ...request,
      status: "Sent Back",
      current_approver: "Hiring Manager"
    },
    "Sent Back",
    user.name,
    comment
  );

  draft.approval_queue = draft.approval_queue.map((item) =>
    item.id === requestId ? updatedRequest : item
  );
  draft.budget_requests = draft.budget_requests.map((item) =>
    item.id === requestId ? { ...item, status: "Sent Back" } : item
  );
  draft.meta.last_updated = nowIso();
  await persistDraft(pool, draft, user.name);

  await writeEnterpriseAudit(pool, {
    eventType: "BudgetSentBack",
    module: "Workforce Planning",
    entity: "Budget Request",
    entityId: requestId,
    action: `Budget sent back for ${request.position}`,
    userName: user.name,
    userRole: user.role,
    metadata: { comment }
  });

  return {
    workforce: draft,
    request: updatedRequest,
    toastMessage: "Budget request sent back to hiring manager."
  };
}

async function requestBudgetClarification(pool, requestId, comments, req) {
  const user = userContext(req);
  const row = await ensureConfigState(pool);
  const draft = clonePayload(row.draft_payload);
  const request = findQueueRequest(draft, requestId);

  if (!request) {
    throw httpError(`Budget request not found: ${requestId}`, 404);
  }

  const instanceId = await ensureWorkflowInstance(pool, request, req);

  await workflowService.requestClarification(pool, instanceId, comments, req);

  const updatedRequest = appendTimelineEntry(
    { ...request, status: "Clarification Requested", workflow_instance_id: instanceId },
    "Clarification Requested",
    user.name,
    comments
  );

  draft.approval_queue = draft.approval_queue.map((item) =>
    item.id === requestId ? updatedRequest : item
  );
  draft.budget_requests = draft.budget_requests.map((item) =>
    item.id === requestId ? { ...item, status: "Clarification Requested" } : item
  );
  await persistDraft(pool, draft, user.name);

  await writeEnterpriseAudit(pool, {
    eventType: "ClarificationRequested",
    module: "Workforce Planning",
    entity: "Budget Request",
    entityId: requestId,
    action: "Clarification requested on budget request",
    userName: user.name,
    userRole: user.role,
    metadata: { comments }
  });

  return {
    workforce: draft,
    toastMessage: "Clarification request sent via Workflow Engine."
  };
}

async function submitBudgetClarification(pool, requestId, comments, req) {
  const user = userContext(req);
  const row = await ensureConfigState(pool);
  const draft = clonePayload(row.draft_payload);
  const request = findQueueRequest(draft, requestId);

  if (!request?.workflow_instance_id) {
    throw httpError("No workflow instance linked to this request.", 400);
  }

  await workflowService.submitClarification(
    pool,
    request.workflow_instance_id,
    comments,
    req
  );

  const updatedRequest = appendTimelineEntry(
    { ...request, status: request.current_approver ? `Pending ${request.current_approver}` : "Pending TA Lead" },
    "Clarification Submitted",
    user.name,
    comments
  );

  draft.approval_queue = draft.approval_queue.map((item) =>
    item.id === requestId ? updatedRequest : item
  );
  await persistDraft(pool, draft, user.name);

  await writeEnterpriseAudit(pool, {
    eventType: "ClarificationSubmitted",
    module: "Workforce Planning",
    entity: "Budget Request",
    entityId: requestId,
    action: "Clarification submitted on budget request",
    userName: user.name,
    userRole: user.role,
    metadata: { comments }
  });

  return {
    workforce: draft,
    toastMessage: "Clarification submitted. Workflow resumed."
  };
}

async function createRequisition(pool, positionId, req) {
  const user = userContext(req);
  const row = await ensureConfigState(pool);
  const draft = clonePayload(row.draft_payload);
  const position = draft.approved_positions.find((item) => item.id === positionId);

  if (!position) {
    throw httpError(`Approved position not found: ${positionId}`, 404);
  }

  const recruitmentService = require("./recruitmentService");
  const result = await recruitmentService.createFromApprovedPosition(pool, positionId, {}, req);

  draft.approved_positions = draft.approved_positions.map((item) =>
    item.id === positionId
      ? { ...item, requisitions_created: item.requisitions_created + 1 }
      : item
  );
  draft.meta.last_updated = nowIso();
  await persistDraft(pool, draft, user.name);

  await pool.query(
    `INSERT INTO wp_position_lifecycle (position_id, event_type, from_status, to_status, actor, metadata)
     VALUES ($1,'RequisitionCreated',$2,'Requisition Raised',$3,$4)`,
    [
      positionId,
      position.status,
      user.name,
      JSON.stringify({ requisitionId: result.requisitionId })
    ]
  );

  return {
    workforce: draft,
    position: result.requisition,
    requisitionId: result.requisitionId,
    approvedPosition: {
      id: positionId,
      department: position.department,
      position: position.position,
      grade: position.grade,
      headcount: position.headcount,
      budget_approved: position.budget_approved,
      requisitions_created: position.requisitions_created + 1,
      status: position.status,
      source_request_id: position.source_request_id
    },
    request: null,
    hiringProcessUpdate: result.hiringProcessUpdate,
    toastMessage: result.toastMessage
  };
}

async function publishBundle(pool, payload, req, reason = "") {
  const user = userContext(req);
  const row = await ensureConfigState(pool);
  const draft = payload || row.draft_payload;
  const nextVersion = Number((Number(row.version) + 0.1).toFixed(1));
  const now = new Date();

  draft.meta = { ...draft.meta, last_updated: now.toISOString() };

  await pool.query(
    `UPDATE wp_config_state
     SET draft_payload = $1, published_payload = $2, version = $3,
         version_status = 'Published', effective_from = $4, modified_by = $5, modified_on = NOW()
     WHERE id = 1`,
    [JSON.stringify(draft), JSON.stringify(draft), nextVersion, now, user.name]
  );

  await pool.query(
    `INSERT INTO wp_bundle_snapshots (version, status, payload, description, effective_from, created_by, reason)
     VALUES ($1,'Published',$2,$3,$4,$5,$6)`,
    [nextVersion, JSON.stringify(draft), reason || "Workforce plan published", now, user.name, reason || null]
  );

  await syncNormalizedTables(pool, draft, user.name, nextVersion, "Published");

  await writeEnterpriseAudit(pool, {
    eventType: "WorkforcePlanPublished",
    module: "Workforce Planning",
    entity: "Workforce Plan",
    entityId: "workforce-plan",
    action: "Workforce plan published",
    userName: user.name,
    userRole: user.role,
    metadata: { reason, version: nextVersion }
  });

  return buildBundle(await fetchConfigState(pool));
}

async function discardDraft(pool, req) {
  const user = userContext(req);
  const row = await ensureConfigState(pool);
  const published = clonePayload(row.published_payload);

  await pool.query(
    `UPDATE wp_config_state SET draft_payload = $1, modified_by = $2, modified_on = NOW() WHERE id = 1`,
    [JSON.stringify(published), user.name]
  );

  return buildBundle(await fetchConfigState(pool));
}

async function exportWorkforce(pool) {
  const bundle = await getWorkforceBundle(pool);
  return {
    exportedAt: new Date().toISOString(),
    version: bundle.version,
    payload: bundle.baseline
  };
}

async function previewImport(pool, payload) {
  const errors = [];
  if (!payload.meta?.fiscal_year) {
    errors.push("meta.fiscal_year is required.");
  }
  return {
    valid: errors.length === 0,
    errors,
    summary: {
      budgetRequests: (payload.budget_requests || []).length,
      approvedPositions: (payload.approved_positions || []).length
    }
  };
}

async function commitImport(pool, payload, req, reason = "") {
  const preview = await previewImport(pool, payload);
  if (!preview.valid) {
    throw httpError(preview.errors.join(" "), 400);
  }

  const user = userContext(req);
  await persistDraft(pool, clonePayload(payload), user.name);

  await writeEnterpriseAudit(pool, {
    eventType: "WorkforcePlanImported",
    module: "Workforce Planning",
    entity: "Workforce Plan",
    entityId: "workforce-plan",
    action: "Workforce plan import applied to draft",
    userName: user.name,
    userRole: user.role,
    metadata: { reason, ...preview.summary }
  });

  return { ...buildBundle(await fetchConfigState(pool)), importSummary: preview.summary };
}

async function seedConfiguration(pool, payload, user = { name: "System Seed", role: "Admin" }) {
  const seed = clonePayload(payload);

  await pool.query("DELETE FROM wp_config_state WHERE id = 1");
  await pool.query("DELETE FROM wp_bundle_snapshots");
  await pool.query("DELETE FROM wp_position_lifecycle");

  await pool.query(
    `INSERT INTO wp_config_state (
      id, draft_payload, published_payload, version, version_status,
      effective_from, created_by, modified_by
    ) VALUES (1, $1, $2, 1.0, 'Published', NOW(), $3, $3)`,
    [JSON.stringify(seed), JSON.stringify(seed), user.name]
  );

  await pool.query(
    `INSERT INTO wp_bundle_snapshots (version, status, payload, description, effective_from, created_by, reason)
     VALUES (1.0, 'Published', $1, 'Initial seed', NOW(), $2, 'Initial seed')`,
    [JSON.stringify(seed), user.name]
  );

  await syncNormalizedTables(pool, seed, user.name, 1.0, "Published");
}

module.exports = {
  getDefaultSeedPayload,
  getWorkforceBundle,
  approveBudgetRequest,
  rejectBudgetRequest,
  sendBackBudgetRequest,
  requestBudgetClarification,
  submitBudgetClarification,
  createRequisition,
  publishBundle,
  discardDraft,
  exportWorkforce,
  previewImport,
  commitImport,
  validateMasterDataReferences,
  evaluateBudgetRules,
  seedConfiguration,
  syncNormalizedTables
};
