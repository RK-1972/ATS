const businessRulesService = require("./businessRulesService");
const workflowService = require("./workflowService");
const masterDataService = require("./masterDataService");
const approvalRouteResolverService = require("./approvalRouteResolverService");
const approvalRouteRepository = require("../repositories/approvalRouteRepository");
const userPermissionRepository = require("../repositories/userPermissionRepository");
const workAssignmentService = require("./workAssignmentService");
const { writeEnterpriseAudit, userContext } = require("./enterpriseAuditService");

const SEED_PATH = require("path").join(__dirname, "..", "seed", "workforcePlanning.seed.json");
const RAISE_BUDGET_REQUEST_CODE = "RAISE_BUDGET_REQUEST";
const BUDGET_REQUESTOR_CODE = "BUDGET_REQUESTOR";
const BUDGET_PENDING_LEVEL_1_STATUS = "Pending Level-1 Approval";
const BUDGET_PENDING_LEVEL_2_STATUS = "Pending Level-2 Approval";

function isBudgetPendingLevel1(status) {
  const value = String(status || "").trim();
  return (
    value === BUDGET_PENDING_LEVEL_1_STATUS
    || value === "Pending TA Lead"
  );
}

function isBudgetPendingLevel2(status) {
  const value = String(status || "").trim();
  return (
    value === BUDGET_PENDING_LEVEL_2_STATUS
    || value === "Pending Finance"
  );
}

function resumeBudgetStatusAfterClarification(request) {
  const approver = String(request?.current_approver || "");
  if (
    isBudgetPendingLevel2(request?.status)
    || /level-2|finance/i.test(approver)
  ) {
    return BUDGET_PENDING_LEVEL_2_STATUS;
  }
  return BUDGET_PENDING_LEVEL_1_STATUS;
}

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

/**
 * Admins may always raise Budget Requests.
 * Other users require an active BUDGET_REQUESTOR Work Assignment.
 */
async function assertCanRaiseBudgetRequest(pool, req) {
  const roleName = String(req?.user?.role_name || "").trim();

  if (roleName === "Admin") {
    return;
  }

  const employeeCode = String(req?.user?.employee_code || "").trim();

  if (!employeeCode) {
    throw httpError(
      "Enterprise Access Denied. You are not authorized to raise Budget Requests.",
      403
    );
  }

  const assignments = await workAssignmentService.getEmployeeWorkAssignments(
    pool,
    employeeCode
  );

  const allowed = (assignments || []).some((row) => {
    if (row.is_active !== true) {
      return false;
    }

    if (row.master_is_active === false) {
      return false;
    }

    return (
      String(row.assignment_code || "").trim().toUpperCase() ===
      BUDGET_REQUESTOR_CODE
    );
  });

  if (!allowed) {
    throw httpError(
      "Enterprise Access Denied. You are not authorized to raise Budget Requests.",
      403
    );
  }
}

async function buildApprovalRouteSnapshot(pool, approvalRouteId) {
  const route = await approvalRouteRepository.getApprovalRoute(pool, approvalRouteId);

  if (!route) {
    throw httpError(`Approval route not found: ${approvalRouteId}`, 404);
  }

  const steps = await approvalRouteRepository.getApprovalRouteSteps(
    pool,
    approvalRouteId
  );

  return {
    route_id: route.route_id,
    route_name: route.route_name,
    applies_to: route.applies_to,
    status: route.status,
    effective_from: route.effective_from,
    max_approval_days: route.max_approval_days,
    frozen_on: new Date().toISOString(),
    steps: (steps || []).map((step) => ({
      step_id: step.step_id,
      step_no: step.step_no,
      sequence_no: step.sequence_no,
      approver_employee_code: step.approver_employee_code,
      approval_type: step.approval_type,
      comments_required: step.comments_required,
      allow_reject: step.allow_reject,
      allow_return: step.allow_return,
      stop_if_rejected: step.stop_if_rejected
    }))
  };
}

/**
 * Audit-only capture of the matching Approval Policy at submit time.
 * Does not change route resolution behaviour.
 */
async function buildApprovalPolicySnapshot(pool, documentType, criteria) {
  const matches = await approvalRouteRepository.findMatchingActivePolicies(
    pool,
    documentType,
    criteria
  );

  if (!matches.length) {
    return null;
  }

  // Prefer the single exact match; if multiple policies map to one route,
  // still capture the first for audit without changing routing.
  const policy = matches[0];

  return {
    policy_id: policy.policy_id,
    route_id: policy.route_id,
    route_name: policy.route_name,
    route_applies_to: policy.route_applies_to,
    department: policy.department,
    designation: policy.designation,
    grade: policy.grade,
    min_amount:
      policy.min_amount !== null && policy.min_amount !== undefined
        ? Number(policy.min_amount)
        : null,
    max_amount:
      policy.max_amount !== null && policy.max_amount !== undefined
        ? Number(policy.max_amount)
        : null,
    is_active: Boolean(policy.is_active),
    effective_from: policy.effective_from,
    effective_to: policy.effective_to,
    frozen_on: new Date().toISOString()
  };
}

/**
 * Lock the shared Workforce Planning config row for exclusive submit
 * (same FOR UPDATE pattern as Talent Demand draft submit).
 */
async function lockWorkforceConfigState(client) {
  await ensureConfigState(client);

  const locked = await client.query(
    `SELECT *
     FROM wp_config_state
     WHERE id = 1
     FOR UPDATE`
  );

  if (!locked.rows[0]) {
    throw httpError("Workforce Planning configuration state not found.", 500);
  }

  return locked.rows[0];
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
  const designations = await masterDataService.listByEntityType(pool, "designations");

  const departmentNames = new Set(departments.map((row) => row.name.toLowerCase()));
  const gradeCodes = new Set(grades.map((row) => row.code.toLowerCase()));
  const gradeNames = new Set(grades.map((row) => row.name.toLowerCase()));
  const designationNames = new Set(designations.map((row) => row.name.toLowerCase()));

  if (request.department && !departmentNames.has(request.department.toLowerCase())) {
    const partial = departments.find((row) =>
      row.name.toLowerCase().includes(request.department.toLowerCase())
      || request.department.toLowerCase().includes(row.name.toLowerCase())
    );
    if (!partial) {
      errors.push(`Department "${request.department}" not found in Master Data.`);
    }
  }

  if (request.position && !designationNames.has(request.position.toLowerCase())) {
    const partial = designations.find((row) =>
      row.name.toLowerCase().includes(request.position.toLowerCase())
      || request.position.toLowerCase().includes(row.name.toLowerCase())
    );
    if (!partial) {
      errors.push(`Position "${request.position}" not found in Master Data.`);
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
    nextApprover: requiresFinance
      ? "Level-2 Approver"
      : requiresLeadership
        ? "Level-1 Approver"
        : null
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

async function ensureWorkflowInstance(
  pool,
  request,
  req,
  approvalRouteId = null,
  routeSnapshot = null,
  policySnapshot = null
) {
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
        document_type: "BUDGET",
        budget_request_id: request.id,
        department: request.department,
        position_title: request.position,
        grade: request.grade,
        priority: request.priority || "Medium",
        requisition_id: request.id,
        approval_route_id: approvalRouteId,
        approval_route_snapshot: routeSnapshot || null,
        approval_policy_id: policySnapshot?.policy_id || null,
        approval_policy_snapshot: policySnapshot || null
      },
      department: request.department,
      grade: request.grade,
      approval_route_id: approvalRouteId,
      approval_route_snapshot: routeSnapshot || null,
      approval_policy_id: policySnapshot?.policy_id || null,
      approval_policy_snapshot: policySnapshot || null
    },
    req
  );

  return instance.instanceId;
}

function nextBudgetRequestId(draft) {
  const year = new Date().getFullYear();
  const pattern = new RegExp(`^BR-${year}-(\\d+)$`);
  let max = 1000;

  const collect = (items) => {
    (items || []).forEach((item) => {
      const match = String(item.id || "").match(pattern);
      if (match) {
        max = Math.max(max, Number(match[1]));
      }
    });
  };

  collect(draft.budget_requests);
  collect(draft.approval_queue);

  return `BR-${year}-${String(max + 1).padStart(4, "0")}`;
}

/**
 * Save a Budget Request draft into the existing WP draft model
 * (wp_config_state.draft_payload.budget_requests) only. No approval_queue
 * entry, no workflow, no normalized wp_* writes — those happen on Submit
 * (later step) and final approval respectively.
 */
async function createBudgetRequest(pool, payload, req) {
  await assertCanRaiseBudgetRequest(pool, req);

  const user = userContext(req);
  const row = await ensureConfigState(pool);
  const draft = clonePayload(row.draft_payload);

  const request = {
    department: String(payload.department || "").trim(),
    position: String(payload.position || "").trim(),
    grade: String(payload.grade || "").trim(),
    headcount: Number(payload.headcount) || 1,
    proposed_budget: Number(payload.proposed_budget) || 0,
    justification: String(payload.justification || "").trim(),
    priority: payload.priority || "Medium"
  };

  if (!request.department || !request.position) {
    throw httpError("Department and Position Title are required.", 400);
  }

  const mdValidation = await validateMasterDataReferences(pool, request);
  if (!mdValidation.valid) {
    throw httpError(mdValidation.errors.join(" "), 400);
  }

  const requestedId = String(payload.id || "").trim();
  let savedRequest;

  if (requestedId) {
    const existing = (draft.budget_requests || []).find(
      (item) => item.id === requestedId
    );

    if (!existing) {
      throw httpError(`Budget request not found: ${requestedId}`, 404);
    }
    const editableStatuses = new Set(["Draft", "Clarification Requested"]);
    if (!editableStatuses.has(existing.status)) {
      throw httpError(
        `Budget request ${requestedId} is ${existing.status} and can no longer be edited.`,
        400
      );
    }

    const nextStatus =
      existing.status === "Clarification Requested"
        ? "Clarification Requested"
        : "Draft";

    savedRequest = { ...existing, ...request, status: nextStatus };
    draft.budget_requests = draft.budget_requests.map((item) =>
      item.id === requestedId ? savedRequest : item
    );

    if (nextStatus === "Clarification Requested") {
      draft.approval_queue = (draft.approval_queue || []).map((item) =>
        item.id === requestedId
          ? { ...item, ...request, status: nextStatus }
          : item
      );
    }
  } else {
    savedRequest = {
      id: nextBudgetRequestId(draft),
      ...request,
      status: "Draft",
      submitted_by: null,
      submitted_on: null
    };
    draft.budget_requests = [savedRequest, ...(draft.budget_requests || [])];
  }

  draft.meta.last_updated = nowIso();
  await persistDraft(pool, draft, user.name);

  await writeEnterpriseAudit(pool, {
    eventType: "BudgetDraftSaved",
    module: "Workforce Planning",
    entity: "Budget Request",
    entityId: savedRequest.id,
    action: `Budget request draft saved for ${savedRequest.position}`,
    previousValue: requestedId ? "Draft" : null,
    newValue: "Draft",
    userName: user.name,
    userRole: user.role
  });

  return {
    workforce: draft,
    request: savedRequest,
    toastMessage: `Budget request ${savedRequest.id} saved as draft.`
  };
}

/**
 * Submit a Draft Budget Request into the approval queue.
 * Status → Pending Level-1 Approval; starts workflow instance;
 * resolves and freezes the matching Approval Route; expands Level-1 task;
 * later route steps remain Waiting until Level-1 completes.
 */
async function submitBudgetRequest(pool, requestId, req) {
  await assertCanRaiseBudgetRequest(pool, req);

  const user = userContext(req);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Serialize concurrent submits of any Budget against the shared WP state
    // (reuse Talent Demand FOR UPDATE submit pattern).
    const row = await lockWorkforceConfigState(client);
    const draft = clonePayload(row.draft_payload);

    const existing = (draft.budget_requests || []).find(
      (item) => item.id === requestId
    );

    if (!existing) {
      throw httpError(`Budget request not found: ${requestId}`, 404);
    }

    if (existing.status !== "Draft") {
      throw httpError(
        `Budget request ${requestId} has already been submitted. Current status: ${existing.status}.`,
        409
      );
    }

    if (existing.workflow_instance_id) {
      throw httpError(
        `Budget request ${requestId} already has a workflow instance and cannot be submitted again.`,
        409
      );
    }

    if (
      !existing.department
      || !existing.position
      || !existing.grade
      || !Number(existing.proposed_budget)
      || !String(existing.justification || "").trim()
      || !Number(existing.headcount)
    ) {
      throw httpError(
        "Budget request is incomplete. Save a complete Draft before submitting.",
        400
      );
    }

    const mdValidation = await validateMasterDataReferences(client, existing);
    if (!mdValidation.valid) {
      throw httpError(mdValidation.errors.join(" "), 400);
    }

    const resolveCriteria = {
      department: existing.department,
      designation: existing.position,
      grade: existing.grade,
      amount: existing.proposed_budget
    };

    const approvalRouteId =
      await approvalRouteResolverService.resolveApprovalRoute(
        client,
        "BUDGET",
        resolveCriteria
      );

    const approvalRouteSnapshot = await buildApprovalRouteSnapshot(
      client,
      approvalRouteId
    );

    const approvalPolicySnapshot = await buildApprovalPolicySnapshot(
      client,
      "BUDGET",
      resolveCriteria
    );

    const submittedOn = new Date().toISOString().slice(0, 10);
    const instanceId = await ensureWorkflowInstance(
      client,
      existing,
      req,
      approvalRouteId,
      approvalRouteSnapshot,
      approvalPolicySnapshot
    );

    const approvalTasks = await workflowService.createApprovalRouteWorkflowTasks(
      client,
      instanceId,
      approvalRouteId,
      {
        stageKey: "approval",
        assignedBy: req.user?.employee_code || user.name,
        requisitionCode: requestId
      }
    );

    const level1Step = (approvalRouteSnapshot.steps || [])[0] || null;
    const currentApprover =
      level1Step?.approver_employee_code || "Level-1 Approver";
    const requestorEmployeeCode =
      req.user?.employee_code || existing.submitted_by_employee_code || null;

    let queueItem = {
      id: existing.id,
      department: existing.department,
      position: existing.position,
      grade: existing.grade,
      headcount: existing.headcount || 1,
      proposed_budget: existing.proposed_budget || 0,
      justification: existing.justification || null,
      priority: existing.priority || "Medium",
      status: BUDGET_PENDING_LEVEL_1_STATUS,
      submitted_by: user.name,
      submitted_by_employee_code: requestorEmployeeCode,
      submitted_on: submittedOn,
      current_approver: currentApprover,
      approval_route_id: approvalRouteId,
      approval_route_snapshot: approvalRouteSnapshot,
      approval_policy_id: approvalPolicySnapshot?.policy_id || null,
      approval_policy_snapshot: approvalPolicySnapshot,
      workflow_instance_id: instanceId,
      timeline: Array.isArray(existing.timeline) ? existing.timeline : [],
      history: Array.isArray(existing.history) ? existing.history : []
    };

    queueItem = appendTimelineEntry(queueItem, "Submitted", user.name, null);

    draft.budget_requests = (draft.budget_requests || []).map((item) =>
      item.id === requestId
        ? {
            ...item,
            status: BUDGET_PENDING_LEVEL_1_STATUS,
            submitted_by: user.name,
            submitted_by_employee_code: requestorEmployeeCode,
            submitted_on: submittedOn,
            current_approver: currentApprover,
            approval_route_id: approvalRouteId,
            approval_route_snapshot: approvalRouteSnapshot,
            approval_policy_id: approvalPolicySnapshot?.policy_id || null,
            approval_policy_snapshot: approvalPolicySnapshot,
            workflow_instance_id: instanceId
          }
        : item
    );

    const queue = draft.approval_queue || [];
    const queueIndex = queue.findIndex((item) => item.id === requestId);
    if (queueIndex >= 0) {
      draft.approval_queue = queue.map((item, index) =>
        index === queueIndex ? queueItem : item
      );
    } else {
      draft.approval_queue = [queueItem, ...queue];
    }

    draft.meta.last_updated = nowIso();
    await persistDraft(client, draft, user.name);

    await writeEnterpriseAudit(client, {
      eventType: "BudgetSubmitted",
      module: "Workforce Planning",
      entity: "Budget Request",
      entityId: requestId,
      action: `Budget request submitted for Level-1 approval`,
      previousValue: "Draft",
      newValue: BUDGET_PENDING_LEVEL_1_STATUS,
      userName: user.name,
      userRole: user.role,
      metadata: {
        workflow_instance_id: instanceId,
        approval_route_id: approvalRouteId,
        approval_route_snapshot: approvalRouteSnapshot,
        approval_policy_id: approvalPolicySnapshot?.policy_id || null,
        approval_policy_snapshot: approvalPolicySnapshot,
        approval_task_count: approvalTasks.length
      }
    });

    await client.query("COMMIT");

    return {
      workforce: draft,
      request: queueItem,
      toastMessage: `Budget request ${requestId} submitted for Level-1 approval.`
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

function resolveBudgetWorkflowInstanceId(request, requestId) {
  return request?.workflow_instance_id || `WF-BR-${requestId}`;
}

async function findActiveBudgetApprovalTask(pool, requestId, instanceId) {
  const candidateIds = Array.from(
    new Set(
      [instanceId, `WF-BR-${requestId}`, requestId]
        .filter(Boolean)
        .map((value) => String(value))
    )
  );

  const result = await pool.query(
    `SELECT
       t.task_id,
       t.instance_id,
       t.title,
       t.status AS task_status,
       t.assignee,
       a.assignment_id,
       a.assignee AS assignment_assignee,
       a.active
     FROM wf_tasks t
     INNER JOIN wf_assignments a
       ON a.task_id = t.task_id
      AND a.active IS TRUE
     WHERE t.instance_id = ANY($1::text[])
       AND LOWER(TRIM(t.status)) = 'pending'
       AND LOWER(TRIM(COALESCE(t.task_type, 'approval'))) IN ('approval', 'approve')
     ORDER BY t.task_id ASC
     LIMIT 1`,
    [candidateIds]
  );

  if (!result.rows[0]) {
    throw httpError(
      `No active approval task found for Budget request ${requestId}.`,
      409
    );
  }

  return result.rows[0];
}

async function loadBudgetQueueRequest(pool, requestId) {
  const row = await ensureConfigState(pool);
  const draft = clonePayload(row.draft_payload);
  const request =
    findQueueRequest(draft, requestId)
    || (draft.budget_requests || []).find((item) => item.id === requestId);

  if (!request) {
    throw httpError(`Budget request not found: ${requestId}`, 404);
  }

  return { row, draft, request };
}

/**
 * Approve via Workflow Engine completeTask (activates L2 or final-completes).
 * Domain hook updates Budget status / Approved Position inside the same TX.
 */
async function approveBudgetRequest(pool, requestId, comment, req) {
  const { request } = await loadBudgetQueueRequest(pool, requestId);
  const instanceId = resolveBudgetWorkflowInstanceId(request, requestId);
  const task = await findActiveBudgetApprovalTask(pool, requestId, instanceId);

  const employeeCode = String(req.user?.employee_code || "").trim();
  const assignee = String(task.assignment_assignee || task.assignee || "").trim();
  if (!employeeCode || employeeCode !== assignee) {
    throw httpError(
      "Only the assigned approver may approve this Budget request.",
      403
    );
  }

  const result = await workflowService.completeTask(pool, task.task_id, req, {
    requireActiveAssignee: true,
    comments: comment || null
  });

  const bundle = await getWorkforceBundle(pool);
  const updated =
    bundle.config.approval_queue.find((item) => item.id === requestId)
    || bundle.config.budget_requests.find((item) => item.id === requestId);

  return {
    workforce: bundle.config,
    request: updated || request,
    workflowResult: result,
    approvedPosition: result?.businessAction?.approved_position_id
      ? { id: result.businessAction.approved_position_id }
      : null,
    toastMessage: result.workflowCompleted
      ? "Budget request approved."
      : "Budget approved at this level. Next approver activated."
  };
}

async function rejectBudgetRequest(pool, requestId, comment, req) {
  const clarificationComments = String(comment || "").trim();
  if (!clarificationComments) {
    throw httpError("Rejection comments are required.", 400);
  }

  const { request } = await loadBudgetQueueRequest(pool, requestId);
  const instanceId = resolveBudgetWorkflowInstanceId(request, requestId);
  const task = await findActiveBudgetApprovalTask(pool, requestId, instanceId);

  const employeeCode = String(req.user?.employee_code || "").trim();
  const assignee = String(task.assignment_assignee || task.assignee || "").trim();
  if (!employeeCode || employeeCode !== assignee) {
    throw httpError(
      "Only the assigned approver may reject this Budget request.",
      403
    );
  }

  const result = await workflowService.rejectMyActiveApproval(
    pool,
    task.task_id,
    clarificationComments,
    req
  );

  const bundle = await getWorkforceBundle(pool);
  const updated =
    bundle.config.approval_queue.find((item) => item.id === requestId)
    || bundle.config.budget_requests.find((item) => item.id === requestId);

  return {
    workforce: bundle.config,
    request: updated || request,
    workflowResult: result,
    toastMessage: "Budget request rejected."
  };
}

async function sendBackBudgetRequest(pool, requestId, comment, req) {
  return requestBudgetClarification(pool, requestId, comment, req);
}

async function requestBudgetClarification(pool, requestId, comments, req) {
  const clarificationComments = String(comments || "").trim();
  if (!clarificationComments) {
    throw httpError("Clarification comments are required.", 400);
  }

  const { request } = await loadBudgetQueueRequest(pool, requestId);
  const instanceId = resolveBudgetWorkflowInstanceId(request, requestId);
  const task = await findActiveBudgetApprovalTask(pool, requestId, instanceId);

  const employeeCode = String(req.user?.employee_code || "").trim();
  const assignee = String(task.assignment_assignee || task.assignee || "").trim();
  if (!employeeCode || employeeCode !== assignee) {
    throw httpError(
      "Only the assigned approver may request clarification.",
      403
    );
  }

  const result = await workflowService.requestClarificationMyActiveApproval(
    pool,
    task.task_id,
    clarificationComments,
    req
  );

  const bundle = await getWorkforceBundle(pool);
  return {
    workforce: bundle.config,
    workflowResult: result,
    toastMessage:
      result.toastMessage || "Clarification request sent. Workflow paused."
  };
}

async function submitBudgetClarification(pool, requestId, comments, req) {
  const { request } = await loadBudgetQueueRequest(pool, requestId);

  if (request.status !== "Clarification Requested") {
    throw httpError(
      `Budget request ${requestId} is not awaiting clarification.`,
      409
    );
  }

  const requestorCode = String(request.submitted_by_employee_code || "").trim();
  const actorCode = String(req.user?.employee_code || "").trim();
  const isAdmin = String(req.user?.role_name || "").toLowerCase() === "admin";
  if (requestorCode && actorCode && requestorCode !== actorCode && !isAdmin) {
    throw httpError(
      "Only the original requestor may resubmit clarification.",
      403
    );
  }

  if (!request.workflow_instance_id) {
    throw httpError("No workflow instance linked to this request.", 400);
  }

  const result = await workflowService.submitClarification(
    pool,
    request.workflow_instance_id,
    comments || "",
    req
  );

  const bundle = await getWorkforceBundle(pool);
  const updated =
    bundle.config.approval_queue.find((item) => item.id === requestId)
    || bundle.config.budget_requests.find((item) => item.id === requestId);

  return {
    workforce: bundle.config,
    request: updated || request,
    workflowResult: result,
    toastMessage:
      result.toastMessage || "Clarification submitted. Workflow resumed."
  };
}

async function getBudgetApprovalActionContext(pool, requestId, req) {
  const { request } = await loadBudgetQueueRequest(pool, requestId);
  const instanceId = resolveBudgetWorkflowInstanceId(request, requestId);
  const employeeCode = String(req.user?.employee_code || "").trim();

  let activeTask = null;
  try {
    activeTask = await findActiveBudgetApprovalTask(pool, requestId, instanceId);
  } catch (_error) {
    activeTask = null;
  }

  const assignee = String(
    activeTask?.assignment_assignee || activeTask?.assignee || ""
  ).trim();
  const canAct =
    Boolean(activeTask)
    && Boolean(employeeCode)
    && employeeCode === assignee
    && ["Pending Level-1 Approval", "Pending Level-2 Approval"].includes(
      request.status
    );

  const canResubmit =
    request.status === "Clarification Requested"
    && (
      !request.submitted_by_employee_code
      || String(request.submitted_by_employee_code) === employeeCode
      || String(req.user?.role_name || "").toLowerCase() === "admin"
    );

  return {
    request_id: requestId,
    status: request.status,
    workflow_instance_id: instanceId,
    task_id: activeTask?.task_id || null,
    assignee: assignee || request.current_approver || null,
    can_act: canAct,
    can_resubmit: canResubmit,
    is_read_only: !["Draft", "Clarification Requested"].includes(request.status)
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
  createBudgetRequest,
  submitBudgetRequest,
  approveBudgetRequest,
  rejectBudgetRequest,
  sendBackBudgetRequest,
  requestBudgetClarification,
  submitBudgetClarification,
  getBudgetApprovalActionContext,
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
