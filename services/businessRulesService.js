const { writeEnterpriseAudit, userContext } = require("./enterpriseAuditService");

const SEED_PATH = require("path").join(__dirname, "..", "seed", "businessRules.seed.json");

const RESTRICTED_LOCATIONS = ["Mumbai", "Delhi", "Hyderabad"];
const HIGH_GRADES = ["G10", "G11", "G12"];

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

function toRuleCode(name, existingCode) {
  if (existingCode) {
    return existingCode;
  }

  return name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

function parseGradeNumber(grade) {
  if (!grade) {
    return 0;
  }

  const match = String(grade).match(/G(\d+)/i);
  return match ? Number(match[1]) : 0;
}

function computeKpis(rules) {
  return {
    total_rules: rules.length,
    active_rules: rules.filter((rule) => rule.status === "Active").length,
    draft_rules: rules.filter((rule) => rule.status === "Draft").length,
    pending_approval_rules: rules.filter((rule) => rule.status === "Pending Approval").length
  };
}

function computeCategories(payload) {
  const counts = {};

  (payload.rules || []).forEach((rule) => {
    const key = rule.category.toLowerCase();
    counts[key] = (counts[key] || 0) + 1;
  });

  return (payload.categories || []).map((category) => ({
    ...category,
    rule_count: counts[category.key] || 0
  }));
}

function enrichBundle(payload) {
  const next = clonePayload(payload);
  next.kpis = computeKpis(next.rules || []);
  next.categories = computeCategories(next);
  return next;
}

async function fetchConfigState(pool) {
  const result = await pool.query("SELECT * FROM br_config_state WHERE id = 1");
  return result.rows[0] || null;
}

async function ensureConfigState(pool) {
  const existing = await fetchConfigState(pool);

  if (existing) {
    return existing;
  }

  const seed = enrichBundle(getDefaultSeedPayload());
  const now = new Date().toISOString();
  seed.meta.last_published = seed.meta.last_published || now;

  await pool.query(
    `INSERT INTO br_config_state (
      id, draft_payload, published_payload, version, version_status,
      effective_from, created_by, modified_by
    ) VALUES (1, $1, $2, 2.1, 'Published', NOW(), 'System', 'System')`,
    [JSON.stringify(seed), JSON.stringify(seed)]
  );

  await syncNormalizedTables(pool, seed, "System", 2.1, "Published");
  return fetchConfigState(pool);
}

function buildBundle(row) {
  const draft = enrichBundle(row.draft_payload);
  const published = enrichBundle(row.published_payload);

  return {
    config: draft,
    baseline: published,
    isDirty: !configsEqual(draft, published),
    version: String(Number(row.version).toFixed(1)),
    versionStatus: row.version_status,
    effectiveFrom: row.effective_from?.toISOString?.() || null,
    effectiveTo: row.effective_to?.toISOString?.() || null
  };
}

async function getRulesBundle(pool) {
  const row = await ensureConfigState(pool);
  return buildBundle(row);
}

async function persistDraft(pool, draft, userName) {
  const enriched = enrichBundle(draft);

  await pool.query(
    `UPDATE br_config_state
     SET draft_payload = $1,
         modified_by = $2,
         modified_on = NOW()
     WHERE id = 1`,
    [JSON.stringify(enriched), userName]
  );

  return enriched;
}

async function loadPlatformConfig(pool) {
  const result = await pool.query(
    "SELECT published_payload FROM pc_config_state WHERE id = 1"
  );

  if (!result.rows.length) {
    return null;
  }

  return result.rows[0].published_payload;
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
    const meta = payload.meta || {};

    await client.query(
      `INSERT INTO br_general_settings (
        id, org_name, environment, last_published, version, version_status,
        effective_from, modified_by
      ) VALUES (1, $1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (id) DO UPDATE SET
        org_name = EXCLUDED.org_name,
        environment = EXCLUDED.environment,
        last_published = EXCLUDED.last_published,
        version = EXCLUDED.version,
        version_status = EXCLUDED.version_status,
        effective_from = EXCLUDED.effective_from,
        modified_by = EXCLUDED.modified_by,
        modified_on = NOW()`,
      [
        meta.org_name,
        meta.environment || "Production",
        meta.last_published ? new Date(meta.last_published) : null,
        version,
        versionStatus,
        effectiveFrom,
        userName
      ]
    );

    await client.query("DELETE FROM br_categories");
    for (const category of payload.categories || []) {
      await client.query(
        `INSERT INTO br_categories (
          category_key, label, rule_count, version, version_status,
          effective_from, modified_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          category.key,
          category.label,
          category.rule_count || 0,
          version,
          versionStatus,
          effectiveFrom,
          userName
        ]
      );
    }

    await client.query("DELETE FROM br_rule_dependencies");
    await client.query("DELETE FROM br_rule_parameters");
    await client.query("DELETE FROM br_rule_actions");
    await client.query("DELETE FROM br_rule_conditions");
    await client.query("DELETE FROM br_rules");

    for (const rule of payload.rules || []) {
      const ruleCode = toRuleCode(rule.name, rule.rule_code);

      await client.query(
        `INSERT INTO br_rules (
          rule_id, rule_code, name, description, category, priority, status,
          trigger_event, version, version_status, effective_from, last_modified, modified_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          rule.id,
          ruleCode,
          rule.name,
          rule.description || null,
          rule.category,
          rule.priority || "Medium",
          rule.status || "Draft",
          rule.trigger_event || null,
          rule.version || "0.1",
          versionStatus,
          effectiveFrom,
          rule.last_modified ? new Date(rule.last_modified) : new Date(),
          userName
        ]
      );

      for (let index = 0; index < (rule.conditions || []).length; index += 1) {
        const expression = rule.conditions[index];
        if (!expression || !String(expression).trim()) {
          continue;
        }

        await client.query(
          `INSERT INTO br_rule_conditions (
            rule_id, sequence_order, expression, created_by
          ) VALUES ($1,$2,$3,$4)`,
          [rule.id, index + 1, expression, userName]
        );
      }

      for (let index = 0; index < (rule.actions || []).length; index += 1) {
        const description = rule.actions[index];
        if (!description || !String(description).trim()) {
          continue;
        }

        await client.query(
          `INSERT INTO br_rule_actions (
            rule_id, sequence_order, action_type, description, created_by
          ) VALUES ($1,$2,'generic',$3,$4)`,
          [rule.id, index + 1, description, userName]
        );
      }

      for (const depId of rule.depends_on || []) {
        await client.query(
          `INSERT INTO br_rule_dependencies (
            rule_id, depends_on_rule_id, created_by
          ) VALUES ($1,$2,$3)`,
          [rule.id, depId, userName]
        );
      }

      await client.query(
        `INSERT INTO br_rule_versions (
          rule_id, version_label, status, snapshot, changed_by, reason
        ) VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          rule.id,
          rule.version || "0.1",
          rule.status || "Draft",
          JSON.stringify(rule),
          userName,
          "Synced on publish"
        ]
      );
    }

    await client.query("DELETE FROM br_approval_matrix");
    for (const row of payload.approval_matrix || []) {
      await client.query(
        `INSERT INTO br_approval_matrix (
          matrix_id, department, grade, budget_limit_lpa, required_approvers,
          escalation, version, version_status, effective_from, modified_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          row.id,
          row.department,
          row.grade,
          row.budget_limit_lpa,
          JSON.stringify(row.required_approvers || []),
          row.escalation || null,
          version,
          versionStatus,
          effectiveFrom,
          userName
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

function detectCircularDependencies(rules) {
  const graph = new Map();

  rules.forEach((rule) => {
    graph.set(rule.id, rule.depends_on || []);
  });

  const visiting = new Set();
  const visited = new Set();
  const cycles = [];

  function dfs(node, path) {
    if (visiting.has(node)) {
      cycles.push([...path, node]);
      return;
    }

    if (visited.has(node)) {
      return;
    }

    visiting.add(node);
    const deps = graph.get(node) || [];

    deps.forEach((dep) => {
      if (graph.has(dep)) {
        dfs(dep, [...path, node]);
      }
    });

    visiting.delete(node);
    visited.add(node);
  }

  graph.forEach((_deps, node) => dfs(node, []));

  return cycles;
}

function validateBundle(payload) {
  const errors = [];
  const warnings = [];
  const rules = payload.rules || [];

  const names = new Set();
  const codes = new Set();

  rules.forEach((rule) => {
    const code = toRuleCode(rule.name, rule.rule_code);
    const nameKey = rule.name.toLowerCase();

    if (names.has(nameKey)) {
      errors.push(`Duplicate rule name: ${rule.name}`);
    }
    names.add(nameKey);

    if (codes.has(code)) {
      errors.push(`Duplicate rule code: ${code}`);
    }
    codes.add(code);

    if (!rule.name?.trim()) {
      errors.push("Rule name is required.");
    }

    if (rule.status !== "Draft" && !rule.trigger_event?.trim()) {
      errors.push(`Rule "${rule.name}" requires a trigger event.`);
    }

    const validConditions = (rule.conditions || []).filter((item) => String(item).trim());
    if (rule.status === "Active" && validConditions.length === 0) {
      errors.push(`Active rule "${rule.name}" requires at least one condition.`);
    }

    (rule.conditions || []).forEach((condition, index) => {
      if (rule.status !== "Draft" && !String(condition).trim()) {
        errors.push(`Rule "${rule.name}" has empty condition at position ${index + 1}.`);
      }
    });

    const validActions = (rule.actions || []).filter((item) => String(item).trim());
    if (rule.status === "Active" && validActions.length === 0) {
      errors.push(`Active rule "${rule.name}" requires at least one action.`);
    }

    (rule.depends_on || []).forEach((depId) => {
      if (!rules.some((item) => item.id === depId)) {
        errors.push(`Rule "${rule.name}" depends on missing rule ${depId}.`);
      }
    });
  });

  const cycles = detectCircularDependencies(rules);
  if (cycles.length) {
    errors.push(`Circular rule dependency detected: ${cycles[0].join(" -> ")}`);
  }

  const versionMap = new Map();
  rules.forEach((rule) => {
    const key = `${rule.name}:${rule.version}`;
    if (versionMap.has(key)) {
      warnings.push(`Version conflict for rule "${rule.name}" at version ${rule.version}.`);
    }
    versionMap.set(key, rule.id);
  });

  return { valid: errors.length === 0, errors, warnings };
}

function findRule(rules, ruleCode) {
  return rules.find(
    (rule) =>
      rule.rule_code === ruleCode ||
      rule.id === ruleCode ||
      toRuleCode(rule.name, rule.rule_code) === ruleCode
  );
}

function getMatrixRow(bundle, context) {
  return (bundle.approval_matrix || []).find(
    (row) =>
      row.department === context.department &&
      row.grade === context.grade
  );
}

function evaluateRuleDefinition(rule, context, helpers) {
  const {
    matrixRow,
    budgetThresholdPct = 10,
    approvedBudgetLpa
  } = helpers;

  const gradeNum = parseGradeNumber(context.grade);
  const offeredSalary = Number(context.offered_salary_lpa ?? context.salary ?? 0);
  const location = context.location || "";
  const candidateSource = context.candidate_source || context.candidateSource || "";
  const code = toRuleCode(rule.name, rule.rule_code);

  let matched = false;
  const requiredApprovals = [];
  const notifications = [];
  const escalations = [];

  switch (code) {
    case "OFFER_ABOVE_BUDGET": {
      const limit = matrixRow?.budget_limit_lpa ?? approvedBudgetLpa ?? 0;
      const thresholdMultiplier = 1 + budgetThresholdPct / 100;
      matched = offeredSalary > limit || offeredSalary > limit * thresholdMultiplier;
      if (matched) {
        requiredApprovals.push("Finance Approver");
        notifications.push("Budget exception alert to TA Lead");
        notifications.push("Finance approval request");
        escalations.push(matrixRow?.escalation || "TA Lead after 48h");
      }
      break;
    }
    case "OFFER_APPROVAL_BASED_ON_GRADE":
      matched = gradeNum >= 10 || HIGH_GRADES.includes(context.grade);
      if (matched) {
        requiredApprovals.push("TA Lead");
        if (gradeNum >= 12) {
          requiredApprovals.push("Finance");
        }
        notifications.push("Notify TA Leader");
      }
      break;
    case "LOCATION_BASED_HIRING_APPROVAL":
      matched = RESTRICTED_LOCATIONS.includes(location);
      if (matched) {
        requiredApprovals.push("HRBP");
        notifications.push("HRBP review required — restricted location");
        escalations.push("Hold requisition until approved");
      }
      break;
    case "DUPLICATE_CANDIDATE_DETECTION":
      matched = Boolean(context.duplicate_detected || context.email_match || context.phone_match);
      break;
    case "MANDATORY_L2_INTERVIEW":
      matched =
        context.target_stage === "Client Interview" &&
        gradeNum >= 8 &&
        !context.l2_completed;
      break;
    case "VENDOR_SLA_ESCALATION":
      matched =
        Number(context.pending_hours || 0) > 48 &&
        context.vendor_tier === "Preferred";
      break;
    case "AUTO_REJECT_INACTIVE_CANDIDATE":
      matched =
        Number(context.inactive_days || 0) >= 90 &&
        !["Offer", "Joined"].includes(context.stage);
      break;
    case "AUTO_CLOSE_FILLED_REQUISITION":
      matched =
        Number(context.filled_positions || 0) >= Number(context.approved_headcount || 0) &&
        Number(context.approved_headcount || 0) > 0;
      break;
    case "INTERVIEW_FEEDBACK_REMINDER":
      matched = Number(context.feedback_delay_hours || 0) >= 24;
      break;
    case "REFERRAL_BONUS_ELIGIBILITY":
      matched =
        candidateSource === "Employee Referral" &&
        context.referrer_employed !== false &&
        Number(context.referral_age_days || 0) <= 90;
      break;
    default:
      matched = false;
      break;
  }

  if (rule.status !== "Active") {
    matched = false;
  }

  return {
    ruleMatched: matched,
    ruleCode: code,
    ruleId: rule.id,
    ruleName: rule.name,
    actions: matched ? [...(rule.actions || [])] : [],
    requiredApprovals,
    notifications,
    escalations
  };
}

async function evaluateRule(pool, ruleCode, executionContext = {}) {
  const bundle = await getRulesBundle(pool);
  const platformConfig = await loadPlatformConfig(pool);
  const rule = findRule(bundle.baseline.rules, ruleCode);

  if (!rule) {
    throw httpError(`Rule not found: ${ruleCode}`, 404);
  }

  const matrixRow = getMatrixRow(bundle.baseline, executionContext);
  const result = evaluateRuleDefinition(rule, executionContext, {
    matrixRow,
    budgetThresholdPct: platformConfig?.budget?.max_budget_variance_pct ?? 10,
    approvedBudgetLpa: executionContext.approved_budget_lpa
  });

  return {
    ...result,
    matched: result.ruleMatched
  };
}

async function recordExecution(pool, {
  rule,
  executionType,
  matched,
  executionContext,
  result,
  userName,
  correlationId
}) {
  await pool.query(
    `INSERT INTO br_rule_execution_history (
      rule_id, rule_code, execution_type, matched, execution_context, result,
      executed_by, correlation_id
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      rule?.id || null,
      rule ? toRuleCode(rule.name, rule.rule_code) : null,
      executionType,
      matched,
      JSON.stringify(executionContext),
      JSON.stringify(result),
      userName,
      correlationId || null
    ]
  );
}

async function executeRule(pool, ruleCode, executionContext, req) {
  const user = userContext(req);
  const result = await evaluateRule(pool, ruleCode, executionContext);
  const rule = findRule((await getRulesBundle(pool)).baseline.rules, ruleCode);

  await recordExecution(pool, {
    rule,
    executionType: "execute",
    matched: result.ruleMatched,
    executionContext,
    result,
    userName: user.name,
    correlationId: req.body?.correlationId
  });

  await writeEnterpriseAudit(pool, {
    eventType: "RuleExecuted",
    module: "Business Rules",
    entity: "Rule",
    entityId: rule?.id || ruleCode,
    action: `Rule executed: ${rule?.name || ruleCode}`,
    newValue: result.ruleMatched ? "Matched" : "Not Matched",
    userName: user.name,
    userRole: user.role,
    metadata: { ruleCode, executionContext }
  });

  if (result.ruleMatched) {
    await writeEnterpriseAudit(pool, {
      eventType: "RuleMatched",
      module: "Business Rules",
      entity: "Rule",
      entityId: rule?.id || ruleCode,
      action: `Rule matched: ${rule?.name || ruleCode}`,
      userName: user.name,
      userRole: user.role,
      metadata: { actions: result.actions, requiredApprovals: result.requiredApprovals }
    });
  }

  return result;
}

async function simulateRules(pool, executionContext, req) {
  const user = userContext(req);
  const bundle = await getRulesBundle(pool);
  const platformConfig = await loadPlatformConfig(pool);
  const published = bundle.baseline;
  const matrixRow = getMatrixRow(published, executionContext);
  const budgetThresholdPct = platformConfig?.budget?.max_budget_variance_pct ?? 10;

  const triggeredRules = [];
  const approvers = matrixRow ? [...matrixRow.required_approvers] : ["Hiring Manager"];
  const notifications = [];
  const escalations = [];
  const actions = [];
  let estimatedSla = "24 hours";

  for (const rule of published.rules.filter((item) => item.status === "Active")) {
    const result = evaluateRuleDefinition(rule, executionContext, {
      matrixRow,
      budgetThresholdPct,
      approvedBudgetLpa: executionContext.approved_budget_lpa
    });

    if (result.ruleMatched) {
      triggeredRules.push(rule.name);
      actions.push(...result.actions);
      approvers.push(...result.requiredApprovals);
      notifications.push(...result.notifications);
      escalations.push(...result.escalations);
    }
  }

  if (triggeredRules.length === 0) {
    triggeredRules.push("Standard Offer Approval");
    notifications.push("Offer approval notification to Hiring Manager");
  }

  if (matrixRow?.escalation) {
    notifications.push(`Escalation policy: ${matrixRow.escalation}`);
  }

  if (triggeredRules.includes("Offer Above Budget")) {
    estimatedSla = "48 hours";
  }
  if (triggeredRules.includes("Location Based Hiring Approval")) {
    estimatedSla = "72 hours";
  }

  const simulationResult = {
    triggered_rules: triggeredRules,
    approvers: [...new Set(approvers)],
    notifications: [...new Set(notifications)],
    escalations: [...new Set(escalations)],
    actions: [...new Set(actions)],
    estimated_sla: estimatedSla,
    budget_threshold_pct: budgetThresholdPct
  };

  await recordExecution(pool, {
    rule: null,
    executionType: "simulate",
    matched: triggeredRules.length > 0,
    executionContext,
    result: simulationResult,
    userName: user.name,
    correlationId: req.body?.correlationId
  });

  await writeEnterpriseAudit(pool, {
    eventType: "RuleSimulationExecuted",
    module: "Business Rules",
    entity: "Rule Simulator",
    entityId: "simulator",
    action: "Rule simulation executed",
    newValue: triggeredRules.join(", "),
    userName: user.name,
    userRole: user.role,
    metadata: { executionContext, triggeredRules }
  });

  return simulationResult;
}

async function createRule(pool, ruleInput, req) {
  const user = userContext(req);
  const row = await ensureConfigState(pool);
  const draft = clonePayload(row.draft_payload);
  const rule = clonePayload(ruleInput);

  rule.id = rule.id || `rule-${Date.now()}`;
  rule.rule_code = toRuleCode(rule.name, rule.rule_code);
  rule.last_modified = new Date().toISOString();
  rule.status = rule.status || "Draft";
  rule.version = rule.version || "0.1";
  rule.depends_on = rule.depends_on || [];

  if (draft.rules.some((item) => item.id === rule.id)) {
    throw httpError(`Rule already exists: ${rule.id}`, 409);
  }

  draft.rules.push(rule);
  const validation = validateBundle(draft);

  if (!validation.valid) {
    throw httpError(validation.errors.join(" "), 400);
  }

  await persistDraft(pool, draft, user.name);

  await writeEnterpriseAudit(pool, {
    eventType: "RuleCreated",
    module: "Business Rules",
    entity: "Rule",
    entityId: rule.id,
    action: `Rule created: ${rule.name}`,
    userName: user.name,
    userRole: user.role,
    metadata: { ruleCode: rule.rule_code }
  });

  return buildBundle(await fetchConfigState(pool));
}

async function updateRule(pool, ruleId, ruleInput, req) {
  const user = userContext(req);
  const row = await ensureConfigState(pool);
  const draft = clonePayload(row.draft_payload);
  const index = draft.rules.findIndex((item) => item.id === ruleId);

  if (index === -1) {
    throw httpError(`Rule not found: ${ruleId}`, 404);
  }

  const updated = {
    ...draft.rules[index],
    ...clonePayload(ruleInput),
    id: ruleId,
    rule_code: toRuleCode(ruleInput.name || draft.rules[index].name, ruleInput.rule_code || draft.rules[index].rule_code),
    last_modified: new Date().toISOString()
  };

  draft.rules[index] = updated;
  const validation = validateBundle(draft);

  if (!validation.valid) {
    throw httpError(validation.errors.join(" "), 400);
  }

  await persistDraft(pool, draft, user.name);
  return buildBundle(await fetchConfigState(pool));
}

async function deleteRule(pool, ruleId, req) {
  const user = userContext(req);
  const row = await ensureConfigState(pool);
  const draft = clonePayload(row.draft_payload);

  const dependents = draft.rules.filter((rule) => (rule.depends_on || []).includes(ruleId));
  if (dependents.length) {
    throw httpError(
      `Cannot delete rule — depended on by: ${dependents.map((item) => item.name).join(", ")}`,
      400
    );
  }

  draft.rules = draft.rules.filter((item) => item.id !== ruleId);
  await persistDraft(pool, draft, user.name);

  await writeEnterpriseAudit(pool, {
    eventType: "RuleArchived",
    module: "Business Rules",
    entity: "Rule",
    entityId: ruleId,
    action: "Rule deleted from draft",
    userName: user.name,
    userRole: user.role
  });

  return buildBundle(await fetchConfigState(pool));
}

async function archiveRule(pool, ruleId, req, reason = "") {
  const user = userContext(req);
  const row = await ensureConfigState(pool);
  const draft = clonePayload(row.draft_payload);
  const rule = draft.rules.find((item) => item.id === ruleId);

  if (!rule) {
    throw httpError(`Rule not found: ${ruleId}`, 404);
  }

  if (rule.status === "Archived") {
    throw httpError("Rule is already archived.", 400);
  }

  rule.status = "Archived";
  rule.last_modified = new Date().toISOString();
  await persistDraft(pool, draft, user.name);

  await writeEnterpriseAudit(pool, {
    eventType: "RuleArchived",
    module: "Business Rules",
    entity: "Rule",
    entityId: ruleId,
    action: `Rule archived: ${rule.name}`,
    userName: user.name,
    userRole: user.role,
    metadata: { reason }
  });

  return buildBundle(await fetchConfigState(pool));
}

async function publishRule(pool, ruleId, req, reason = "") {
  const user = userContext(req);
  const row = await ensureConfigState(pool);
  const draft = clonePayload(row.draft_payload);
  const rule = draft.rules.find((item) => item.id === ruleId);

  if (!rule) {
    throw httpError(`Rule not found: ${ruleId}`, 404);
  }

  const validation = validateBundle({ ...draft, rules: [rule] });
  if (!validation.valid) {
    await writeEnterpriseAudit(pool, {
      eventType: "RuleValidationFailed",
      module: "Business Rules",
      entity: "Rule",
      entityId: ruleId,
      action: `Rule validation failed: ${rule.name}`,
      newValue: validation.errors.join("; "),
      userName: user.name,
      userRole: user.role
    });
    throw httpError(validation.errors.join(" "), 400);
  }

  rule.status = "Active";
  rule.version = String((Number(rule.version) + 0.1).toFixed(1));
  rule.last_modified = new Date().toISOString();
  await persistDraft(pool, draft, user.name);

  await writeEnterpriseAudit(pool, {
    eventType: "RulePublished",
    module: "Business Rules",
    entity: "Rule",
    entityId: ruleId,
    action: `Rule published: ${rule.name}`,
    previousValue: "Draft",
    newValue: rule.version,
    userName: user.name,
    userRole: user.role,
    metadata: { reason }
  });

  return buildBundle(await fetchConfigState(pool));
}

async function publishBundle(pool, payload, req, reason = "") {
  const user = userContext(req);
  const row = await ensureConfigState(pool);
  const draft = enrichBundle(payload || row.draft_payload);
  const validation = validateBundle(draft);

  if (!validation.valid) {
    await writeEnterpriseAudit(pool, {
      eventType: "RuleValidationFailed",
      module: "Business Rules",
      entity: "Rule Library",
      entityId: "business-rules",
      action: "Bundle validation failed on publish",
      newValue: validation.errors.join("; "),
      userName: user.name,
      userRole: user.role
    });
    throw httpError(validation.errors.join(" "), 400);
  }

  const nextVersion = Number((Number(row.version) + 0.1).toFixed(1));
  const now = new Date();
  const published = clonePayload(draft);
  published.meta = {
    ...published.meta,
    last_published: now.toISOString()
  };

  const historyEntry = {
    id: `vh-${Date.now()}`,
    version: String(nextVersion),
    published_by: user.name,
    date: now.toISOString(),
    description: reason || "Business rules published"
  };
  published.version_history = [historyEntry, ...(published.version_history || [])];

  await pool.query(
    `UPDATE br_config_state
     SET draft_payload = $1,
         published_payload = $2,
         version = $3,
         version_status = 'Published',
         effective_from = $4,
         modified_by = $5,
         modified_on = NOW()
     WHERE id = 1`,
    [JSON.stringify(published), JSON.stringify(published), nextVersion, now, user.name]
  );

  await pool.query(
    `INSERT INTO br_bundle_snapshots (
      version, status, payload, description, effective_from, created_by, reason
    ) VALUES ($1, 'Published', $2, $3, $4, $5, $6)`,
    [
      nextVersion,
      JSON.stringify(published),
      historyEntry.description,
      now,
      user.name,
      reason || "Business rules published"
    ]
  );

  await syncNormalizedTables(pool, published, user.name, nextVersion, "Published");

  await writeEnterpriseAudit(pool, {
    eventType: "RulePublished",
    module: "Business Rules",
    entity: "Rule Library",
    entityId: "business-rules",
    action: "Business rules published",
    previousValue: String(Number(row.version).toFixed(1)),
    newValue: String(nextVersion),
    userName: user.name,
    userRole: user.role,
    metadata: { reason }
  });

  return buildBundle(await fetchConfigState(pool));
}

async function discardDraft(pool, req) {
  const user = userContext(req);
  const row = await ensureConfigState(pool);
  const published = enrichBundle(row.published_payload);

  await pool.query(
    `UPDATE br_config_state
     SET draft_payload = $1,
         modified_by = $2,
         modified_on = NOW()
     WHERE id = 1`,
    [JSON.stringify(published), user.name]
  );

  return buildBundle(await fetchConfigState(pool));
}

async function restoreSnapshot(pool, snapshotId, req, reason = "") {
  const user = userContext(req);
  const snapshotResult = await pool.query(
    "SELECT * FROM br_bundle_snapshots WHERE snapshot_id = $1",
    [snapshotId]
  );

  if (!snapshotResult.rows.length) {
    throw httpError("Snapshot not found", 404);
  }

  const snapshot = snapshotResult.rows[0];
  const restored = enrichBundle(snapshot.payload);
  const validation = validateBundle(restored);

  if (!validation.valid) {
    throw httpError(validation.errors.join(" "), 400);
  }

  const nextVersion = Number((Number(restored.meta?.version || snapshot.version) + 0.1).toFixed(1));
  restored.meta.last_published = new Date().toISOString();

  await pool.query(
    `UPDATE br_config_state
     SET draft_payload = $1,
         published_payload = $2,
         version = $3,
         version_status = 'Published',
         modified_by = $4,
         modified_on = NOW()
     WHERE id = 1`,
    [JSON.stringify(restored), JSON.stringify(restored), nextVersion, user.name]
  );

  await syncNormalizedTables(pool, restored, user.name, nextVersion, "Published");

  return buildBundle(await fetchConfigState(pool));
}

async function getRuleById(pool, ruleId) {
  const bundle = await getRulesBundle(pool);
  const rule = bundle.config.rules.find((item) => item.id === ruleId);

  if (!rule) {
    return null;
  }

  return rule;
}

async function exportRules(pool) {
  const bundle = await getRulesBundle(pool);
  return {
    exportedAt: new Date().toISOString(),
    version: bundle.version,
    payload: bundle.baseline
  };
}

async function previewImport(pool, payload) {
  const validation = validateBundle(payload);
  return {
    valid: validation.valid,
    errors: validation.errors,
    warnings: validation.warnings,
    summary: {
      ruleCount: (payload.rules || []).length,
      activeRules: (payload.rules || []).filter((rule) => rule.status === "Active").length
    }
  };
}

async function commitImport(pool, payload, req, reason = "") {
  const preview = await previewImport(pool, payload);

  if (!preview.valid) {
    throw httpError(preview.errors.join(" "), 400);
  }

  const user = userContext(req);
  const imported = enrichBundle(payload);
  await persistDraft(pool, imported, user.name);

  await writeEnterpriseAudit(pool, {
    eventType: "RuleCreated",
    module: "Business Rules",
    entity: "Rule Library",
    entityId: "business-rules",
    action: "Business rules import applied to draft",
    userName: user.name,
    userRole: user.role,
    metadata: { reason, ...preview.summary }
  });

  return { ...buildBundle(await fetchConfigState(pool)), importSummary: preview.summary };
}

async function listSnapshots(pool) {
  const result = await pool.query(
    `SELECT snapshot_id, version, status, description, effective_from, created_by, created_on, reason
     FROM br_bundle_snapshots
     ORDER BY snapshot_id DESC`
  );

  return result.rows.map((row) => ({
    snapshotId: row.snapshot_id,
    version: String(Number(row.version).toFixed(1)),
    status: row.status,
    description: row.description,
    effectiveFrom: row.effective_from?.toISOString?.() || null,
    createdBy: row.created_by,
    createdOn: row.created_on?.toISOString?.() || null,
    reason: row.reason
  }));
}

async function seedConfiguration(pool, payload, user = { name: "System Seed", role: "Admin" }) {
  const seed = enrichBundle(payload);

  await pool.query("DELETE FROM br_config_state WHERE id = 1");
  await pool.query("DELETE FROM br_bundle_snapshots");

  await pool.query(
    `INSERT INTO br_config_state (
      id, draft_payload, published_payload, version, version_status,
      effective_from, created_by, modified_by
    ) VALUES (1, $1, $2, 2.1, 'Published', NOW(), $3, $3)`,
    [JSON.stringify(seed), JSON.stringify(seed), user.name]
  );

  await pool.query(
    `INSERT INTO br_bundle_snapshots (
      version, status, payload, description, effective_from, created_by, reason
    ) VALUES (2.1, 'Published', $1, 'Initial seed', NOW(), $2, 'Initial seed')`,
    [JSON.stringify(seed), user.name]
  );

  await syncNormalizedTables(pool, seed, user.name, 2.1, "Published");
}

module.exports = {
  getDefaultSeedPayload,
  getRulesBundle,
  getRuleById,
  createRule,
  updateRule,
  deleteRule,
  archiveRule,
  publishRule,
  publishBundle,
  discardDraft,
  restoreSnapshot,
  validateBundle,
  evaluateRule,
  executeRule,
  simulateRules,
  exportRules,
  previewImport,
  commitImport,
  listSnapshots,
  seedConfiguration,
  syncNormalizedTables
};
