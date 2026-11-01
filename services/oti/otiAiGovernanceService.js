/**
 * OTI Phase 6 — AI governance, cost tracking, and per-run limits.
 */

const { getActiveProvider, resolveActiveProviderKey } = require("./ai/otiAiProviderRegistry");

const FEATURE_KEY = "oti_ai_assist";
const MAX_CALLS_PER_RUN = Number(process.env.OTI_AI_MAX_CALLS_PER_RUN || 4);
const MAX_TOKENS_PER_RUN = Number(process.env.OTI_AI_MAX_TOKENS_PER_RUN || 12000);

async function loadPlatformConfig(pool) {
  const result = await pool.query("SELECT published_payload FROM pc_config_state WHERE id = 1");
  return result.rows[0]?.published_payload || null;
}

function isAiModuleEnabled(platformConfig) {
  const aiModule = platformConfig?.modules?.find((item) => item.key === "ai");
  return Boolean(aiModule?.enabled);
}

function isOtiAiAssistFeatureEnabled(platformConfig) {
  if (!isAiModuleEnabled(platformConfig)) {
    return false;
  }

  const features = platformConfig?.ai_features || [];
  const dedicated = features.find((item) => item.key === FEATURE_KEY);

  if (dedicated) {
    return Boolean(dedicated.enabled);
  }

  const oti = features.find((item) => item.key === "talent_intelligence");
  return Boolean(oti?.enabled);
}

function isReasoningProviderConfigured() {
  return Boolean(getActiveProvider().getConfiguration().configured);
}

async function getAiAssistAvailability(pool) {
  const platformConfig = await loadPlatformConfig(pool);

  return {
    feature_enabled: isOtiAiAssistFeatureEnabled(platformConfig),
    provider_configured: isReasoningProviderConfigured(),
    available:
      isOtiAiAssistFeatureEnabled(platformConfig) && isReasoningProviderConfigured(),
    limits: {
      max_calls_per_run: MAX_CALLS_PER_RUN,
      max_tokens_per_run: MAX_TOKENS_PER_RUN
    },
    active_provider: resolveActiveProviderKey()
  };
}

function httpError(message, status = 403) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function assertAiAssistEnabled(pool) {
  const availability = await getAiAssistAvailability(pool);

  if (!availability.feature_enabled) {
    throw httpError("OTI AI-assisted sourcing is disabled in platform configuration.", 403);
  }

  if (!availability.provider_configured) {
    throw httpError(
      "OTI AI-assisted sourcing requires a configured reasoning provider on the backend.",
      503
    );
  }

  return availability;
}

function createRunUsageTracker() {
  return {
    calls: 0,
    total_tokens: 0,
    estimated_cost_usd: 0,
    call_types: [],
    limitation_notes: []
  };
}

function estimateCostUsd(totalTokens, modelId) {
  const model = String(modelId || "").toLowerCase();
  const per1k = model.includes("gpt-4o") && !model.includes("mini") ? 0.005 : 0.0003;
  return Number(((Number(totalTokens || 0) / 1000) * per1k).toFixed(6));
}

function assertWithinRunLimits(tracker) {
  if (tracker.calls >= MAX_CALLS_PER_RUN) {
    throw httpError("OTI AI call limit reached for this sourcing run.", 429);
  }

  if (tracker.total_tokens >= MAX_TOKENS_PER_RUN) {
    throw httpError("OTI AI token limit reached for this sourcing run.", 429);
  }
}

async function logAiUsage(pool, runId, payload) {
  try {
    await pool.query(
      `INSERT INTO oti_ai_usage_log (
         run_id, model_provider, model_id, request_type,
         input_tokens, output_tokens, total_tokens, estimated_cost_usd,
         success, error_message
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        runId || null,
        payload.model_provider,
        payload.model_id,
        payload.request_type,
        payload.input_tokens || 0,
        payload.output_tokens || 0,
        payload.total_tokens || 0,
        payload.estimated_cost_usd || 0,
        payload.success !== false,
        payload.error_message || null
      ]
    );
  } catch {
    // best-effort when migration not applied
  }
}

async function recordSuccessfulAiCall(pool, runId, tracker, payload) {
  tracker.calls += 1;
  tracker.total_tokens += Number(payload.total_tokens || 0);
  tracker.estimated_cost_usd += Number(payload.estimated_cost_usd || 0);
  tracker.call_types.push(payload.request_type);

  await logAiUsage(pool, runId, { ...payload, success: true });
}

function buildUsageSummary(tracker) {
  return {
    ai_calls: tracker.calls,
    total_tokens: tracker.total_tokens,
    estimated_cost_usd: Number(tracker.estimated_cost_usd.toFixed(6)),
    call_types: tracker.call_types,
    limitation_notes: tracker.limitation_notes
  };
}

module.exports = {
  FEATURE_KEY,
  getAiAssistAvailability,
  assertAiAssistEnabled,
  createRunUsageTracker,
  assertWithinRunLimits,
  recordSuccessfulAiCall,
  buildUsageSummary,
  estimateCostUsd,
  isReasoningProviderConfigured
};
