const businessRulesService = require("./businessRulesService");
const { writeEnterpriseAudit, userContext } = require("./enterpriseAuditService");
const approvalRouteRepository = require("../repositories/approvalRouteRepository");
const workflowDomainHooks = require("./workflowDomainHooks");

const SEED_PATH = require("path").join(__dirname, "..", "seed", "workflows.seed.json");

/** Canonical wf_tasks.status values (Workflow Engine convention). */
const TASK_STATUS = {
  PENDING: "Pending",
  WAITING: "Waiting",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
  /** Reuses existing stage clarification status string — no new invented label. */
  CLARIFICATION: "Waiting for Clarification"
};

/** Canonical wf_instances.status values already used by the engine. */
const INSTANCE_STATUS = {
  RUNNING: "Running",
  COMPLETED: "Completed",
  /** Same rejected terminal already used on approval stages via advanceWorkflow. */
  REJECTED: "Rejected",
  /** Pause state implied by existing clarification toast ("Workflow paused."). */
  PAUSED: "Paused"
};

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

function definitionToPlatformShape(definition) {
  const stages = definition.stages || [];

  return {
    key: definition.workflow_key,
    title: definition.title,
    description: definition.description,
    enabled: definition.enabled !== false,
    steps: stages.length,
    approvals: stages.filter((stage) => stage.is_approval_stage).length,
    status: definition.status || "Published",
    version: definition.version || definition.version_label || "1.0",
    sla_hours: definition.sla_hours || 24,
    stages: stages.map((stage) => stage.stage_name),
    approval_stages: stages
      .filter((stage) => stage.is_approval_stage)
      .map((stage) => stage.stage_name)
  };
}

function enrichDefinitionsPayload(payload) {
  const next = clonePayload(payload);
  next.workflows = (next.definitions || []).map(definitionToPlatformShape);
  return next;
}

async function fetchConfigState(pool) {
  const result = await pool.query("SELECT * FROM wf_config_state WHERE id = 1");
  return result.rows[0] || null;
}

async function fetchPrimaryInstance(pool, primaryInstanceId) {
  const result = await pool.query(
    "SELECT * FROM wf_instances WHERE instance_id = $1",
    [primaryInstanceId]
  );
  return result.rows[0] || null;
}

async function ensureConfigState(pool) {
  const existing = await fetchConfigState(pool);

  if (existing) {
    return existing;
  }

  const seed = enrichDefinitionsPayload(getDefaultSeedPayload());
  await pool.query(
    `INSERT INTO wf_config_state (
      id, draft_payload, published_payload, version, version_status,
      effective_from, created_by, modified_by
    ) VALUES (1, $1, $2, 1.0, 'Published', NOW(), 'System', 'System')`,
    [JSON.stringify(seed), JSON.stringify(seed)]
  );

  await syncNormalizedTables(pool, seed, "System", 1.0, "Published");
  return fetchConfigState(pool);
}

async function buildBundle(pool, row) {
  const draft = enrichDefinitionsPayload(row.draft_payload);
  const published = enrichDefinitionsPayload(row.published_payload);
  const primaryInstanceId = draft.primary_instance_id || published.primary_instance_id;
  let primaryInstance = null;

  if (primaryInstanceId) {
    const instanceRow = await fetchPrimaryInstance(pool, primaryInstanceId);

    if (instanceRow) {
      primaryInstance = {
        ...clonePayload(instanceRow.instance_payload),
        instanceId: instanceRow.instance_id,
        workflowCode: instanceRow.workflow_code,
        status: instanceRow.status,
        currentStageKey: instanceRow.current_stage_key
      };
    }
  }

  const instancesResult = await pool.query(
    `SELECT instance_id, workflow_code, status, current_stage_key, started_on, modified_on
     FROM wf_instances ORDER BY started_on DESC`
  );

  return {
    config: draft,
    baseline: published,
    workflows: draft.workflows,
    definitions: draft.definitions,
    instances: instancesResult.rows.map((item) => ({
      instanceId: item.instance_id,
      workflowCode: item.workflow_code,
      status: item.status,
      currentStageKey: item.current_stage_key,
      startedOn: item.started_on?.toISOString?.() || null,
      modifiedOn: item.modified_on?.toISOString?.() || null
    })),
    primaryInstance,
    isDirty: !configsEqual(draft, published),
    version: String(Number(row.version).toFixed(1)),
    versionStatus: row.version_status
  };
}

async function getWorkflowsBundle(pool) {
  const row = await ensureConfigState(pool);
  return buildBundle(pool, row);
}

async function persistDraft(pool, draft, userName) {
  const enriched = enrichDefinitionsPayload(draft);

  await pool.query(
    `UPDATE wf_config_state
     SET draft_payload = $1, modified_by = $2, modified_on = NOW()
     WHERE id = 1`,
    [JSON.stringify(enriched), userName]
  );

  return enriched;
}

function detectCircularDefinitions(definitions) {
  const cycles = [];

  definitions.forEach((definition) => {
    const graph = new Map();
    (definition.transitions || []).forEach((transition) => {
      if (!graph.has(transition.from_stage_key)) {
        graph.set(transition.from_stage_key, []);
      }
      graph.get(transition.from_stage_key).push(transition.to_stage_key);
    });

    const visiting = new Set();
    const visited = new Set();

    function dfs(node, path) {
      if (visiting.has(node)) {
        cycles.push([...path, node]);
        return;
      }
      if (visited.has(node)) {
        return;
      }
      visiting.add(node);
      (graph.get(node) || []).forEach((next) => dfs(next, [...path, node]));
      visiting.delete(node);
      visited.add(node);
    }

    graph.forEach((_value, node) => dfs(node, []));
  });

  return cycles;
}

function validateDefinitions(payload) {
  const errors = [];
  const warnings = [];
  const definitions = payload.definitions || [];
  const codes = new Set();
  const keys = new Set();

  definitions.forEach((definition) => {
    const code = definition.workflow_code;
    const key = definition.workflow_key;

    if (codes.has(code)) {
      errors.push(`Duplicate workflow code: ${code}`);
    }
    codes.add(code);

    if (keys.has(key)) {
      errors.push(`Duplicate workflow key: ${key}`);
    }
    keys.add(key);

    if (!definition.title?.trim()) {
      errors.push(`Workflow ${code} requires a title.`);
    }

    (definition.stages || []).forEach((stage, index) => {
      if (!stage.stage_key || !stage.stage_name) {
        errors.push(`Workflow ${code} has invalid stage at position ${index + 1}.`);
      }
    });

    (definition.transitions || []).forEach((transition) => {
      const stageKeys = new Set((definition.stages || []).map((stage) => stage.stage_key));
      if (!stageKeys.has(transition.from_stage_key) || !stageKeys.has(transition.to_stage_key)) {
        errors.push(
          `Workflow ${code} has transition referencing unknown stage (${transition.from_stage_key} -> ${transition.to_stage_key}).`
        );
      }
    });

    if ((definition.sla_hours || 0) <= 0) {
      warnings.push(`Workflow ${code} has non-positive SLA hours.`);
    }
  });

  const cycles = detectCircularDefinitions(definitions);
  if (cycles.length) {
    errors.push(`Circular workflow definition detected: ${cycles[0].join(" -> ")}`);
  }

  return { valid: errors.length === 0, errors, warnings };
}

async function syncNormalizedTables(queryable, payload, userName, version, versionStatus) {
  // Pool has no release(); PoolClient does. Join outer TX when already a client.
  const isClient = typeof queryable.release === "function";
  const client = isClient ? queryable : await queryable.connect();
  const manageTx = !isClient;

  try {
    if (manageTx) {
      await client.query("BEGIN");
    }
    const effectiveFrom = new Date();

    await client.query("DELETE FROM wf_transition_conditions");
    await client.query("DELETE FROM wf_stage_transitions");
    await client.query("DELETE FROM wf_stages");
    await client.query("DELETE FROM wf_sla_definitions");
    await client.query("DELETE FROM wf_escalation_policies");
    await client.query("DELETE FROM wf_versions");
    await client.query("DELETE FROM wf_definitions");

    for (const definition of payload.definitions || []) {
      await client.query(
        `INSERT INTO wf_definitions (
          workflow_code, workflow_key, title, description, category, enabled, status,
          version_label, version, version_status, sla_hours, effective_from, modified_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          definition.workflow_code,
          definition.workflow_key,
          definition.title,
          definition.description || null,
          definition.category || "Enterprise",
          definition.enabled !== false,
          definition.status || "Published",
          definition.version || "1.0",
          version,
          versionStatus,
          definition.sla_hours || 24,
          effectiveFrom,
          userName
        ]
      );

      for (const stage of definition.stages || []) {
        await client.query(
          `INSERT INTO wf_stages (
            workflow_code, stage_key, stage_name, sequence_order, is_approval_stage,
            sla_hours, responsible_role, version, version_status
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            definition.workflow_code,
            stage.stage_key,
            stage.stage_name,
            stage.sequence_order || 1,
            stage.is_approval_stage || false,
            stage.sla_hours || definition.sla_hours || 24,
            stage.responsible_role || null,
            version,
            versionStatus
          ]
        );

        await client.query(
          `INSERT INTO wf_sla_definitions (
            workflow_code, stage_key, sla_hours, escalation_policy_key, version, version_status
          ) VALUES ($1,$2,$3,$4,$5,$6)`,
          [
            definition.workflow_code,
            stage.stage_key,
            stage.sla_hours || definition.sla_hours || 24,
            `${definition.workflow_code}_${stage.stage_key}_escalation`,
            version,
            versionStatus
          ]
        );
      }

      for (const transition of definition.transitions || []) {
        const transitionResult = await client.query(
          `INSERT INTO wf_stage_transitions (
            workflow_code, from_stage_key, to_stage_key, action_name, requires_approval, version, version_status
          ) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING transition_id`,
          [
            definition.workflow_code,
            transition.from_stage_key,
            transition.to_stage_key,
            transition.action_name || "advance",
            transition.requires_approval || false,
            version,
            versionStatus
          ]
        );

        for (const condition of transition.conditions || []) {
          await client.query(
            `INSERT INTO wf_transition_conditions (transition_id, expression)
             VALUES ($1,$2)`,
            [transitionResult.rows[0].transition_id, condition]
          );
        }
      }

      await client.query(
        `INSERT INTO wf_escalation_policies (
          policy_key, workflow_code, escalate_after_hours, escalate_to_role, version, version_status
        ) VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          `${definition.workflow_code}_default_escalation`,
          definition.workflow_code,
          definition.sla_hours || 48,
          "Process Owner",
          version,
          versionStatus
        ]
      );

      await client.query(
        `INSERT INTO wf_versions (workflow_code, version_label, status, snapshot, changed_by, reason)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          definition.workflow_code,
          definition.version || "1.0",
          definition.status || "Published",
          JSON.stringify(definition),
          userName,
          "Synced on publish"
        ]
      );
    }

    if (manageTx) {
      await client.query("COMMIT");
    }
  } catch (error) {
    if (manageTx) {
      await client.query("ROLLBACK");
    }
    throw error;
  } finally {
    if (manageTx) {
      client.release();
    }
  }
}

function buildExecutionContext(instanceRow, extra = {}) {
  const payload = instanceRow.instance_payload || {};
  const context = {
    ...(instanceRow.execution_context || {}),
    ...extra,
    current_stage: instanceRow.current_stage_key,
    department: payload.meta?.department || extra.department,
    grade: payload.meta?.grade || extra.grade,
    location: extra.location || payload.meta?.location,
    offered_salary_lpa: payload.budget?.offered_ctc_lpa ?? extra.offered_salary_lpa,
    approved_budget_lpa: payload.budget?.approved_budget_lpa ?? extra.approved_budget_lpa,
    requisition: payload.meta?.requisition_id || extra.requisition,
    candidate: payload.meta?.candidate_name || extra.candidate,
    actor: extra.actor,
    actor_role: extra.actor_role
  };

  return context;
}

async function evaluateRulesOnTransition(pool, instanceRow, stageKey, context) {
  const executionContext = buildExecutionContext(instanceRow, context);
  const triggeredRules = [];
  const actions = [];
  const requiredApprovals = [];
  const notifications = [];
  const escalations = [];

  const bundle = await businessRulesService.getRulesBundle(pool);
  const activeRules = bundle.baseline.rules.filter((rule) => rule.status === "Active");
  const stage = (instanceRow.instance_payload?.stages || []).find((item) => item.key === stageKey);
  const stageRuleNames = stage?.business_rules || [];

  for (const rule of activeRules) {
    const shouldEvaluate =
      stageRuleNames.includes(rule.name) ||
      ["OFFER_ABOVE_BUDGET", "OFFER_APPROVAL_BASED_ON_GRADE"].includes(rule.rule_code);

    if (!shouldEvaluate) {
      continue;
    }

    const result = await businessRulesService.evaluateRule(
      pool,
      rule.rule_code || rule.id,
      executionContext
    );

    if (result.ruleMatched) {
      triggeredRules.push(rule.name);
      actions.push(...(result.actions || []));
      requiredApprovals.push(...(result.requiredApprovals || []));
      notifications.push(...(result.notifications || []));
      escalations.push(...(result.escalations || []));
    }
  }

  return {
    triggeredRules,
    actions,
    requiredApprovals: [...new Set(requiredApprovals)],
    notifications: [...new Set(notifications)],
    escalations: [...new Set(escalations)]
  };
}

async function appendHistory(pool, instanceId, entry) {
  await pool.query(
    `INSERT INTO wf_history (
      instance_id, event_type, stage_key, actor, actor_role, action, comments, metadata
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      instanceId,
      entry.eventType,
      entry.stageKey || null,
      entry.actor || null,
      entry.actorRole || null,
      entry.action,
      entry.comments || null,
      JSON.stringify(entry.metadata || {})
    ]
  );
}

async function persistInstance(pool, instanceRow, userName) {
  await pool.query(
    `UPDATE wf_instances
     SET status = $1,
         current_stage_key = $2,
         execution_context = $3,
         instance_payload = $4,
         modified_by = $5,
         modified_on = NOW(),
         completed_on = $6
     WHERE instance_id = $7`,
    [
      instanceRow.status,
      instanceRow.current_stage_key,
      JSON.stringify(instanceRow.execution_context || {}),
      JSON.stringify(instanceRow.instance_payload || {}),
      userName,
      instanceRow.completed_on || null,
      instanceRow.instance_id
    ]
  );
}

/**
 * @param {object} queryable - pg Pool or Client (shared TX handle)
 */
async function getInstanceById(queryable, instanceId) {
  const result = await queryable.query(
    "SELECT * FROM wf_instances WHERE instance_id = $1",
    [instanceId]
  );

  if (!result.rows.length) {
    return null;
  }

  const row = result.rows[0];
  return {
    instanceId: row.instance_id,
    workflowCode: row.workflow_code,
    status: row.status,
    currentStageKey: row.current_stage_key,
    executionContext: row.execution_context,
    payload: row.instance_payload,
    startedOn: row.started_on?.toISOString?.() || null,
    modifiedOn: row.modified_on?.toISOString?.() || null
  };
}

async function getCurrentTasks(pool, instanceId) {
  const result = await pool.query(
    `SELECT task_id, stage_key, task_type, title, status, assignee, assignee_role, due_at, completed_on
     FROM wf_tasks WHERE instance_id = $1 AND status <> 'Completed'
     ORDER BY created_on ASC`,
    [instanceId]
  );

  return result.rows.map((row) => ({
    taskId: row.task_id,
    stageKey: row.stage_key,
    taskType: row.task_type,
    title: row.title,
    status: row.status,
    assignee: row.assignee,
    assigneeRole: row.assignee_role,
    dueAt: row.due_at?.toISOString?.() || null,
    completedOn: row.completed_on?.toISOString?.() || null
  }));
}

function computeAgeDays(fromDate) {
  if (!fromDate) {
    return null;
  }

  const parsed = fromDate instanceof Date ? fromDate : new Date(fromDate);

  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return Math.max(0, Math.floor((Date.now() - parsed.getTime()) / (24 * 60 * 60 * 1000)));
}

function resolveAssigneeIdentity(req, options = {}) {
  const requireEmployeeCode = options.requireEmployeeCode !== false;
  const employeeCode = req.user?.employee_code
    ? String(req.user.employee_code).trim()
    : "";
  const fullName = req.user?.full_name
    ? String(req.user.full_name).trim()
    : "";

  if (requireEmployeeCode) {
    if (!employeeCode) {
      throw httpError(
        "Authenticated employee_code is required for workflow task actions.",
        401
      );
    }
    return { employeeCode, fullName };
  }

  if (!employeeCode && !fullName) {
    throw httpError("Unable to resolve current user for approvals.", 401);
  }

  return { employeeCode, fullName };
}

/**
 * Assert the caller is the active assignee of a Pending task.
 * Employee code is authoritative (no full_name ownership match).
 * Call only after the task row is locked (FOR UPDATE).
 */
async function assertActiveAssignee(queryable, taskId, req, options = {}) {
  const { employeeCode } = resolveAssigneeIdentity(req, {
    requireEmployeeCode: true
  });

  if (options.forUpdate) {
    await queryable.query(
      `SELECT assignment_id
       FROM wf_assignments
       WHERE task_id = $1
       FOR UPDATE`,
      [taskId]
    );
  }

  const result = await queryable.query(
    `SELECT
       a.assignment_id,
       a.assignee,
       a.active,
       t.task_id,
       t.instance_id,
       t.stage_key,
       t.status AS task_status
     FROM wf_assignments a
     INNER JOIN wf_tasks t ON t.task_id = a.task_id
     WHERE a.task_id = $1
       AND a.active = TRUE
       AND LOWER(t.status) = 'pending'
       AND a.assignee = $2
     LIMIT 1`,
    [taskId, employeeCode]
  );

  if (!result.rows.length) {
    throw httpError(
      "No active approval assignment found for this task and user.",
      403
    );
  }

  return result.rows[0];
}

function assertTaskStatusPending(task) {
  const status = String(task?.status || "");
  if (status.toLowerCase() !== "pending") {
    throw httpError(
      `Only Pending tasks may be actioned. Current status: ${status || "(empty)"}`,
      400
    );
  }
}

function assertInstanceRunning(instance) {
  const status = String(instance?.status || "");
  if (status !== INSTANCE_STATUS.RUNNING) {
    throw httpError(
      `Workflow instance must be Running. Current status: ${status || "(empty)"}`,
      400
    );
  }
}

/**
 * Ensure exactly one active assignment for a task (and none elsewhere on the instance).
 */
async function activateSingleAssignment(client, instanceId, taskId) {
  await client.query(
    `UPDATE wf_assignments a
     SET active = FALSE
     FROM wf_tasks t
     WHERE a.task_id = t.task_id
       AND t.instance_id = $1
       AND a.active = TRUE`,
    [instanceId]
  );

  const assignmentResult = await client.query(
    `SELECT assignment_id
     FROM wf_assignments
     WHERE task_id = $1
     ORDER BY assigned_on ASC, assignment_id ASC
     LIMIT 1
     FOR UPDATE`,
    [taskId]
  );

  if (!assignmentResult.rows.length) {
    return null;
  }

  const assignmentId = assignmentResult.rows[0].assignment_id;

  await client.query(
    `UPDATE wf_assignments
     SET active = TRUE
     WHERE assignment_id = $1`,
    [assignmentId]
  );

  return assignmentId;
}

/**
 * Active approval assignments for the logged-in user (wf_assignments.active = true).
 * Read-only; does not duplicate task rows — joins existing workflow tables.
 */
async function getMyActiveApprovals(pool, req) {
  const { employeeCode } = resolveAssigneeIdentity(req, {
    requireEmployeeCode: true
  });

  const result = await pool.query(
    `SELECT
       a.assignment_id,
       a.assignee,
       a.assignee_role,
       a.assigned_on,
       a.active,
       t.task_id,
       t.title AS task_title,
       t.status AS task_status,
       t.stage_key,
       t.task_type,
       t.created_on AS task_created_on,
       i.instance_id,
       i.workflow_code,
       i.status AS instance_status,
       i.current_stage_key,
       i.started_on,
       i.started_by,
       i.execution_context,
       r.requisition_code,
       r.position_title,
       r.hiring_manager,
       r.req_status,
       r.created_by AS document_requestor,
       r.created_on AS document_submitted_on,
       o.offer_id,
       o.candidate_name,
       o.business_unit,
       o.department AS offer_department,
       o.offered_ctc,
       o.expected_joining_date,
       o.variable_pay,
       o.variable_pay_frequency,
       o.joining_bonus,
       o.joining_bonus_frequency,
       o.hiring_manager AS offer_hiring_manager,
       d.priority_level,
       d.draft_id,
       d.draft_code
     FROM wf_assignments a
     INNER JOIN wf_tasks t ON t.task_id = a.task_id
     INNER JOIN wf_instances i ON i.instance_id = t.instance_id
     LEFT JOIN rm_requisitions r ON r.workflow_instance_id = i.instance_id
     LEFT JOIN om_offers o ON (
       o.workflow_instance_id = i.instance_id
       OR o.offer_id = NULLIF(BTRIM(i.execution_context #>> '{meta,offer_id}'), '')
     )
     LEFT JOIN td_draft_mstr d
       ON d.result_requisition_code = r.requisition_code
      AND d.is_deleted = FALSE
     WHERE a.active = TRUE
       AND LOWER(t.status) = 'pending'
       AND (
         i.status = $2
         OR (
           i.status = $3
           AND LOWER(COALESCE(t.task_type, '')) = 'clarification'
         )
       )
       AND a.assignee = $1
     ORDER BY COALESCE(a.assigned_on, t.created_on, i.started_on) ASC,
              t.task_id ASC`,
    [employeeCode, INSTANCE_STATUS.RUNNING, INSTANCE_STATUS.PAUSED]
  );

  return result.rows.map((row) => {
    const submittedOn =
      row.document_submitted_on || row.started_on || row.assigned_on || null;
    const ageAnchor = row.assigned_on || row.task_created_on || row.started_on;
    const rawContext = row.execution_context;
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
    const meta =
      context.meta && typeof context.meta === "object" ? context.meta : {};
    const priority =
      row.priority_level ||
      context.priority_level ||
      context.priority ||
      meta.priority ||
      null;

    const instanceId = String(row.instance_id || "");
    const metaDocumentType = String(meta.document_type || "")
      .trim()
      .toUpperCase();

    // Budget request id must NOT fall back to meta.requisition_id for Requisition
    // workflows (those also set requisition_id = REQ-…).
    const isBudgetDocument =
      metaDocumentType === "BUDGET" || instanceId.startsWith("WF-BR-");

    const budgetRequestId = isBudgetDocument
      ? meta.budget_request_id ||
        meta.requisition_id ||
        (instanceId.startsWith("WF-BR-")
          ? instanceId.replace(/^WF-BR-/, "")
          : null)
      : null;

    const isOfferDocument =
      metaDocumentType === "OFFER" ||
      String(row.workflow_code || "").toUpperCase() === "OFFER" ||
      Boolean(row.offer_id);

    const isRequisitionDocument =
      !isOfferDocument &&
      (metaDocumentType === "REQUISITION" ||
        instanceId.startsWith("WF-RM-") ||
        Boolean(row.requisition_code));

    const documentType = isBudgetDocument
      ? "BUDGET"
      : isOfferDocument
        ? "OFFER"
        : isRequisitionDocument
          ? "REQUISITION"
          : metaDocumentType || null;

    return {
      assignment_id: row.assignment_id,
      task_id: row.task_id,
      instance_id: row.instance_id,
      workflow_type: row.workflow_code,
      document_number:
        row.requisition_code ||
        (isBudgetDocument ? budgetRequestId : null) ||
        (isOfferDocument ? row.offer_id : null) ||
        row.instance_id,
      document_title:
        row.position_title ||
        meta.position_title ||
        row.task_title ||
        row.requisition_code ||
        "—",
      requestor: row.document_requestor || row.started_by || "—",
      current_approval_step: row.task_title || row.stage_key || "—",
      stage_key: row.stage_key,
      submitted_date: submittedOn?.toISOString?.() || submittedOn || null,
      priority: priority || "Normal",
      status: row.task_status || "Pending",
      age_days: computeAgeDays(ageAnchor),
      assignee: row.assignee,
      assignee_role: row.assignee_role,
      assigned_on: row.assigned_on?.toISOString?.() || null,
      instance_status: row.instance_status,
      requisition_code: row.requisition_code || null,
      draft_id: row.draft_id || null,
      draft_code: row.draft_code || null,
      hiring_manager: row.hiring_manager || row.offer_hiring_manager || null,
      req_status: row.req_status || null,
      document_type: documentType,
      task_type: row.task_type || null,
      candidateName:
        row.candidate_name ||
        meta.candidate_name ||
        meta.candidateName ||
        null,
      businessUnit:
        row.business_unit ||
        meta.business_unit ||
        meta.businessUnit ||
        null,
      department:
        row.offer_department ||
        meta.department ||
        context.department ||
        null,
      offeredCtc: (() => {
        if (row.offered_ctc != null && row.offered_ctc !== "") {
          return Number(row.offered_ctc);
        }
        if (meta.offered_ctc != null && meta.offered_ctc !== "") {
          return Number(meta.offered_ctc);
        }
        if (meta.offered_ctc_lpa != null && meta.offered_ctc_lpa !== "") {
          return Number(meta.offered_ctc_lpa) * 100000;
        }
        return null;
      })(),
      expectedJoiningDate:
        row.expected_joining_date?.toISOString?.()?.slice(0, 10) ||
        row.expected_joining_date ||
        null,
      variablePay: Number(row.variable_pay ?? 0),
      variablePayFrequency: row.variable_pay_frequency || null,
      joiningBonus: Number(row.joining_bonus ?? 0),
      joiningBonusFrequency: row.joining_bonus_frequency || null
    };
  });
}

/**
 * Approve via existing completeTask chain (activates next Waiting step or completes).
 * Assignee revalidation and Pending checks run inside completeTask's transaction.
 */
async function approveMyActiveApproval(pool, taskId, req) {
  return completeTask(pool, taskId, req, { requireActiveAssignee: true });
}

/**
 * Reject lifecycle — single ACID transaction.
 * Terminates the instance, completes the current task (outcome Rejected),
 * cancels remaining Waiting tasks, deactivates all assignments, and notifies
 * domain hooks. Does not activate the next approver.
 */
async function rejectMyActiveApproval(pool, taskId, comments, req) {
  const user = userContext(req);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // 1. Lock current task
    const taskResult = await client.query(
      "SELECT * FROM wf_tasks WHERE task_id = $1 FOR UPDATE",
      [taskId]
    );

    if (!taskResult.rows.length) {
      throw httpError(`Task not found: ${taskId}`, 404);
    }

    const task = taskResult.rows[0];

    assertTaskStatusPending(task);

    // 1b. Lock workflow instance
    const instanceResult = await client.query(
      "SELECT * FROM wf_instances WHERE instance_id = $1 FOR UPDATE",
      [task.instance_id]
    );

    if (!instanceResult.rows.length) {
      throw httpError(`Workflow instance not found: ${task.instance_id}`, 404);
    }

    const instance = instanceResult.rows[0];
    const instanceStatus = String(instance.status || "");

    assertInstanceRunning(instance);

    // Re-validate active assignee under the same locks (employee_code authoritative)
    await assertActiveAssignee(client, taskId, req, { forUpdate: true });

    // 2. Mark current task Completed (outcome = Rejected in history/audit)
    await client.query(
      `UPDATE wf_tasks
       SET status = $2, completed_on = NOW()
       WHERE task_id = $1`,
      [taskId, TASK_STATUS.COMPLETED]
    );

    // 3. Deactivate current assignment(s)
    await client.query(
      `UPDATE wf_assignments
       SET active = FALSE
       WHERE task_id = $1
         AND active = TRUE`,
      [taskId]
    );

    // 4. Cancel every remaining Waiting task
    const waitingResult = await client.query(
      `SELECT task_id, stage_key, status
       FROM wf_tasks
       WHERE instance_id = $1
         AND task_id <> $2
         AND LOWER(status) = 'waiting'
       ORDER BY created_on ASC, task_id ASC
       FOR UPDATE`,
      [task.instance_id, taskId]
    );

    const cancelledTaskIds = waitingResult.rows.map((row) => row.task_id);

    if (cancelledTaskIds.length > 0) {
      await client.query(
        `UPDATE wf_tasks
         SET status = $2, completed_on = NOW()
         WHERE task_id = ANY($1::int[])`,
        [cancelledTaskIds, TASK_STATUS.CANCELLED]
      );
    }

    // 5. Deactivate every remaining assignment for this instance
    await client.query(
      `UPDATE wf_assignments a
       SET active = FALSE
       FROM wf_tasks t
       WHERE a.task_id = t.task_id
         AND t.instance_id = $1
         AND a.active = TRUE`,
      [task.instance_id]
    );

    // 6. Terminate instance (canonical Rejected — same string as approval stage reject)
    const payload = clonePayload(instance.instance_payload || {});
    const stage =
      (payload.stages || []).find((item) => item.key === task.stage_key) ||
      (payload.stages || []).find(
        (item) => item.key === instance.current_stage_key
      );

    if (stage) {
      stage.status = "Rejected";
      stage.completion_pct = 0;
    }

    if (!Array.isArray(payload.timeline)) {
      payload.timeline = [];
    }

    payload.timeline.push({
      id: `tl-${Date.now()}`,
      time: new Date().toISOString(),
      actor: user.name,
      role: user.role,
      action: "Approval Rejected",
      event_type: "rejected",
      stage_key: task.stage_key,
      comment: comments || null,
      outcome: "Rejected"
    });

    await client.query(
      `UPDATE wf_instances
       SET status = $2,
           instance_payload = $3,
           completed_on = NOW(),
           modified_by = $4,
           modified_on = NOW()
       WHERE instance_id = $1`,
      [
        task.instance_id,
        INSTANCE_STATUS.REJECTED,
        JSON.stringify(payload),
        user.name
      ]
    );

    // 9. Workflow history (single TaskRejected + optional cancel summary + WorkflowRejected)
    await appendHistory(client, task.instance_id, {
      eventType: "TaskRejected",
      stageKey: task.stage_key,
      actor: user.name,
      actorRole: user.role,
      action: "Approval rejected",
      comments: comments || "",
      metadata: {
        taskId,
        outcome: "Rejected",
        previousStatus: task.status
      }
    });

    if (cancelledTaskIds.length > 0) {
      await appendHistory(client, task.instance_id, {
        eventType: "TasksCancelled",
        stageKey: task.stage_key,
        actor: user.name,
        actorRole: user.role,
        action: "Remaining waiting approval tasks cancelled",
        comments: comments || "",
        metadata: {
          cancelledTaskIds,
          outcome: "Cancelled",
          rejectedTaskId: taskId
        }
      });
    }

    await appendHistory(client, task.instance_id, {
      eventType: "WorkflowRejected",
      stageKey: task.stage_key,
      actor: user.name,
      actorRole: user.role,
      action: "Workflow terminated after rejection",
      comments: comments || "",
      metadata: {
        rejectedTaskId: taskId,
        cancelledTaskIds,
        outcome: "Rejected",
        instanceStatus: INSTANCE_STATUS.REJECTED
      }
    });

    // 7. Notify existing workflow domain hook (reject path)
    const businessAction = await workflowDomainHooks.notifyWorkflowRejected(
      client,
      {
        instanceId: task.instance_id,
        workflowCode: instance.workflow_code,
        rejectedByTaskId: taskId,
        cancelledTaskIds,
        comments: comments || "",
        executionContext: instance.execution_context || {},
        instancePayload: payload
      },
      req
    );

    // 10. Enterprise audit
    await writeEnterpriseAudit(client, {
      eventType: "WorkflowRejected",
      module: "Workflow Engine",
      entity: "Workflow Instance",
      entityId: String(task.instance_id),
      action: "Workflow rejected and terminated",
      userName: user.name,
      userRole: user.role,
      previousValue: instanceStatus,
      newValue: INSTANCE_STATUS.REJECTED,
      metadata: {
        taskId,
        outcome: "Rejected",
        cancelledTaskIds,
        comments: comments || "",
        businessActionCompleted: Boolean(
          businessAction?.businessActionCompleted
        )
      }
    });

    await client.query("COMMIT");

    return {
      taskId,
      status: TASK_STATUS.COMPLETED,
      outcome: "Rejected",
      instanceId: task.instance_id,
      instanceStatus: INSTANCE_STATUS.REJECTED,
      cancelledTaskIds,
      workflowRejected: true,
      businessActionCompleted: Boolean(
        businessAction?.businessActionCompleted
      ),
      businessAction: businessAction || null
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (_rollbackError) {
      // Preserve original error
    }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Clarification request lifecycle — single ACID transaction.
 * Pauses the instance, holds the same Pending task, deactivates assignment.
 * Approver cannot approve while paused (assignment inactive + non-Pending task).
 */
async function requestClarificationMyActiveApproval(pool, taskId, comments, req) {
  const user = userContext(req);
  const clarificationComments = String(comments || "").trim();

  if (!clarificationComments) {
    throw httpError("Clarification comments are required.", 400);
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // 1. Lock workflow task
    const taskResult = await client.query(
      "SELECT * FROM wf_tasks WHERE task_id = $1 FOR UPDATE",
      [taskId]
    );

    if (!taskResult.rows.length) {
      throw httpError(`Task not found: ${taskId}`, 404);
    }

    const task = taskResult.rows[0];

    assertTaskStatusPending(task);

    // Lock instance before assignee revalidation
    const instanceResult = await client.query(
      "SELECT * FROM wf_instances WHERE instance_id = $1 FOR UPDATE",
      [task.instance_id]
    );

    if (!instanceResult.rows.length) {
      throw httpError(`Workflow instance not found: ${task.instance_id}`, 404);
    }

    const instance = instanceResult.rows[0];
    const instanceStatus = String(instance.status || "");

    assertInstanceRunning(instance);

    // Revalidate active assignee after locks (employee_code authoritative)
    const assignment = await assertActiveAssignee(client, taskId, req, {
      forUpdate: true
    });

    // 4. Update task status to existing clarification status
    await client.query(
      `UPDATE wf_tasks
       SET status = $2, completed_on = NULL
       WHERE task_id = $1`,
      [taskId, TASK_STATUS.CLARIFICATION]
    );

    // 5. Deactivate the current assignment (same row — do not create another)
    await client.query(
      `UPDATE wf_assignments
       SET active = FALSE
       WHERE assignment_id = $1
         AND active = TRUE`,
      [assignment.assignment_id]
    );

    await client.query(
      `UPDATE wf_assignments
       SET active = FALSE
       WHERE task_id = $1
         AND active = TRUE`,
      [taskId]
    );

    // 6. Pause workflow instance + store clarification hold (comments + ids)
    const payload = clonePayload(instance.instance_payload || {});
    const stageKey = task.stage_key || instance.current_stage_key;
    const stage = (payload.stages || []).find((item) => item.key === stageKey);

    if (stage) {
      stage.status = "Waiting for Clarification";
    }

    if (!Array.isArray(payload.timeline)) {
      payload.timeline = [];
    }

    payload.timeline.push({
      id: `tl-${Date.now()}`,
      time: new Date().toISOString(),
      actor: user.name,
      role: user.role,
      action: "Requested Clarification",
      event_type: "clarification",
      comment: clarificationComments,
      stage_key: stageKey,
      task_id: taskId
    });

    const priorContext =
      instance.execution_context && typeof instance.execution_context === "object"
        ? instance.execution_context
        : typeof instance.execution_context === "string"
          ? (() => {
              try {
                return JSON.parse(instance.execution_context);
              } catch {
                return {};
              }
            })()
          : {};

    const nextContext = {
      ...priorContext,
      clarification: {
        status: "requested",
        task_id: taskId,
        assignment_id: assignment.assignment_id,
        stage_key: stageKey,
        comments: clarificationComments,
        requested_by: user.name,
        requested_by_role: user.role,
        requested_on: new Date().toISOString()
      }
    };

    await client.query(
      `UPDATE wf_instances
       SET status = $2,
           execution_context = $3,
           instance_payload = $4,
           modified_by = $5,
           modified_on = NOW()
       WHERE instance_id = $1`,
      [
        task.instance_id,
        INSTANCE_STATUS.PAUSED,
        JSON.stringify(nextContext),
        JSON.stringify(payload),
        user.name
      ]
    );

    // 7–9. History + audit (comments stored)
    await appendHistory(client, task.instance_id, {
      eventType: "ClarificationRequested",
      stageKey,
      actor: user.name,
      actorRole: user.role,
      action: "Clarification requested — workflow paused",
      comments: clarificationComments,
      metadata: {
        taskId,
        assignmentId: assignment.assignment_id,
        taskStatus: TASK_STATUS.CLARIFICATION,
        instanceStatus: INSTANCE_STATUS.PAUSED
      }
    });

    await writeEnterpriseAudit(client, {
      eventType: "ClarificationRequested",
      module: "Workflow Engine",
      entity: "Workflow Instance",
      entityId: String(task.instance_id),
      action: "Clarification requested — workflow paused",
      userName: user.name,
      userRole: user.role,
      previousValue: instanceStatus,
      newValue: INSTANCE_STATUS.PAUSED,
      metadata: {
        taskId,
        assignmentId: assignment.assignment_id,
        comments: clarificationComments,
        stageKey
      }
    });

    let requestorTaskId = null;
    const domainClarification = await workflowDomainHooks.notifyClarificationRequested(
      client,
      {
        instanceId: task.instance_id,
        workflowCode: instance.workflow_code,
        taskId,
        assignmentId: assignment.assignment_id,
        comments: clarificationComments,
        executionContext: nextContext,
        instancePayload: payload
      },
      req
    );

    // Budget: create clarification task for original requestor (My Approvals inbox).
    if (
      domainClarification?.businessActionCompleted
      && domainClarification.requestor_employee_code
    ) {
      const clarificationTitle = domainClarification.budget_request_id
        ? `Clarify Budget — ${domainClarification.budget_request_id}`
        : domainClarification.requisition_code
          ? `Clarify Requisition — ${domainClarification.requisition_code}`
          : `Clarify — ${task.instance_id}`;

      requestorTaskId = await createTask(client, task.instance_id, {
        stageKey: stageKey || "clarification",
        taskType: "clarification",
        title: clarificationTitle,
        status: TASK_STATUS.PENDING,
        assignee: domainClarification.requestor_employee_code,
        assigneeRole: "Requestor",
        assignedBy: req.user?.employee_code || user.name,
        assignmentActive: true
      });

      nextContext.clarification = {
        ...nextContext.clarification,
        requestor_task_id: requestorTaskId,
        requestor_employee_code: domainClarification.requestor_employee_code,
        resume_status: domainClarification.resume_status || null
      };

      await client.query(
        `UPDATE wf_instances
         SET execution_context = $2,
             modified_by = $3,
             modified_on = NOW()
         WHERE instance_id = $1`,
        [task.instance_id, JSON.stringify(nextContext), user.name]
      );
    }

    await client.query("COMMIT");

    return {
      taskId,
      assignmentId: assignment.assignment_id,
      instanceId: task.instance_id,
      taskStatus: TASK_STATUS.CLARIFICATION,
      instanceStatus: INSTANCE_STATUS.PAUSED,
      comments: clarificationComments,
      workflowPaused: true,
      requestorTaskId,
      businessActionCompleted: Boolean(
        domainClarification?.businessActionCompleted
      ),
      toastMessage: "Clarification request sent. Workflow paused."
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (_rollbackError) {
      // Preserve original error
    }
    throw error;
  } finally {
    client.release();
  }
}

async function createTask(pool, instanceId, task) {
  const result = await pool.query(
    `INSERT INTO wf_tasks (
      instance_id, stage_key, task_type, title, status, assignee, assignee_role, due_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING task_id`,
    [
      instanceId,
      task.stageKey,
      task.taskType || "approval",
      task.title,
      task.status || TASK_STATUS.PENDING,
      task.assignee || null,
      task.assigneeRole || null,
      task.dueAt ? new Date(task.dueAt) : null
    ]
  );

  if (task.assignee) {
    // Map enterprise ACTIVE/WAITING assignment states onto existing active boolean
    // (no schema change): ACTIVE => true, WAITING => false.
    const assignmentActive =
      task.assignmentActive === undefined
        ? true
        : Boolean(task.assignmentActive);

    await pool.query(
      `INSERT INTO wf_assignments (
         task_id, assignee, assignee_role, assigned_by, active
       ) VALUES ($1,$2,$3,$4,$5)`,
      [
        result.rows[0].task_id,
        task.assignee,
        task.assigneeRole || null,
        task.assignedBy || "System",
        assignmentActive
      ]
    );
  }

  return result.rows[0].task_id;
}

/**
 * Expand approval_route_step rows into workflow tasks/assignments.
 * Step 1 => task Pending + assignment ACTIVE (active=true)
 * Later steps => task Waiting + assignment WAITING (active=false)
 * No notifications. Must run on the same queryable/client as Submit TX.
 *
 * @param {object} queryable - pg Pool or Client
 * @param {string} instanceId
 * @param {string|number} approvalRouteId
 * @param {object} [options]
 * @returns {Promise<object[]>}
 */
async function createApprovalRouteWorkflowTasks(
  queryable,
  instanceId,
  approvalRouteId,
  options = {}
) {
  if (!instanceId) {
    throw httpError(
      "workflow instanceId is required for approval route expansion.",
      400
    );
  }

  if (
    approvalRouteId === null ||
    approvalRouteId === undefined ||
    String(approvalRouteId).trim() === ""
  ) {
    throw httpError(
      "approval_route_id is required for approval route expansion.",
      400
    );
  }

  // Idempotent expansion (Talent Demand / Budget concurrent submit safety):
  // if route-step tasks already exist for this instance, return them.
  const existingRouteTasks = await queryable.query(
    `SELECT
       t.task_id,
       t.status AS task_status,
       t.title,
       t.assignee,
       t.assignee_role,
       COALESCE(a.active, FALSE) AS assignment_active
     FROM wf_tasks t
     LEFT JOIN wf_assignments a ON a.task_id = t.task_id
     WHERE t.instance_id = $1
       AND t.task_type = 'approval'
       AND t.title LIKE 'Approval Step %'
     ORDER BY t.task_id ASC`,
    [instanceId]
  );

  if (existingRouteTasks.rows.length > 0) {
    return existingRouteTasks.rows.map((row, index) => ({
      task_id: row.task_id,
      step_id: null,
      sequence_no: index + 1,
      task_status: row.task_status,
      assignment_status: row.assignment_active ? "ACTIVE" : "WAITING",
      assignee: row.assignee,
      reused: true
    }));
  }

  const steps = await approvalRouteRepository.getApprovalRouteSteps(
    queryable,
    approvalRouteId
  );

  if (!steps.length) {
    throw httpError("Approval route has no steps to expand.", 400);
  }

  const stageKey = options.stageKey || options.currentStageKey || "approval";
  const assignedBy = options.assignedBy || "System";
  const requisitionCode = options.requisitionCode || null;
  const created = [];

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    const isFirst = index === 0;
    const sequence = step.sequence_no ?? step.step_no ?? index + 1;
    const assignee = step.approver_employee_code
      ? String(step.approver_employee_code).trim()
      : "";

    if (!assignee) {
      throw httpError(
        `Approval route step ${sequence} has no approver_employee_code.`,
        400
      );
    }

    const taskStatus = isFirst ? TASK_STATUS.PENDING : TASK_STATUS.WAITING;
    const assignmentActive = isFirst;

    const taskId = await createTask(queryable, instanceId, {
      stageKey,
      taskType: "approval",
      title: requisitionCode
        ? `Approval Step ${sequence} — ${requisitionCode}`
        : `Approval Step ${sequence}`,
      status: taskStatus,
      assignee,
      assigneeRole: step.approval_type || "Approver",
      assignedBy,
      assignmentActive
    });

    created.push({
      task_id: taskId,
      step_id: step.step_id,
      sequence_no: sequence,
      task_status: taskStatus,
      assignment_status: isFirst ? "ACTIVE" : "WAITING",
      assignee
    });
  }

  return created;
}

/**
 * @param {object} queryable - pg Pool or Client (shared TX handle)
 */
async function startWorkflow(queryable, workflowCode, executionContext, req) {
  const user = userContext(req);
  const bundle = await getWorkflowsBundle(queryable);
  const definition = (bundle.baseline.definitions || []).find(
    (item) => item.workflow_code === workflowCode || item.workflow_key === workflowCode
  );

  if (!definition) {
    throw httpError(`Workflow definition not found: ${workflowCode}`, 404);
  }

  if (definition.status === "Archived") {
    throw httpError(`Workflow ${workflowCode} is archived.`, 400);
  }

  const instanceId = executionContext.instance_id || `WF-${Date.now()}`;
  const firstStage = (definition.stages || [])[0];
  const instancePayload = executionContext.instance_payload || {
    meta: {
      process_id: instanceId,
      environment: "Production",
      ...executionContext.meta
    },
    stages: (definition.stages || []).map((stage) => ({
      key: stage.stage_key,
      name: stage.stage_name,
      status: stage.sequence_order === 1 ? "In Progress" : "Pending",
      owner: user.name,
      responsible_role: stage.responsible_role || "Process Owner",
      sla_hours: stage.sla_hours || definition.sla_hours || 24,
      sla_remaining_hours: stage.sla_hours || definition.sla_hours || 24,
      completion_pct: stage.sequence_order === 1 ? 10 : 0,
      is_approval_stage: stage.is_approval_stage || false,
      business_rules: [],
      workflow: definition.title,
      notifications: [],
      audit_summary: `Stage ${stage.stage_name} initialized`
    })),
    timeline: [],
    kpis: {
      active_hiring_processes: 1,
      pending_approvals: 0,
      clarification_requests: 0,
      budget_exceptions: 0,
      avg_approval_sla_hours: definition.sla_hours || 24,
      avg_time_to_hire_days: 0,
      recruiter_workload: 0
    }
  };
const existing = await queryable.query(
  "SELECT * FROM wf_instances WHERE instance_id = $1",
  [instanceId]
);

if (existing.rows.length > 0) {
  return getInstanceById(queryable, instanceId);
}
  await queryable.query(
    `INSERT INTO wf_instances (
      instance_id, workflow_code, status, current_stage_key, execution_context,
      instance_payload, started_by, modified_by
    ) VALUES ($1,$2,'Running',$3,$4,$5,$6,$6)`,
    [
      instanceId,
      definition.workflow_code,
      firstStage?.stage_key || null,
      JSON.stringify(executionContext),
      JSON.stringify(instancePayload),
      user.name
    ]
  );

  if (firstStage?.is_approval_stage) {
    await createTask(queryable, instanceId, {
      stageKey: firstStage.stage_key,
      taskType: "approval",
      title: `${firstStage.stage_name} approval`,
      assigneeRole: firstStage.responsible_role || "Approver",
      assignedBy: user.name
    });
  }

  await appendHistory(queryable, instanceId, {
    eventType: "WorkflowStarted",
    stageKey: firstStage?.stage_key,
    actor: user.name,
    actorRole: user.role,
    action: `Workflow ${definition.title} started`
  });

  await writeEnterpriseAudit(queryable, {
    eventType: "WorkflowStarted",
    module: "Workflow Engine",
    entity: "Workflow Instance",
    entityId: instanceId,
    action: `Workflow started: ${definition.title}`,
    userName: user.name,
    userRole: user.role,
    metadata: { workflowCode: definition.workflow_code }
  });

  return getInstanceById(queryable, instanceId);
}

async function advanceWorkflow(pool, instanceId, action, executionContext, req) {
  const user = userContext(req);
  const result = await pool.query(
    "SELECT * FROM wf_instances WHERE instance_id = $1",
    [instanceId]
  );

  if (!result.rows.length) {
    throw httpError(`Workflow instance not found: ${instanceId}`, 404);
  }

  const row = result.rows[0];
  const payload = clonePayload(row.instance_payload);
  const stageKey = executionContext.stageKey || executionContext.stage_key || row.current_stage_key;
  const stage = payload.stages?.find((item) => item.key === stageKey);

  if (!stage) {
    throw httpError(`Stage not found: ${stageKey}`, 404);
  }

  const normalizedAction = String(action || "advance").toLowerCase();

  if (normalizedAction === "approve" && stage.is_approval_stage) {
    stage.status = "Completed";
    stage.completion_pct = 100;
    stage.sla_remaining_hours = 0;
  } else if (normalizedAction === "reject" && stage.is_approval_stage) {
    stage.status = "Rejected";
    stage.completion_pct = 0;
  } else if (normalizedAction === "advance") {
    stage.status = "Completed";
    stage.completion_pct = 100;
  }

  const ruleEvaluation = await evaluateRulesOnTransition(pool, row, stageKey, {
    ...executionContext,
    actor: user.name,
    actor_role: user.role
  });

  if (ruleEvaluation.triggeredRules.length) {
    stage.business_rules = [...new Set([...(stage.business_rules || []), ...ruleEvaluation.triggeredRules])];
  }

  const timelineEvent = {
    id: `tl-${Date.now()}`,
    time: new Date().toISOString(),
    actor: user.name,
    role: user.role,
    action: `${normalizedAction} — ${stage.name}`,
    event_type: normalizedAction === "approve"
      ? "approved"
      : normalizedAction === "reject"
        ? "rejected"
        : "submitted",
    stage_key: stageKey,
    comment: executionContext.comments || executionContext.comment || null
  };

  payload.timeline = [...(payload.timeline || []), timelineEvent];

  const currentIndex = payload.stages.findIndex((item) => item.key === stageKey);
  let nextStageKey = row.current_stage_key;

  if (["approve", "advance"].includes(normalizedAction)) {
    const nextStage = payload.stages.slice(currentIndex + 1).find((item) => item.status === "Pending");

    if (nextStage) {
      nextStage.status = "In Progress";
      nextStage.completion_pct = Math.max(nextStage.completion_pct || 0, 20);
      nextStageKey = nextStage.key;
    }
  }

  const nextRow = {
    instance_id: instanceId,
    status: payload.stages.every((item) => item.status === "Completed") ? "Completed" : "Running",
    current_stage_key: nextStageKey,
    execution_context: {
      ...(row.execution_context || {}),
      ...executionContext,
      current_stage: nextStageKey
    },
    instance_payload: payload,
    completed_on: payload.stages.every((item) => item.status === "Completed")
      ? new Date().toISOString()
      : null
  };

  await persistInstance(pool, nextRow, user.name);

  await appendHistory(pool, instanceId, {
    eventType: normalizedAction === "approve" ? "WorkflowAdvanced" : "StageChanged",
    stageKey,
    actor: user.name,
    actorRole: user.role,
    action: timelineEvent.action,
    metadata: { ruleEvaluation }
  });

  await writeEnterpriseAudit(pool, {
    eventType: normalizedAction === "approve" ? "WorkflowAdvanced" : "StageChanged",
    module: "Workflow Engine",
    entity: "Workflow Instance",
    entityId: instanceId,
    action: timelineEvent.action,
    userName: user.name,
    userRole: user.role,
    metadata: { stageKey, ruleEvaluation }
  });

  if (nextRow.status === "Completed") {
    await writeEnterpriseAudit(pool, {
      eventType: "WorkflowCompleted",
      module: "Workflow Engine",
      entity: "Workflow Instance",
      entityId: instanceId,
      action: "Workflow completed",
      userName: user.name,
      userRole: user.role
    });
  }

  return {
    instance: await getInstanceById(pool, instanceId),
    hiringProcess: {
      ...payload,
      instanceId,
      workflowCode: row.workflow_code,
      currentStageKey: nextStageKey
    },
    ruleEvaluation,
    toastMessage: `${stage.name} ${normalizedAction}${normalizedAction.endsWith("e") ? "d" : "ed"}.`
  };
}

async function requestClarification(pool, instanceId, comments, req) {
  const user = userContext(req);
  const row = await pool.query("SELECT * FROM wf_instances WHERE instance_id = $1", [instanceId]);

  if (!row.rows.length) {
    throw httpError(`Workflow instance not found: ${instanceId}`, 404);
  }

  const instance = row.rows[0];
  const stageKey = instance.current_stage_key;
  const payload = clonePayload(instance.instance_payload);
  const stage = payload.stages.find((item) => item.key === stageKey);

  if (stage) {
    stage.status = "Waiting for Clarification";
  }

  payload.timeline.push({
    id: `tl-${Date.now()}`,
    time: new Date().toISOString(),
    actor: user.name,
    role: user.role,
    action: "Requested Clarification",
    event_type: "clarification",
    comment: comments,
    stage_key: stageKey
  });

  await persistInstance(pool, {
    instance_id: instanceId,
    status: instance.status,
    current_stage_key: stageKey,
    execution_context: instance.execution_context,
    instance_payload: payload
  }, user.name);

  await appendHistory(pool, instanceId, {
    eventType: "ClarificationRequested",
    stageKey,
    actor: user.name,
    actorRole: user.role,
    action: "Clarification requested",
    comments
  });

  await writeEnterpriseAudit(pool, {
    eventType: "ClarificationRequested",
    module: "Workflow Engine",
    entity: "Workflow Instance",
    entityId: instanceId,
    action: "Clarification requested",
    userName: user.name,
    userRole: user.role,
    metadata: { comments, stageKey }
  });

  return {
    hiringProcess: payload,
    toastMessage: "Clarification request sent. Workflow paused."
  };
}

async function submitClarification(pool, instanceId, comments, req) {
  const user = userContext(req);
  const clarificationComments = String(comments || "").trim();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Peek without FOR UPDATE to choose lock order: task → instance (matches approve/reject).
    const peekResult = await client.query(
      `SELECT status, execution_context
       FROM wf_instances
       WHERE instance_id = $1`,
      [instanceId]
    );

    if (!peekResult.rows.length) {
      throw httpError(`Workflow instance not found: ${instanceId}`, 404);
    }

    const peekRow = peekResult.rows[0];
    const peekContext =
      peekRow.execution_context && typeof peekRow.execution_context === "object"
        ? peekRow.execution_context
        : typeof peekRow.execution_context === "string"
          ? (() => {
              try {
                return JSON.parse(peekRow.execution_context);
              } catch {
                return {};
              }
            })()
          : {};
    const peekHold = peekContext.clarification || null;
    const peekHasTaskHold =
      String(peekRow.status || "") === INSTANCE_STATUS.PAUSED &&
      peekHold &&
      peekHold.task_id;

    if (peekHasTaskHold) {
      const peekTaskId = Number(peekHold.task_id);
      await client.query(
        "SELECT task_id FROM wf_tasks WHERE task_id = $1 FOR UPDATE",
        [peekTaskId]
      );
    }

    // 1. Lock workflow instance
    const instanceResult = await client.query(
      "SELECT * FROM wf_instances WHERE instance_id = $1 FOR UPDATE",
      [instanceId]
    );

    if (!instanceResult.rows.length) {
      throw httpError(`Workflow instance not found: ${instanceId}`, 404);
    }

    const instance = instanceResult.rows[0];
    const instanceStatus = String(instance.status || "");
    const priorContext =
      instance.execution_context && typeof instance.execution_context === "object"
        ? instance.execution_context
        : typeof instance.execution_context === "string"
          ? (() => {
              try {
                return JSON.parse(instance.execution_context);
              } catch {
                return {};
              }
            })()
          : {};

    const clarificationHold = priorContext.clarification || null;

    if (
      instanceStatus === INSTANCE_STATUS.PAUSED &&
      !(clarificationHold && clarificationHold.task_id)
    ) {
      throw httpError(
        `Workflow instance ${instanceId} is paused but has no clarification hold to resume.`,
        400
      );
    }

    const hasTaskHold =
      clarificationHold &&
      clarificationHold.task_id &&
      instanceStatus === INSTANCE_STATUS.PAUSED;

    // Legacy instance-only clarification (offers / workforce without task hold)
    if (!hasTaskHold) {
      const stageKey = instance.current_stage_key;
      const payload = clonePayload(instance.instance_payload || {});
      const stage = (payload.stages || []).find((item) => item.key === stageKey);

      if (stage) {
        stage.status = "Clarification Submitted";
        stage.completion_pct = Math.max(stage.completion_pct || 0, 30);
      }

      if (!Array.isArray(payload.timeline)) {
        payload.timeline = [];
      }

      payload.timeline.push({
        id: `tl-${Date.now()}`,
        time: new Date().toISOString(),
        actor: user.name,
        role: user.role,
        action: "Clarification Submitted",
        event_type: "clarification",
        comment: clarificationComments || null,
        stage_key: stageKey
      });

      await persistInstance(
        client,
        {
          instance_id: instanceId,
          status: instance.status,
          current_stage_key: stageKey,
          execution_context: instance.execution_context,
          instance_payload: payload
        },
        user.name
      );

      await appendHistory(client, instanceId, {
        eventType: "ClarificationSubmitted",
        stageKey,
        actor: user.name,
        actorRole: user.role,
        action: "Clarification submitted",
        comments: clarificationComments || ""
      });

      await writeEnterpriseAudit(client, {
        eventType: "ClarificationSubmitted",
        module: "Workflow Engine",
        entity: "Workflow Instance",
        entityId: instanceId,
        action: "Clarification submitted",
        userName: user.name,
        userRole: user.role,
        metadata: { comments: clarificationComments || "", stageKey }
      });

      await client.query("COMMIT");

      return {
        hiringProcess: payload,
        stage,
        toastMessage: "Clarification submitted. Workflow resumed."
      };
    }

    // 2. Verify workflow is paused (task-hold resume path)
    if (instanceStatus !== INSTANCE_STATUS.PAUSED) {
      throw httpError(
        `Workflow instance ${instanceId} is not paused for clarification.`,
        400
      );
    }

    const heldTaskId = Number(clarificationHold.task_id);
    const heldAssignmentId = clarificationHold.assignment_id
      ? Number(clarificationHold.assignment_id)
      : null;

    // 3. Lock and restore the same approval task (do NOT create a new task)
    // Note: instance already locked; task lock acquired second — see remaining risks for lock-order.
    const taskResult = await client.query(
      "SELECT * FROM wf_tasks WHERE task_id = $1 FOR UPDATE",
      [heldTaskId]
    );

    if (!taskResult.rows.length) {
      throw httpError(`Clarification task not found: ${heldTaskId}`, 404);
    }

    const task = taskResult.rows[0];

    if (String(task.instance_id) !== String(instanceId)) {
      throw httpError("Clarification task does not belong to this workflow instance.", 400);
    }

    // Re-read hold under instance lock to prevent stale resume
    const lockedContext =
      instance.execution_context && typeof instance.execution_context === "object"
        ? instance.execution_context
        : {};
    const lockedHold = lockedContext.clarification || clarificationHold;

    if (!lockedHold || Number(lockedHold.task_id) !== heldTaskId) {
      throw httpError(
        `Stale clarification hold for workflow instance ${instanceId}.`,
        409
      );
    }

    if (String(instance.status) !== INSTANCE_STATUS.PAUSED) {
      throw httpError(
        `Workflow instance ${instanceId} is not paused for clarification.`,
        400
      );
    }

    if (String(task.status) !== TASK_STATUS.CLARIFICATION) {
      throw httpError(
        `Clarification task ${heldTaskId} is not held for clarification. Current status: ${task.status}`,
        400
      );
    }

    // 5. Task returns to Pending
    await client.query(
      `UPDATE wf_tasks
       SET status = $2, completed_on = NULL
       WHERE task_id = $1`,
      [heldTaskId, TASK_STATUS.PENDING]
    );

    // 4. Reactivate previous assignment — exactly one active on the instance
    if (heldAssignmentId) {
      const assignmentResult = await client.query(
        `SELECT assignment_id
         FROM wf_assignments
         WHERE assignment_id = $1
           AND task_id = $2
         FOR UPDATE`,
        [heldAssignmentId, heldTaskId]
      );

      if (!assignmentResult.rows.length) {
        throw httpError(
          `Clarification assignment ${heldAssignmentId} not found for task ${heldTaskId}.`,
          404
        );
      }

      await client.query(
        `UPDATE wf_assignments a
         SET active = FALSE
         FROM wf_tasks t
         WHERE a.task_id = t.task_id
           AND t.instance_id = $1
           AND a.active = TRUE`,
        [instanceId]
      );

      await client.query(
        `UPDATE wf_assignments
         SET active = TRUE
         WHERE assignment_id = $1
           AND task_id = $2`,
        [heldAssignmentId, heldTaskId]
      );
    }

    let reactivatedAssignmentId = heldAssignmentId;

    if (!reactivatedAssignmentId) {
      reactivatedAssignmentId = await activateSingleAssignment(
        client,
        instanceId,
        heldTaskId
      );
    }

    if (!reactivatedAssignmentId) {
      throw httpError(
        `No assignment found to reactivate for task ${heldTaskId}.`,
        400
      );
    }

    const payload = clonePayload(instance.instance_payload || {});
    const stageKey =
      clarificationHold.stage_key || task.stage_key || instance.current_stage_key;
    const stage = (payload.stages || []).find((item) => item.key === stageKey);

    if (stage) {
      stage.status = "In Progress";
      stage.completion_pct = Math.max(stage.completion_pct || 0, 30);
    }

    if (!Array.isArray(payload.timeline)) {
      payload.timeline = [];
    }

    payload.timeline.push({
      id: `tl-${Date.now()}`,
      time: new Date().toISOString(),
      actor: user.name,
      role: user.role,
      action: "Clarification Submitted",
      event_type: "clarification",
      comment: clarificationComments || null,
      stage_key: stageKey,
      task_id: heldTaskId
    });

    const {
      clarification: _clearedHold,
      ...contextWithoutHold
    } = priorContext;

    const nextContext = {
      ...contextWithoutHold,
      clarification_history: [
        ...((priorContext.clarification_history || [])),
        {
          ...clarificationHold,
          status: "submitted",
          response_comments: clarificationComments || "",
          submitted_by: user.name,
          submitted_by_role: user.role,
          submitted_on: new Date().toISOString()
        }
      ]
    };

    // 6. Workflow returns to Running
    await client.query(
      `UPDATE wf_instances
       SET status = $2,
           execution_context = $3,
           instance_payload = $4,
           modified_by = $5,
           modified_on = NOW()
       WHERE instance_id = $1`,
      [
        instanceId,
        INSTANCE_STATUS.RUNNING,
        JSON.stringify(nextContext),
        JSON.stringify(payload),
        user.name
      ]
    );

    // 7–8. History + audit
    await appendHistory(client, instanceId, {
      eventType: "ClarificationSubmitted",
      stageKey,
      actor: user.name,
      actorRole: user.role,
      action: "Clarification submitted — workflow resumed",
      comments: clarificationComments || "",
      metadata: {
        taskId: heldTaskId,
        assignmentId: reactivatedAssignmentId,
        taskStatus: TASK_STATUS.PENDING,
        instanceStatus: INSTANCE_STATUS.RUNNING,
        requestComments: clarificationHold.comments || ""
      }
    });

    await writeEnterpriseAudit(client, {
      eventType: "ClarificationSubmitted",
      module: "Workflow Engine",
      entity: "Workflow Instance",
      entityId: String(instanceId),
      action: "Clarification submitted — workflow resumed",
      userName: user.name,
      userRole: user.role,
      previousValue: INSTANCE_STATUS.PAUSED,
      newValue: INSTANCE_STATUS.RUNNING,
      metadata: {
        taskId: heldTaskId,
        assignmentId: reactivatedAssignmentId,
        comments: clarificationComments || "",
        stageKey
      }
    });

    // Complete any requestor clarification tasks created for Budget pause.
    const requestorTaskId = clarificationHold.requestor_task_id
      ? Number(clarificationHold.requestor_task_id)
      : null;

    if (requestorTaskId) {
      await client.query(
        `UPDATE wf_tasks
         SET status = $2, completed_on = NOW()
         WHERE task_id = $1
           AND instance_id = $3`,
        [requestorTaskId, TASK_STATUS.COMPLETED, instanceId]
      );
      await client.query(
        `UPDATE wf_assignments
         SET active = FALSE
         WHERE task_id = $1`,
        [requestorTaskId]
      );
    } else {
      await client.query(
        `UPDATE wf_tasks
         SET status = $2, completed_on = NOW()
         WHERE instance_id = $1
           AND task_type = 'clarification'
           AND LOWER(status) = 'pending'`,
        [instanceId, TASK_STATUS.COMPLETED]
      );
      await client.query(
        `UPDATE wf_assignments a
         SET active = FALSE
         FROM wf_tasks t
         WHERE a.task_id = t.task_id
           AND t.instance_id = $1
           AND t.task_type = 'clarification'`,
        [instanceId]
      );
    }

    // Ensure only the restored approval assignment remains active.
    await client.query(
      `UPDATE wf_assignments a
       SET active = FALSE
       FROM wf_tasks t
       WHERE a.task_id = t.task_id
         AND t.instance_id = $1
         AND a.active = TRUE
         AND a.assignment_id <> $2`,
      [instanceId, reactivatedAssignmentId]
    );

    const assigneeResult = await client.query(
      `SELECT assignee FROM wf_assignments WHERE assignment_id = $1`,
      [reactivatedAssignmentId]
    );

    const reactivatedAssigneeName =
      assigneeResult.rows[0]?.assignee || task.assignee || null;

    await appendHistory(client, instanceId, {
      eventType: "ClarificationResumed",
      stageKey,
      actor: reactivatedAssigneeName || user.name,
      actorRole: task.assignee_role || "Approver",
      action: "Approval returned to current approver",
      comments: null,
      metadata: {
        taskId: heldTaskId,
        assignmentId: reactivatedAssignmentId,
        taskStatus: TASK_STATUS.PENDING,
        instanceStatus: INSTANCE_STATUS.RUNNING
      }
    });

    const domainResume = await workflowDomainHooks.notifyClarificationSubmitted(
      client,
      {
        instanceId,
        workflowCode: instance.workflow_code,
        comments: clarificationComments || "",
        reactivatedTaskId: heldTaskId,
        reactivatedAssignmentId,
        reactivatedAssignee: assigneeResult.rows[0]?.assignee || task.assignee || null,
        executionContext: {
          ...nextContext,
          meta: {
            ...((priorContext.meta && typeof priorContext.meta === "object")
              ? priorContext.meta
              : {}),
            ...((nextContext.meta && typeof nextContext.meta === "object")
              ? nextContext.meta
              : {})
          }
        },
        instancePayload: payload
      },
      req
    );

    await client.query("COMMIT");

    return {
      hiringProcess: payload,
      stage,
      taskId: heldTaskId,
      assignmentId: reactivatedAssignmentId,
      instanceId,
      taskStatus: TASK_STATUS.PENDING,
      instanceStatus: INSTANCE_STATUS.RUNNING,
      workflowResumed: true,
      businessActionCompleted: Boolean(domainResume?.businessActionCompleted),
      toastMessage: "Clarification submitted. Workflow resumed."
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (_rollbackError) {
      // Preserve original error
    }
    throw error;
  } finally {
    client.release();
  }
}

async function completeTask(queryable, taskId, req, options = {}) {
  const user = userContext(req);
  const requireActiveAssignee = Boolean(options.requireActiveAssignee);
  const isClient = typeof queryable.release === "function";
  const client = isClient ? queryable : await queryable.connect();
  const manageTx = !isClient;

  try {
    if (manageTx) {
      await client.query("BEGIN");
    }

    // Lock order: task → instance (consistent with reject / clarification request)
    const taskResult = await client.query(
      "SELECT * FROM wf_tasks WHERE task_id = $1 FOR UPDATE",
      [taskId]
    );

    if (!taskResult.rows.length) {
      throw httpError(`Task not found: ${taskId}`, 404);
    }

    const task = taskResult.rows[0];

    // Pending-only completion — Waiting / Clarification / Completed / Cancelled never complete
    assertTaskStatusPending(task);

    const instanceResult = await client.query(
      "SELECT * FROM wf_instances WHERE instance_id = $1 FOR UPDATE",
      [task.instance_id]
    );

    if (!instanceResult.rows.length) {
      throw httpError(`Workflow instance not found: ${task.instance_id}`, 404);
    }

    const instance = instanceResult.rows[0];
    assertInstanceRunning(instance);

    // Revalidate assignee after locks when called from My Approvals approve
    if (requireActiveAssignee) {
      await assertActiveAssignee(client, taskId, req, { forUpdate: true });
    }

    // 1. Mark current task Completed
    await client.query(
      `UPDATE wf_tasks
       SET status = $2, completed_on = NOW()
       WHERE task_id = $1
         AND LOWER(status) = 'pending'`,
      [taskId, TASK_STATUS.COMPLETED]
    );

    // 2. Deactivate current assignment(s)
    await client.query(
      `UPDATE wf_assignments
       SET active = FALSE
       WHERE task_id = $1`,
      [taskId]
    );

    await appendHistory(client, task.instance_id, {
      eventType: "TaskCompleted",
      stageKey: task.stage_key,
      actor: user.name,
      actorRole: user.role,
      action: "Task Completed",
      metadata: { taskId, previousStatus: task.status }
    });

    // 3. Locate next Waiting task (creation order); accept legacy WAITING casing
    const nextResult = await client.query(
      `SELECT *
       FROM wf_tasks
       WHERE instance_id = $1
         AND task_id <> $2
         AND LOWER(status) = 'waiting'
       ORDER BY created_on ASC, task_id ASC
       LIMIT 1
       FOR UPDATE`,
      [task.instance_id, taskId]
    );

    let activatedTaskId = null;
    let activatedAssignmentId = null;
    let workflowCompleted = false;
    let businessAction = {
      businessActionCompleted: false
    };

    if (nextResult.rows.length > 0) {
      const nextTask = nextResult.rows[0];

      // 4. Activate next task → Pending
      await client.query(
        `UPDATE wf_tasks
         SET status = $2, completed_on = NULL
         WHERE task_id = $1`,
        [nextTask.task_id, TASK_STATUS.PENDING]
      );

      // 5. Exactly one active assignment on the instance
      activatedAssignmentId = await activateSingleAssignment(
        client,
        task.instance_id,
        nextTask.task_id
      );

      activatedTaskId = nextTask.task_id;

      // 6. History — Task Activated
      await appendHistory(client, task.instance_id, {
        eventType: "TaskActivated",
        stageKey: nextTask.stage_key,
        actor: user.name,
        actorRole: user.role,
        action: "Task Activated",
        metadata: {
          taskId: nextTask.task_id,
          assignmentId: activatedAssignmentId,
          previousStatus: nextTask.status,
          activatedFromTaskId: taskId
        }
      });

      const activatedAssigneeResult = await client.query(
        `SELECT assignee
         FROM wf_assignments
         WHERE assignment_id = $1`,
        [activatedAssignmentId]
      );

      businessAction = await workflowDomainHooks.notifyApprovalStepActivated(
        client,
        {
          instanceId: task.instance_id,
          workflowCode: instance.workflow_code,
          completedByTaskId: taskId,
          activatedTaskId: nextTask.task_id,
          activatedAssignmentId,
          activatedAssignee: activatedAssigneeResult.rows[0]?.assignee || nextTask.assignee || null,
          comments: options.comments || null,
          executionContext: instance.execution_context || {},
          instancePayload: instance.instance_payload || {}
        },
        req
      );
    } else {
      // Ensure no lingering active assignments when workflow completes
      await client.query(
        `UPDATE wf_assignments a
         SET active = FALSE
         FROM wf_tasks t
         WHERE a.task_id = t.task_id
           AND t.instance_id = $1
           AND a.active = TRUE`,
        [task.instance_id]
      );

      // 7. No waiting task — complete workflow instance
      await client.query(
        `UPDATE wf_instances
         SET status = $2,
             completed_on = NOW(),
             modified_by = $3,
             modified_on = NOW()
         WHERE instance_id = $1`,
        [task.instance_id, INSTANCE_STATUS.COMPLETED, user.name]
      );

      workflowCompleted = true;

      await appendHistory(client, task.instance_id, {
        eventType: "WorkflowCompleted",
        stageKey: task.stage_key,
        actor: user.name,
        actorRole: user.role,
        action: "Workflow Completed",
        metadata: { completedByTaskId: taskId }
      });
    }

    // Notify domain modules on final completion (same TX).
    if (workflowCompleted) {
      const completedInstanceResult = await client.query(
        `SELECT instance_id, workflow_code, execution_context, instance_payload
         FROM wf_instances
         WHERE instance_id = $1`,
        [task.instance_id]
      );
      const instanceRow = completedInstanceResult.rows[0] || {};

      businessAction = await workflowDomainHooks.notifyWorkflowCompleted(
        client,
        {
          instanceId: task.instance_id,
          workflowCode: instanceRow.workflow_code,
          completedByTaskId: taskId,
          comments: options.comments || null,
          executionContext: instanceRow.execution_context || {},
          instancePayload: instanceRow.instance_payload || {}
        },
        req
      );
    }

    await writeEnterpriseAudit(client, {
      eventType: workflowCompleted ? "WorkflowCompleted" : "TaskCompleted",
      module: "Workflow Engine",
      entity: "Workflow Task",
      entityId: String(taskId),
      action: workflowCompleted
        ? "Task completed; workflow completed"
        : "Task completed; next approval task activated",
      userName: user.name,
      userRole: user.role,
      metadata: {
        taskId,
        activatedTaskId,
        activatedAssignmentId,
        workflowCompleted,
        instanceId: task.instance_id,
        businessActionCompleted: Boolean(
          businessAction?.businessActionCompleted
        )
      }
    });

    if (manageTx) {
      await client.query("COMMIT");
    }

    return {
      taskId,
      status: TASK_STATUS.COMPLETED,
      activatedTaskId,
      activatedAssignmentId,
      workflowCompleted,
      businessActionCompleted: Boolean(
        businessAction?.businessActionCompleted
      ),
      businessAction: businessAction || null,
      instanceId: task.instance_id
    };
  } catch (error) {
    if (manageTx) {
      try {
        await client.query("ROLLBACK");
      } catch (_rollbackError) {
        // Preserve original error
      }
    }
    throw error;
  } finally {
    if (manageTx) {
      client.release();
    }
  }
}

async function reassignTask(pool, taskId, assignee, req, assigneeRole = null) {
  const user = userContext(req);
  const nextAssignee = assignee ? String(assignee).trim() : "";

  if (!nextAssignee) {
    throw httpError("assignee is required for reassignment.", 400);
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const taskResult = await client.query(
      "SELECT * FROM wf_tasks WHERE task_id = $1 FOR UPDATE",
      [taskId]
    );

    if (!taskResult.rows.length) {
      throw httpError(`Task not found: ${taskId}`, 404);
    }

    const task = taskResult.rows[0];

    await client.query(
      "SELECT * FROM wf_instances WHERE instance_id = $1 FOR UPDATE",
      [task.instance_id]
    );

    await client.query(
      `UPDATE wf_tasks SET assignee = $1, assignee_role = $2 WHERE task_id = $3`,
      [nextAssignee, assigneeRole, taskId]
    );

    await client.query(
      `UPDATE wf_assignments a
       SET active = FALSE
       FROM wf_tasks t
       WHERE a.task_id = t.task_id
         AND t.instance_id = $1
         AND a.active = TRUE`,
      [task.instance_id]
    );

    const insertResult = await client.query(
      `INSERT INTO wf_assignments (task_id, assignee, assignee_role, assigned_by, active)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING assignment_id`,
      [
        taskId,
        nextAssignee,
        assigneeRole,
        user.name,
        String(task.status).toLowerCase() === "pending"
      ]
    );

    await writeEnterpriseAudit(client, {
      eventType: "TaskReassigned",
      module: "Workflow Engine",
      entity: "Workflow Task",
      entityId: String(taskId),
      action: `Task reassigned to ${nextAssignee}`,
      userName: user.name,
      userRole: user.role,
      metadata: {
        assignmentId: insertResult.rows[0]?.assignment_id || null,
        previousAssignee: task.assignee || null
      }
    });

    await client.query("COMMIT");

    return {
      taskId,
      assignee: nextAssignee,
      assigneeRole,
      status: task.status,
      assignmentId: insertResult.rows[0]?.assignment_id || null
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (_rollbackError) {
      // Preserve original error
    }
    throw error;
  } finally {
    client.release();
  }
}

async function publishBundle(pool, payload, req, reason = "") {
  const user = userContext(req);
  const row = await ensureConfigState(pool);
  const draft = enrichDefinitionsPayload(payload || row.draft_payload);
  const validation = validateDefinitions(draft);

  if (!validation.valid) {
    throw httpError(validation.errors.join(" "), 400);
  }

  const nextVersion = Number((Number(row.version) + 0.1).toFixed(1));
  const now = new Date();
  const published = clonePayload(draft);
  published.meta = {
    ...published.meta,
    last_published: now.toISOString()
  };

  await pool.query(
    `UPDATE wf_config_state
     SET draft_payload = $1, published_payload = $2, version = $3,
         version_status = 'Published', effective_from = $4, modified_by = $5, modified_on = NOW()
     WHERE id = 1`,
    [JSON.stringify(published), JSON.stringify(published), nextVersion, now, user.name]
  );

  await pool.query(
    `INSERT INTO wf_bundle_snapshots (version, status, payload, description, effective_from, created_by, reason)
     VALUES ($1, 'Published', $2, $3, $4, $5, $6)`,
    [nextVersion, JSON.stringify(published), reason || "Workflow definitions published", now, user.name, reason || null]
  );

  await syncNormalizedTables(pool, published, user.name, nextVersion, "Published");

  await writeEnterpriseAudit(pool, {
    eventType: "WorkflowPublished",
    module: "Workflow Engine",
    entity: "Workflow Catalog",
    entityId: "workflows",
    action: "Workflow definitions published",
    previousValue: String(Number(row.version).toFixed(1)),
    newValue: String(nextVersion),
    userName: user.name,
    userRole: user.role,
    metadata: { reason }
  });

  return buildBundle(pool, await fetchConfigState(pool));
}

async function discardDraft(pool, req) {
  const user = userContext(req);
  const row = await ensureConfigState(pool);
  const published = enrichDefinitionsPayload(row.published_payload);

  await pool.query(
    `UPDATE wf_config_state SET draft_payload = $1, modified_by = $2, modified_on = NOW() WHERE id = 1`,
    [JSON.stringify(published), user.name]
  );

  return buildBundle(pool, await fetchConfigState(pool));
}

async function archiveWorkflow(pool, workflowCode, req, reason = "") {
  const user = userContext(req);
  const row = await ensureConfigState(pool);
  const draft = clonePayload(row.draft_payload);
  const definition = (draft.definitions || []).find(
    (item) => item.workflow_code === workflowCode || item.workflow_key === workflowCode
  );

  if (!definition) {
    throw httpError(`Workflow not found: ${workflowCode}`, 404);
  }

  definition.status = "Archived";
  await persistDraft(pool, draft, user.name);

  await writeEnterpriseAudit(pool, {
    eventType: "WorkflowPublished",
    module: "Workflow Engine",
    entity: "Workflow Definition",
    entityId: workflowCode,
    action: "Workflow archived",
    userName: user.name,
    userRole: user.role,
    metadata: { reason }
  });

  return buildBundle(pool, await fetchConfigState(pool));
}

async function restoreSnapshot(pool, snapshotId, req, reason = "") {
  const user = userContext(req);
  const snapshotResult = await pool.query(
    "SELECT * FROM wf_bundle_snapshots WHERE snapshot_id = $1",
    [snapshotId]
  );

  if (!snapshotResult.rows.length) {
    throw httpError("Snapshot not found", 404);
  }

  const snapshot = snapshotResult.rows[0];
  const restored = enrichDefinitionsPayload(snapshot.payload);
  const validation = validateDefinitions(restored);

  if (!validation.valid) {
    throw httpError(validation.errors.join(" "), 400);
  }

  const nextVersion = Number((Number(snapshot.version) + 0.1).toFixed(1));

  await pool.query(
    `UPDATE wf_config_state
     SET draft_payload = $1, published_payload = $2, version = $3,
         version_status = 'Published', modified_by = $4, modified_on = NOW()
     WHERE id = 1`,
    [JSON.stringify(restored), JSON.stringify(restored), nextVersion, user.name]
  );

  await syncNormalizedTables(pool, restored, user.name, nextVersion, "Published");
  return buildBundle(pool, await fetchConfigState(pool));
}

async function exportWorkflows(pool) {
  const bundle = await getWorkflowsBundle(pool);
  return {
    exportedAt: new Date().toISOString(),
    version: bundle.version,
    payload: bundle.baseline
  };
}

async function previewImport(pool, payload) {
  const validation = validateDefinitions(payload);
  return {
    valid: validation.valid,
    errors: validation.errors,
    warnings: validation.warnings,
    summary: {
      definitionCount: (payload.definitions || []).length
    }
  };
}

async function commitImport(pool, payload, req, reason = "") {
  const preview = await previewImport(pool, payload);

  if (!preview.valid) {
    throw httpError(preview.errors.join(" "), 400);
  }

  const user = userContext(req);
  await persistDraft(pool, enrichDefinitionsPayload(payload), user.name);

  await writeEnterpriseAudit(pool, {
    eventType: "WorkflowPublished",
    module: "Workflow Engine",
    entity: "Workflow Catalog",
    entityId: "workflows",
    action: "Workflow import applied to draft",
    userName: user.name,
    userRole: user.role,
    metadata: { reason, ...preview.summary }
  });

  return { ...buildBundle(pool, await fetchConfigState(pool)), importSummary: preview.summary };
}

async function seedConfiguration(pool, payload, primaryInstance, user = { name: "System Seed", role: "Admin" }) {
  const seed = enrichDefinitionsPayload(payload);

  await pool.query("DELETE FROM wf_config_state WHERE id = 1");
  await pool.query("DELETE FROM wf_bundle_snapshots");
  await pool.query("DELETE FROM wf_instances");

  await pool.query(
    `INSERT INTO wf_config_state (
      id, draft_payload, published_payload, version, version_status,
      effective_from, created_by, modified_by
    ) VALUES (1, $1, $2, 1.0, 'Published', NOW(), $3, $3)`,
    [JSON.stringify(seed), JSON.stringify(seed), user.name]
  );

  await pool.query(
    `INSERT INTO wf_bundle_snapshots (version, status, payload, description, effective_from, created_by, reason)
     VALUES (1.0, 'Published', $1, 'Initial seed', NOW(), $2, 'Initial seed')`,
    [JSON.stringify(seed), user.name]
  );

  await syncNormalizedTables(pool, seed, user.name, 1.0, "Published");

  const instancePayload = primaryInstance.instance_payload || primaryInstance;
  await pool.query(
    `INSERT INTO wf_instances (
      instance_id, workflow_code, status, current_stage_key, execution_context,
      instance_payload, started_by, modified_by
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$7)`,
    [
      primaryInstance.instance_id,
      primaryInstance.workflow_code,
      primaryInstance.status || "Running",
      primaryInstance.current_stage_key,
      JSON.stringify(primaryInstance.execution_context || {}),
      JSON.stringify(instancePayload),
      user.name
    ]
  );

  for (const stage of instancePayload.stages || []) {
    if (stage.status === "In Progress" && stage.is_approval_stage) {
      await createTask(pool, primaryInstance.instance_id, {
        stageKey: stage.key,
        taskType: "approval",
        title: `${stage.name} approval`,
        assignee: stage.owner,
        assigneeRole: stage.responsible_role,
        assignedBy: user.name
      });
    }
  }
}

module.exports = {
  TASK_STATUS,
  INSTANCE_STATUS,
  getDefaultSeedPayload,
  getWorkflowsBundle,
  getInstanceById,
  getCurrentTasks,
  getMyActiveApprovals,
  approveMyActiveApproval,
  rejectMyActiveApproval,
  requestClarificationMyActiveApproval,
  createTask,
  createApprovalRouteWorkflowTasks,
  startWorkflow,
  advanceWorkflow,
  requestClarification,
  submitClarification,
  completeTask,
  reassignTask,
  publishBundle,
  discardDraft,
  archiveWorkflow,
  restoreSnapshot,
  validateDefinitions,
  exportWorkflows,
  previewImport,
  commitImport,
  seedConfiguration,
  syncNormalizedTables
};
