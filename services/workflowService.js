const businessRulesService = require("./businessRulesService");
const { writeEnterpriseAudit, userContext } = require("./enterpriseAuditService");

const SEED_PATH = require("path").join(__dirname, "..", "seed", "workflows.seed.json");

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

async function syncNormalizedTables(pool, payload, userName, version, versionStatus) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
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

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
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

async function getInstanceById(pool, instanceId) {
  const result = await pool.query(
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
      task.status || "Pending",
      task.assignee || null,
      task.assigneeRole || null,
      task.dueAt ? new Date(task.dueAt) : null
    ]
  );

  if (task.assignee) {
    await pool.query(
      `INSERT INTO wf_assignments (task_id, assignee, assignee_role, assigned_by)
       VALUES ($1,$2,$3,$4)`,
      [result.rows[0].task_id, task.assignee, task.assigneeRole || null, task.assignedBy || "System"]
    );
  }

  return result.rows[0].task_id;
}

async function startWorkflow(pool, workflowCode, executionContext, req) {
  const user = userContext(req);
  const bundle = await getWorkflowsBundle(pool);
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

  await pool.query(
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
    await createTask(pool, instanceId, {
      stageKey: firstStage.stage_key,
      taskType: "approval",
      title: `${firstStage.stage_name} approval`,
      assigneeRole: firstStage.responsible_role || "Approver",
      assignedBy: user.name
    });
  }

  await appendHistory(pool, instanceId, {
    eventType: "WorkflowStarted",
    stageKey: firstStage?.stage_key,
    actor: user.name,
    actorRole: user.role,
    action: `Workflow ${definition.title} started`
  });

  await writeEnterpriseAudit(pool, {
    eventType: "WorkflowStarted",
    module: "Workflow Engine",
    entity: "Workflow Instance",
    entityId: instanceId,
    action: `Workflow started: ${definition.title}`,
    userName: user.name,
    userRole: user.role,
    metadata: { workflowCode: definition.workflow_code }
  });

  return getInstanceById(pool, instanceId);
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
  const row = await pool.query("SELECT * FROM wf_instances WHERE instance_id = $1", [instanceId]);

  if (!row.rows.length) {
    throw httpError(`Workflow instance not found: ${instanceId}`, 404);
  }

  const instance = row.rows[0];
  const stageKey = instance.current_stage_key;
  const payload = clonePayload(instance.instance_payload);
  const stage = payload.stages.find((item) => item.key === stageKey);

  if (stage) {
    stage.status = "Clarification Submitted";
    stage.completion_pct = Math.max(stage.completion_pct || 0, 30);
  }

  payload.timeline.push({
    id: `tl-${Date.now()}`,
    time: new Date().toISOString(),
    actor: user.name,
    role: user.role,
    action: "Clarification Submitted",
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
    eventType: "ClarificationSubmitted",
    stageKey,
    actor: user.name,
    actorRole: user.role,
    action: "Clarification submitted",
    comments
  });

  await writeEnterpriseAudit(pool, {
    eventType: "ClarificationSubmitted",
    module: "Workflow Engine",
    entity: "Workflow Instance",
    entityId: instanceId,
    action: "Clarification submitted",
    userName: user.name,
    userRole: user.role,
    metadata: { comments, stageKey }
  });

  return { hiringProcess: payload, stage };
}

async function completeTask(pool, taskId, req) {
  const user = userContext(req);
  const taskResult = await pool.query("SELECT * FROM wf_tasks WHERE task_id = $1", [taskId]);

  if (!taskResult.rows.length) {
    throw httpError(`Task not found: ${taskId}`, 404);
  }

  const task = taskResult.rows[0];

  await pool.query(
    `UPDATE wf_tasks SET status = 'Completed', completed_on = NOW() WHERE task_id = $1`,
    [taskId]
  );

  await writeEnterpriseAudit(pool, {
    eventType: "TaskAssigned",
    module: "Workflow Engine",
    entity: "Workflow Task",
    entityId: String(taskId),
    action: "Task completed",
    userName: user.name,
    userRole: user.role
  });

  return { taskId, status: "Completed" };
}

async function reassignTask(pool, taskId, assignee, req, assigneeRole = null) {
  const user = userContext(req);
  const taskResult = await pool.query("SELECT * FROM wf_tasks WHERE task_id = $1", [taskId]);

  if (!taskResult.rows.length) {
    throw httpError(`Task not found: ${taskId}`, 404);
  }

  const task = taskResult.rows[0];

  await pool.query(
    `UPDATE wf_tasks SET assignee = $1, assignee_role = $2 WHERE task_id = $3`,
    [assignee, assigneeRole, taskId]
  );

  await pool.query(
    `UPDATE wf_assignments SET active = FALSE WHERE task_id = $1`,
    [taskId]
  );

  await pool.query(
    `INSERT INTO wf_assignments (task_id, assignee, assignee_role, assigned_by)
     VALUES ($1,$2,$3,$4)`,
    [taskId, assignee, assigneeRole, user.name]
  );

  await writeEnterpriseAudit(pool, {
    eventType: "TaskReassigned",
    module: "Workflow Engine",
    entity: "Workflow Task",
    entityId: String(taskId),
    action: `Task reassigned to ${assignee}`,
    userName: user.name,
    userRole: user.role
  });

  return { taskId, assignee, assigneeRole, status: task.status };
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
  getDefaultSeedPayload,
  getWorkflowsBundle,
  getInstanceById,
  getCurrentTasks,
  createTask,
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
