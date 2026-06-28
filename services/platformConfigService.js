const { writeEnterpriseAudit, userContext } = require("./enterpriseAuditService");

const SEED_PATH = require("path").join(__dirname, "..", "seed", "platformConfig.seed.json");

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

function computeDraftChanges(draft, published) {
  if (configsEqual(draft, published)) {
    return 0;
  }

  let count = 0;
  const sections = [
    "modules",
    "workflows",
    "budget",
    "notification_channels",
    "notification_settings",
    "ai_features",
    "ai_governance",
    "role_visibility"
  ];

  sections.forEach((section) => {
    if (JSON.stringify(draft[section]) !== JSON.stringify(published[section])) {
      count += 1;
    }
  });

  return count;
}

function withMetaDraftChanges(draft, published) {
  const next = clonePayload(draft);
  next.meta = {
    ...next.meta,
    draft_changes: computeDraftChanges(draft, published)
  };
  return next;
}

async function fetchConfigState(pool) {
  const result = await pool.query("SELECT * FROM pc_config_state WHERE id = 1");

  if (!result.rows.length) {
    return null;
  }

  return result.rows[0];
}

async function ensureConfigState(pool) {
  const existing = await fetchConfigState(pool);

  if (existing) {
    return existing;
  }

  const seed = getDefaultSeedPayload();
  const now = new Date().toISOString();

  seed.meta.last_published = seed.meta.last_published || now;
  seed.meta.draft_changes = 0;

  await pool.query(
    `INSERT INTO pc_config_state (
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
  const draftWithMeta = withMetaDraftChanges(draft, published);

  return {
    config: draftWithMeta,
    baseline: published,
    isDirty: !configsEqual(draftWithMeta, published),
    version: String(Number(row.version).toFixed(1)),
    versionStatus: row.version_status,
    effectiveFrom: row.effective_from?.toISOString?.() || null,
    effectiveTo: row.effective_to?.toISOString?.() || null
  };
}

async function getConfigBundle(pool) {
  const row = await ensureConfigState(pool);
  return buildBundle(row);
}

async function persistDraft(pool, draft, published, userName) {
  const draftWithMeta = withMetaDraftChanges(draft, published);

  await pool.query(
    `UPDATE pc_config_state
     SET draft_payload = $1,
         modified_by = $2,
         modified_on = NOW()
     WHERE id = 1`,
    [JSON.stringify(draftWithMeta), userName]
  );

  return draftWithMeta;
}

async function syncNormalizedTables(pool, payload, userName, version, versionStatus) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const effectiveFrom = new Date();
    const meta = payload.meta || {};

    await client.query(
      `INSERT INTO pc_general_settings (
        id, org_name, environment, last_published, draft_changes,
        version, version_status, effective_from, modified_by
      ) VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (id) DO UPDATE SET
        org_name = EXCLUDED.org_name,
        environment = EXCLUDED.environment,
        last_published = EXCLUDED.last_published,
        draft_changes = EXCLUDED.draft_changes,
        version = EXCLUDED.version,
        version_status = EXCLUDED.version_status,
        effective_from = EXCLUDED.effective_from,
        modified_by = EXCLUDED.modified_by,
        modified_on = NOW()`,
      [
        meta.org_name,
        meta.environment || "Production",
        meta.last_published ? new Date(meta.last_published) : null,
        meta.draft_changes || 0,
        version,
        versionStatus,
        effectiveFrom,
        userName
      ]
    );

    await client.query("DELETE FROM pc_modules");
    for (const mod of payload.modules || []) {
      await client.query(
        `INSERT INTO pc_modules (
          module_key, title, description, enabled, required, depends_on,
          config_summary, policies, settings, version, version_status,
          effective_from, modified_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          mod.key,
          mod.title,
          mod.description || null,
          mod.enabled,
          mod.required || false,
          mod.depends_on || null,
          mod.config_summary || null,
          mod.policies || 0,
          JSON.stringify(mod.settings || {}),
          version,
          versionStatus,
          effectiveFrom,
          userName
        ]
      );
    }

    await client.query("DELETE FROM pc_workflows");
    for (const wf of payload.workflows || []) {
      await client.query(
        `INSERT INTO pc_workflows (
          workflow_key, title, description, enabled, steps, approvals, status,
          version_label, sla_hours, stages, approval_stages, version, version_status,
          effective_from, modified_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          wf.key,
          wf.title,
          wf.description || null,
          wf.enabled,
          wf.steps || 0,
          wf.approvals || 0,
          wf.status || "Draft",
          wf.version || null,
          wf.sla_hours || 24,
          JSON.stringify(wf.stages || []),
          JSON.stringify(wf.approval_stages || []),
          version,
          versionStatus,
          effectiveFrom,
          userName
        ]
      );
    }

    const budget = payload.budget || {};
    await client.query(
      `INSERT INTO pc_budget_governance (
        id, budget_approval_required, allow_offer_above_budget, max_budget_variance_pct,
        exception_workflow_enabled, approval_chain, escalation_after_hours, escalation_to,
        auto_reject_above_pct, default_currency, default_headcount_buffer_pct,
        exception_approvers, version, version_status, effective_from, modified_by
      ) VALUES (1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      ON CONFLICT (id) DO UPDATE SET
        budget_approval_required = EXCLUDED.budget_approval_required,
        allow_offer_above_budget = EXCLUDED.allow_offer_above_budget,
        max_budget_variance_pct = EXCLUDED.max_budget_variance_pct,
        exception_workflow_enabled = EXCLUDED.exception_workflow_enabled,
        approval_chain = EXCLUDED.approval_chain,
        escalation_after_hours = EXCLUDED.escalation_after_hours,
        escalation_to = EXCLUDED.escalation_to,
        auto_reject_above_pct = EXCLUDED.auto_reject_above_pct,
        default_currency = EXCLUDED.default_currency,
        default_headcount_buffer_pct = EXCLUDED.default_headcount_buffer_pct,
        exception_approvers = EXCLUDED.exception_approvers,
        version = EXCLUDED.version,
        version_status = EXCLUDED.version_status,
        effective_from = EXCLUDED.effective_from,
        modified_by = EXCLUDED.modified_by,
        modified_on = NOW()`,
      [
        budget.budget_approval_required ?? true,
        budget.allow_offer_above_budget ?? false,
        budget.max_budget_variance_pct ?? 10,
        budget.exception_workflow_enabled ?? true,
        JSON.stringify(budget.approval_chain || []),
        budget.escalation_after_hours ?? 48,
        budget.escalation_to || null,
        budget.auto_reject_above_pct ?? 25,
        budget.default_currency || "INR",
        budget.default_headcount_buffer_pct ?? 5,
        JSON.stringify(budget.exception_approvers || []),
        version,
        versionStatus,
        effectiveFrom,
        userName
      ]
    );

    await client.query("DELETE FROM pc_notification_channels");
    for (const channel of payload.notification_channels || []) {
      await client.query(
        `INSERT INTO pc_notification_channels (
          channel_key, title, description, enabled, provider, template_count,
          rate_limit_per_hour, version, version_status, effective_from, modified_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          channel.key,
          channel.title,
          channel.description || null,
          channel.enabled,
          channel.provider || null,
          channel.template_count || 0,
          channel.rate_limit_per_hour || 100,
          version,
          versionStatus,
          effectiveFrom,
          userName
        ]
      );
    }

    const notifSettings = payload.notification_settings || {};
    await client.query(
      `INSERT INTO pc_notification_settings (
        id, digest_enabled, digest_frequency, digest_time, quiet_hours_enabled,
        quiet_hours_start, quiet_hours_end, default_sender, retry_attempts,
        escalation_on_failure, version, version_status, effective_from, modified_by
      ) VALUES (1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      ON CONFLICT (id) DO UPDATE SET
        digest_enabled = EXCLUDED.digest_enabled,
        digest_frequency = EXCLUDED.digest_frequency,
        digest_time = EXCLUDED.digest_time,
        quiet_hours_enabled = EXCLUDED.quiet_hours_enabled,
        quiet_hours_start = EXCLUDED.quiet_hours_start,
        quiet_hours_end = EXCLUDED.quiet_hours_end,
        default_sender = EXCLUDED.default_sender,
        retry_attempts = EXCLUDED.retry_attempts,
        escalation_on_failure = EXCLUDED.escalation_on_failure,
        version = EXCLUDED.version,
        version_status = EXCLUDED.version_status,
        effective_from = EXCLUDED.effective_from,
        modified_by = EXCLUDED.modified_by,
        modified_on = NOW()`,
      [
        notifSettings.digest_enabled ?? true,
        notifSettings.digest_frequency || "daily",
        notifSettings.digest_time || "08:00",
        notifSettings.quiet_hours_enabled ?? true,
        notifSettings.quiet_hours_start || "20:00",
        notifSettings.quiet_hours_end || "08:00",
        notifSettings.default_sender || null,
        notifSettings.retry_attempts ?? 3,
        notifSettings.escalation_on_failure ?? true,
        version,
        versionStatus,
        effectiveFrom,
        userName
      ]
    );

    await client.query("DELETE FROM pc_ai_features");
    for (const feature of payload.ai_features || []) {
      await client.query(
        `INSERT INTO pc_ai_features (
          feature_key, title, description, enabled, confidence_min, max_tokens,
          version, version_status, effective_from, modified_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          feature.key,
          feature.title,
          feature.description || null,
          feature.enabled,
          feature.confidence_min ?? 0.7,
          feature.max_tokens ?? 1000,
          version,
          versionStatus,
          effectiveFrom,
          userName
        ]
      );
    }

    const aiGov = payload.ai_governance || {};
    await client.query(
      `INSERT INTO pc_ai_governance (
        id, provider, model, confidence_threshold, monthly_token_limit, tokens_used,
        monthly_cost_cap_usd, cost_mtd_usd, audit_logging, pii_masking,
        require_human_confirmation, data_retention_days, version, version_status,
        effective_from, modified_by
      ) VALUES (1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      ON CONFLICT (id) DO UPDATE SET
        provider = EXCLUDED.provider,
        model = EXCLUDED.model,
        confidence_threshold = EXCLUDED.confidence_threshold,
        monthly_token_limit = EXCLUDED.monthly_token_limit,
        tokens_used = EXCLUDED.tokens_used,
        monthly_cost_cap_usd = EXCLUDED.monthly_cost_cap_usd,
        cost_mtd_usd = EXCLUDED.cost_mtd_usd,
        audit_logging = EXCLUDED.audit_logging,
        pii_masking = EXCLUDED.pii_masking,
        require_human_confirmation = EXCLUDED.require_human_confirmation,
        data_retention_days = EXCLUDED.data_retention_days,
        version = EXCLUDED.version,
        version_status = EXCLUDED.version_status,
        effective_from = EXCLUDED.effective_from,
        modified_by = EXCLUDED.modified_by,
        modified_on = NOW()`,
      [
        aiGov.provider || null,
        aiGov.model || null,
        aiGov.confidence_threshold ?? 0.75,
        aiGov.monthly_token_limit ?? 500000,
        aiGov.tokens_used ?? 0,
        aiGov.monthly_cost_cap_usd ?? 500,
        aiGov.cost_mtd_usd ?? 0,
        aiGov.audit_logging ?? true,
        aiGov.pii_masking ?? true,
        aiGov.require_human_confirmation ?? true,
        aiGov.data_retention_days ?? 90,
        version,
        versionStatus,
        effectiveFrom,
        userName
      ]
    );

    await client.query("DELETE FROM pc_role_visibility");
    const matrix = payload.role_visibility?.matrix || {};
    for (const [roleName, modules] of Object.entries(matrix)) {
      for (const [moduleKey, visible] of Object.entries(modules)) {
        await client.query(
          `INSERT INTO pc_role_visibility (
            role_name, module_key, visible, version, version_status,
            effective_from, modified_by
          ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [roleName, moduleKey, visible, version, versionStatus, effectiveFrom, userName]
        );
      }
    }

    await client.query("DELETE FROM pc_approval_policies");
    const chain = budget.approval_chain || [];
    const seenSequences = new Set();

    for (let index = 0; index < chain.length; index += 1) {
      const approverRole = chain[index];
      const sequence = index + 1;
      if (seenSequences.has(sequence)) {
        continue;
      }
      seenSequences.add(sequence);
      await client.query(
        `INSERT INTO pc_approval_policies (
          policy_key, policy_name, approver_role, sequence_order, policy_type,
          enabled, version, version_status, effective_from, modified_by
        ) VALUES ($1,$2,$3,$4,'budget',TRUE,$5,$6,$7,$8)`,
        [
          `budget-chain-${sequence}`,
          `${approverRole} Approval`,
          approverRole,
          sequence,
          version,
          versionStatus,
          effectiveFrom,
          userName
        ]
      );
    }

    const exceptionApprovers = budget.exception_approvers || [];
    for (let index = 0; index < exceptionApprovers.length; index += 1) {
      const approverRole = exceptionApprovers[index];
      await client.query(
        `INSERT INTO pc_approval_policies (
          policy_key, policy_name, approver_role, sequence_order, policy_type,
          enabled, version, version_status, effective_from, modified_by
        ) VALUES ($1,$2,$3,$4,'exception',TRUE,$5,$6,$7,$8)`,
        [
          `budget-exception-${index + 1}`,
          `${approverRole} Exception`,
          approverRole,
          index + 1,
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

function validateConfiguration(payload) {
  const errors = [];
  const warnings = [];

  const moduleKeys = new Set();
  const moduleMap = {};

  (payload.modules || []).forEach((mod) => {
    if (moduleKeys.has(mod.key)) {
      errors.push(`Duplicate module key: ${mod.key}`);
    }
    moduleKeys.add(mod.key);
    moduleMap[mod.key] = mod;

    if (mod.required && !mod.enabled) {
      errors.push(`Mandatory module "${mod.title}" cannot be disabled.`);
    }
  });

  (payload.modules || []).forEach((mod) => {
    if (mod.enabled && mod.depends_on) {
      const dependency = moduleMap[mod.depends_on];
      if (!dependency) {
        errors.push(`Module "${mod.title}" depends on missing module "${mod.depends_on}".`);
      } else if (!dependency.enabled) {
        errors.push(
          `Module "${mod.title}" cannot be enabled while dependency "${dependency.title}" is disabled.`
        );
      }
    }
  });

  const workflowTitles = new Set();
  (payload.workflows || []).forEach((wf) => {
    if (workflowTitles.has(wf.title)) {
      errors.push(`Duplicate workflow name: ${wf.title}`);
    }
    workflowTitles.add(wf.title);

    const stageSet = new Set();
    (wf.stages || []).forEach((stage) => {
      if (stageSet.has(stage)) {
        errors.push(`Duplicate stage "${stage}" in workflow "${wf.title}".`);
      }
      stageSet.add(stage);
    });

    const invalidTransition =
      wf.status === "Archived" && wf.enabled;
    if (invalidTransition) {
      errors.push(`Workflow "${wf.title}" cannot be enabled while archived.`);
    }
  });

  const budget = payload.budget || {};
  if (budget.max_budget_variance_pct < 0 || budget.max_budget_variance_pct > 100) {
    errors.push("Budget variance percentage must be between 0 and 100.");
  }

  if (budget.auto_reject_above_pct < budget.max_budget_variance_pct) {
    warnings.push("Auto-reject threshold is below max variance — offers may auto-reject unexpectedly.");
  }

  const chain = budget.approval_chain || [];
  const chainDuplicates = chain.filter((item, idx) => chain.indexOf(item) !== idx);
  if (chainDuplicates.length) {
    errors.push(`Conflicting approval policies: duplicate roles in approval chain (${chainDuplicates.join(", ")}).`);
  }

  const exceptionOverlap = (budget.exception_approvers || []).filter((role) => chain.includes(role));
  if (exceptionOverlap.length) {
    warnings.push(`Exception approvers overlap with approval chain: ${exceptionOverlap.join(", ")}.`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}

function applyMutation(draft, action, params) {
  const next = clonePayload(draft);

  switch (action) {
    case "toggleModule": {
      const mod = next.modules.find((item) => item.key === params.key);
      if (!mod) {
        throw httpError(`Module not found: ${params.key}`, 404);
      }
      if (mod.required) {
        throw httpError(`Module "${mod.title}" is mandatory and cannot be toggled.`);
      }
      mod.enabled = !mod.enabled;
      if (mod.enabled && mod.depends_on) {
        const dep = next.modules.find((item) => item.key === mod.depends_on);
        if (dep && !dep.enabled) {
          throw httpError(`Cannot enable "${mod.title}" — dependency "${dep.title}" is disabled.`);
        }
      }
      if (!mod.enabled) {
        next.modules.forEach((item) => {
          if (item.depends_on === mod.key && item.enabled) {
            throw httpError(
              `Cannot disable "${mod.title}" — dependent module "${item.title}" is still enabled.`
            );
          }
        });
      }
      break;
    }

    case "toggleWorkflow": {
      const wf = next.workflows.find((item) => item.key === params.key);
      if (!wf) {
        throw httpError(`Workflow not found: ${params.key}`, 404);
      }
      wf.enabled = !wf.enabled;
      break;
    }

    case "updateBudget": {
      if (!Object.prototype.hasOwnProperty.call(next.budget, params.field)) {
        throw httpError(`Unknown budget field: ${params.field}`, 400);
      }
      next.budget[params.field] = params.value;
      break;
    }

    case "updateNotificationSettings": {
      if (!Object.prototype.hasOwnProperty.call(next.notification_settings, params.field)) {
        throw httpError(`Unknown notification setting: ${params.field}`, 400);
      }
      next.notification_settings[params.field] = params.value;
      break;
    }

    case "updateAiGovernance": {
      if (!Object.prototype.hasOwnProperty.call(next.ai_governance, params.field)) {
        throw httpError(`Unknown AI governance field: ${params.field}`, 400);
      }
      next.ai_governance[params.field] = params.value;
      break;
    }

    case "toggleNotificationChannel": {
      const channel = next.notification_channels.find((item) => item.key === params.key);
      if (!channel) {
        throw httpError(`Notification channel not found: ${params.key}`, 404);
      }
      channel.enabled = !channel.enabled;
      break;
    }

    case "toggleAiFeature": {
      const feature = next.ai_features.find((item) => item.key === params.key);
      if (!feature) {
        throw httpError(`AI feature not found: ${params.key}`, 404);
      }
      feature.enabled = !feature.enabled;
      break;
    }

    case "toggleRoleVisibility": {
      const { role, moduleKey } = params;
      if (!next.role_visibility.matrix[role]) {
        throw httpError(`Role not found: ${role}`, 404);
      }
      if (next.role_visibility.matrix[role][moduleKey] === undefined) {
        throw httpError(`Module not found in visibility matrix: ${moduleKey}`, 404);
      }
      next.role_visibility.matrix[role][moduleKey] =
        !next.role_visibility.matrix[role][moduleKey];
      break;
    }

    case "insertWorkflowStage": {
      const { workflowKey, stageName, afterStageName } = params;
      const wf = next.workflows.find((item) => item.key === workflowKey);
      if (!wf) {
        throw httpError(`Workflow not found: ${workflowKey}`, 404);
      }
      if (wf.stages.includes(stageName)) {
        throw httpError(`Duplicate stage name "${stageName}" in workflow "${wf.title}".`);
      }
      const afterIndex = wf.stages.indexOf(afterStageName);
      if (afterIndex === -1) {
        throw httpError(`Stage "${afterStageName}" not found in workflow "${wf.title}".`, 404);
      }
      const nextStages = [...wf.stages];
      nextStages.splice(afterIndex + 1, 0, stageName);
      wf.stages = nextStages;
      wf.steps = nextStages.length;
      break;
    }

    case "replaceDraft": {
      return clonePayload(params.payload);
    }

    default:
      throw httpError(`Unknown configuration action: ${action}`, 400);
  }

  return next;
}

function auditEventForAction(action, params, previousDraft, nextDraft) {
  switch (action) {
    case "toggleModule": {
      const updated = nextDraft.modules.find((item) => item.key === params.key);
      const previous = previousDraft.modules.find((item) => item.key === params.key);
      return {
        eventType: updated.enabled ? "ModuleEnabled" : "ModuleDisabled",
        entity: "Module",
        entityId: params.key,
        action: `${updated.title} ${updated.enabled ? "enabled" : "disabled"}`,
        previousValue: String(previous?.enabled),
        newValue: String(updated.enabled)
      };
    }
    case "toggleWorkflow":
      return {
        eventType: "WorkflowUpdated",
        entity: "Workflow",
        entityId: params.key,
        action: `Workflow ${params.key} toggled`,
        previousValue: null,
        newValue: null
      };
    case "updateBudget":
      return {
        eventType: "BudgetThresholdChanged",
        entity: "Budget Policy",
        entityId: params.field,
        action: `Budget field ${params.field} updated`,
        previousValue: String(previousDraft.budget[params.field]),
        newValue: String(params.value)
      };
    case "toggleNotificationChannel": {
      const updated = nextDraft.notification_channels.find((item) => item.key === params.key);
      const previous = previousDraft.notification_channels.find((item) => item.key === params.key);
      return {
        eventType: "NotificationChannelUpdated",
        entity: "Notification Channel",
        entityId: params.key,
        action: `${updated.title} ${updated.enabled ? "enabled" : "disabled"}`,
        previousValue: String(previous?.enabled),
        newValue: String(updated.enabled)
      };
    }
    case "updateNotificationSettings":
      return {
        eventType: "NotificationChannelUpdated",
        entity: "Notification Settings",
        entityId: params.field,
        action: `Notification setting ${params.field} updated`,
        previousValue: String(previousDraft.notification_settings[params.field]),
        newValue: String(params.value)
      };
    case "toggleAiFeature":
    case "updateAiGovernance":
      return {
        eventType: "AIConfigurationUpdated",
        entity: action === "toggleAiFeature" ? "AI Feature" : "AI Governance",
        entityId: params.key || params.field,
        action: `AI configuration updated (${action})`,
        previousValue: null,
        newValue: null
      };
    case "toggleRoleVisibility":
      return {
        eventType: "RoleVisibilityChanged",
        entity: "Role Visibility",
        entityId: `${params.role}:${params.moduleKey}`,
        action: `Visibility updated for ${params.role}`,
        previousValue: String(previousDraft.role_visibility.matrix[params.role][params.moduleKey]),
        newValue: String(nextDraft.role_visibility.matrix[params.role][params.moduleKey])
      };
    case "insertWorkflowStage":
      return {
        eventType: "WorkflowUpdated",
        entity: "Workflow",
        entityId: params.workflowKey,
        action: `Stage "${params.stageName}" inserted`,
        previousValue: null,
        newValue: params.stageName
      };
    default:
      return {
        eventType: "PlatformConfigurationUpdated",
        entity: "Platform Config",
        entityId: "platform-config",
        action,
        previousValue: null,
        newValue: null
      };
  }
}

async function applyDraftMutation(pool, req, body) {
  const user = userContext(req);
  const row = await ensureConfigState(pool);
  const previousDraft = clonePayload(row.draft_payload);
  const published = clonePayload(row.published_payload);

  const action = body.action;
  if (!action) {
    throw httpError("action is required", 400);
  }

  const nextDraft = applyMutation(previousDraft, action, body);
  const validation = validateConfiguration(nextDraft);

  if (!validation.valid) {
    throw httpError(validation.errors.join(" "), 400);
  }

  await persistDraft(pool, nextDraft, published, user.name);

  const auditMeta = auditEventForAction(action, body, previousDraft, nextDraft);
  await writeEnterpriseAudit(pool, {
    eventType: auditMeta.eventType,
    module: "Platform Configuration",
    entity: auditMeta.entity,
    entityId: auditMeta.entityId,
    action: auditMeta.action,
    previousValue: auditMeta.previousValue,
    newValue: auditMeta.newValue,
    userName: user.name,
    userRole: user.role,
    metadata: { action, ...body }
  });

  const updatedRow = await fetchConfigState(pool);
  return buildBundle(updatedRow);
}

async function publishConfiguration(pool, req, reason = "") {
  const user = userContext(req);
  const row = await ensureConfigState(pool);
  const draft = clonePayload(row.draft_payload);
  const validation = validateConfiguration(draft);

  if (!validation.valid) {
    throw httpError(validation.errors.join(" "), 400);
  }

  const nextVersion = Number((Number(row.version) + 0.1).toFixed(1));
  const now = new Date();
  const published = clonePayload(draft);
  published.meta = {
    ...published.meta,
    last_published: now.toISOString(),
    draft_changes: 0
  };

  await pool.query(
    `UPDATE pc_config_state
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
    `INSERT INTO pc_config_snapshots (
      version, status, payload, effective_from, created_by, reason
    ) VALUES ($1, 'Published', $2, $3, $4, $5)`,
    [nextVersion, JSON.stringify(published), now, user.name, reason || "Configuration published"]
  );

  await syncNormalizedTables(pool, published, user.name, nextVersion, "Published");

  await writeEnterpriseAudit(pool, {
    eventType: "PlatformConfigurationPublished",
    module: "Platform Configuration",
    entity: "Platform Config",
    entityId: "platform-config",
    action: "Platform configuration published",
    previousValue: String(Number(row.version).toFixed(1)),
    newValue: String(nextVersion),
    userName: user.name,
    userRole: user.role,
    metadata: { reason }
  });

  const updatedRow = await fetchConfigState(pool);
  return buildBundle(updatedRow);
}

async function discardDraft(pool, req) {
  const user = userContext(req);
  const row = await ensureConfigState(pool);
  const published = clonePayload(row.published_payload);

  await pool.query(
    `UPDATE pc_config_state
     SET draft_payload = $1,
         modified_by = $2,
         modified_on = NOW()
     WHERE id = 1`,
    [JSON.stringify(published), user.name]
  );

  await writeEnterpriseAudit(pool, {
    eventType: "PlatformConfigurationDiscarded",
    module: "Platform Configuration",
    entity: "Platform Config",
    entityId: "platform-config",
    action: "Draft changes discarded",
    userName: user.name,
    userRole: user.role
  });

  const updatedRow = await fetchConfigState(pool);
  return buildBundle(updatedRow);
}

async function restoreSnapshot(pool, snapshotId, req, reason = "") {
  const user = userContext(req);
  const snapshotResult = await pool.query(
    "SELECT * FROM pc_config_snapshots WHERE snapshot_id = $1",
    [snapshotId]
  );

  if (!snapshotResult.rows.length) {
    throw httpError("Snapshot not found", 404);
  }

  const snapshot = snapshotResult.rows[0];
  const restored = clonePayload(snapshot.payload);
  const validation = validateConfiguration(restored);

  if (!validation.valid) {
    throw httpError(validation.errors.join(" "), 400);
  }

  const nextVersion = Number((Number(restored.meta?.version || snapshot.version) + 0.1).toFixed(1));
  restored.meta = {
    ...restored.meta,
    last_published: new Date().toISOString(),
    draft_changes: 0
  };

  await pool.query(
    `UPDATE pc_config_state
     SET draft_payload = $1,
         published_payload = $2,
         version = $3,
         version_status = 'Published',
         modified_by = $4,
         modified_on = NOW()
     WHERE id = 1`,
    [JSON.stringify(restored), JSON.stringify(restored), nextVersion, user.name]
  );

  await pool.query(
    `INSERT INTO pc_config_snapshots (
      version, status, payload, effective_from, created_by, reason
    ) VALUES ($1, 'Published', $2, NOW(), $3, $4)`,
    [nextVersion, JSON.stringify(restored), user.name, reason || `Restored from snapshot ${snapshotId}`]
  );

  await syncNormalizedTables(pool, restored, user.name, nextVersion, "Published");

  await writeEnterpriseAudit(pool, {
    eventType: "PlatformConfigurationRestored",
    module: "Platform Configuration",
    entity: "Platform Config",
    entityId: String(snapshotId),
    action: `Configuration restored from snapshot ${snapshotId}`,
    previousValue: null,
    newValue: String(nextVersion),
    userName: user.name,
    userRole: user.role,
    metadata: { reason, snapshotId }
  });

  const updatedRow = await fetchConfigState(pool);
  return buildBundle(updatedRow);
}

async function archiveConfiguration(pool, req, reason = "") {
  const user = userContext(req);
  const row = await ensureConfigState(pool);

  if (row.version_status === "Archived") {
    throw httpError("Configuration is already archived.", 400);
  }

  await pool.query(
    `UPDATE pc_config_state
     SET version_status = 'Archived',
         effective_to = NOW(),
         modified_by = $1,
         modified_on = NOW()
     WHERE id = 1`,
    [user.name]
  );

  await writeEnterpriseAudit(pool, {
    eventType: "PlatformConfigurationArchived",
    module: "Platform Configuration",
    entity: "Platform Config",
    entityId: "platform-config",
    action: "Configuration archived",
    userName: user.name,
    userRole: user.role,
    metadata: { reason }
  });

  const updatedRow = await fetchConfigState(pool);
  return buildBundle(updatedRow);
}

async function exportConfiguration(pool) {
  const bundle = await getConfigBundle(pool);
  return {
    exportedAt: new Date().toISOString(),
    version: bundle.version,
    payload: bundle.baseline
  };
}

async function previewImport(pool, payload) {
  const validation = validateConfiguration(payload);
  const current = await getConfigBundle(pool);

  const currentModuleKeys = new Set((current.config.modules || []).map((item) => item.key));
  const importModuleKeys = (payload.modules || []).map((item) => item.key);
  const missingMandatory = (payload.modules || [])
    .filter((item) => item.required && !item.enabled)
    .map((item) => item.key);

  const newModules = importModuleKeys.filter((key) => !currentModuleKeys.has(key));

  return {
    valid: validation.valid && missingMandatory.length === 0,
    errors: [
      ...validation.errors,
      ...missingMandatory.map((key) => `Mandatory module "${key}" must remain enabled.`)
    ],
    warnings: validation.warnings,
    summary: {
      moduleCount: importModuleKeys.length,
      newModules,
      workflowCount: (payload.workflows || []).length
    }
  };
}

async function commitImport(pool, payload, req, reason = "") {
  const preview = await previewImport(pool, payload);

  if (!preview.valid) {
    throw httpError(preview.errors.join(" "), 400);
  }

  const user = userContext(req);
  const row = await ensureConfigState(pool);
  const imported = clonePayload(payload);
  imported.meta = {
    ...imported.meta,
    draft_changes: computeDraftChanges(imported, row.published_payload)
  };

  await persistDraft(pool, imported, row.published_payload, user.name);

  await writeEnterpriseAudit(pool, {
    eventType: "PlatformConfigurationImported",
    module: "Platform Configuration",
    entity: "Platform Config",
    entityId: "platform-config",
    action: "Configuration import applied to draft",
    userName: user.name,
    userRole: user.role,
    metadata: { reason, ...preview.summary }
  });

  const updatedRow = await fetchConfigState(pool);
  return { ...buildBundle(updatedRow), importSummary: preview.summary };
}

async function listSnapshots(pool) {
  const result = await pool.query(
    `SELECT snapshot_id, version, status, effective_from, created_by, created_on, reason
     FROM pc_config_snapshots
     ORDER BY snapshot_id DESC`
  );

  return result.rows.map((row) => ({
    snapshotId: row.snapshot_id,
    version: String(Number(row.version).toFixed(1)),
    status: row.status,
    effectiveFrom: row.effective_from?.toISOString?.() || null,
    createdBy: row.created_by,
    createdOn: row.created_on?.toISOString?.() || null,
    reason: row.reason
  }));
}

async function seedConfiguration(pool, payload, user = { name: "System Seed", role: "Admin" }) {
  const seed = clonePayload(payload);
  seed.meta.draft_changes = 0;

  await pool.query("DELETE FROM pc_config_state WHERE id = 1");
  await pool.query("DELETE FROM pc_config_snapshots");

  await pool.query(
    `INSERT INTO pc_config_state (
      id, draft_payload, published_payload, version, version_status,
      effective_from, created_by, modified_by
    ) VALUES (1, $1, $2, 1.0, 'Published', NOW(), $3, $3)`,
    [JSON.stringify(seed), JSON.stringify(seed), user.name]
  );

  await pool.query(
    `INSERT INTO pc_config_snapshots (version, status, payload, effective_from, created_by, reason)
     VALUES (1.0, 'Published', $1, NOW(), $2, 'Initial seed')`,
    [JSON.stringify(seed), user.name]
  );

  await syncNormalizedTables(pool, seed, user.name, 1.0, "Published");
}

module.exports = {
  getDefaultSeedPayload,
  getConfigBundle,
  applyDraftMutation,
  publishConfiguration,
  discardDraft,
  restoreSnapshot,
  archiveConfiguration,
  validateConfiguration,
  exportConfiguration,
  previewImport,
  commitImport,
  listSnapshots,
  seedConfiguration,
  syncNormalizedTables
};
