/**
 * OTI Phase 6 — AI-assisted connector selection with deterministic safeguards.
 */

const { CONNECTOR_CAPABILITIES } = require("./connectors/otiConnectorContract");
const { getActiveProvider } = require("./ai/otiAiProviderRegistry");
const otiAiGovernanceService = require("./otiAiGovernanceService");
const { normalizeProviderKey } = require("./connectors/otiConnectorRunner");

function scoreConnectorRelevance(connector, jdProfile) {
  const caps = new Set(connector.capabilities || []);
  let score = 0;

  const techHeavy = (jdProfile.technologies || jdProfile.mandatory_skills || []).length >= 2;

  if (techHeavy && caps.has(CONNECTOR_CAPABILITIES.GITHUB)) {
    score += 3;
  }

  if (caps.has(CONNECTOR_CAPABILITIES.PROFESSIONAL_NETWORK)) {
    score += 2;
  }

  if (caps.has(CONNECTOR_CAPABILITIES.WEB_SEARCH) || caps.has(CONNECTOR_CAPABILITIES.PROFILE_SEARCH)) {
    score += 2;
  }

  if (caps.has(CONNECTOR_CAPABILITIES.PORTFOLIO)) {
    score += 1;
  }

  return score;
}

function buildDeterministicSelection(catalog, jdProfile, explicitProviderKeys = []) {
  const selected = [];
  const skipped = [];

  for (const connector of catalog || []) {
    const configured = Boolean(connector.configuration?.configured);
    const healthStatus = connector.health?.status || "unknown";
    const operational =
      configured && healthStatus !== "unavailable" && healthStatus !== "not_configured";

    if (explicitProviderKeys.length > 0 && !explicitProviderKeys.includes(connector.provider_key)) {
      skipped.push({
        provider_key: connector.provider_key,
        reason: "Excluded by recruiter provider filter."
      });
      continue;
    }

    if (!configured) {
      skipped.push({
        provider_key: connector.provider_key,
        reason: "Connector is not configured (missing credentials)."
      });
      continue;
    }

    if (!operational) {
      skipped.push({
        provider_key: connector.provider_key,
        reason: `Connector health is ${healthStatus}.`
      });
      continue;
    }

    const permissions = connector.permissions || {};
    if (permissions.profile_search === false && permissions.profile_read === false) {
      skipped.push({
        provider_key: connector.provider_key,
        reason: "Connector permissions do not allow profile search."
      });
      continue;
    }

    selected.push({
      provider_key: connector.provider_key,
      display_name: connector.display_name,
      configured: true,
      health_status: healthStatus,
      relevance_score: scoreConnectorRelevance(connector, jdProfile),
      reason: "Selected based on configured status, health, and role relevance."
    });
  }

  selected.sort((left, right) => right.relevance_score - left.relevance_score);

  return {
    schema_version: "oti_provider_selection_v1",
    source: "deterministic",
    selected_providers: selected,
    skipped_providers: skipped,
    selected_provider_keys: selected.map((row) => row.provider_key)
  };
}

const SOURCE_SELECTION_PROMPT = `Recommend external sourcing connectors for a requisition.
Return JSON: { "selected_provider_keys": [], "skipped": [ { "provider_key", "reason" } ], "notes": [] }
Only choose from supplied provider keys that are configured and healthy. Never invent providers.`;

async function selectSourceProviders(pool, runId, jdProfile, catalog, options = {}) {
  const {
    useAi = false,
    tracker,
    provider = getActiveProvider(),
    explicitProviderKeys = []
  } = options;

  const deterministic = buildDeterministicSelection(catalog, jdProfile, explicitProviderKeys);

  if (!useAi) {
    return {
      selection: deterministic,
      used_ai: false,
      fallback_reason: null
    };
  }

  const eligible = (catalog || []).map((row) => ({
    provider_key: row.provider_key,
    display_name: row.display_name,
    capabilities: row.capabilities,
    configured: Boolean(row.configuration?.configured),
    health_status: row.health?.status,
    permissions: row.permissions || null
  }));

  try {
    otiAiGovernanceService.assertWithinRunLimits(tracker);

    const result = await provider.completeStructuredJson({
      systemPrompt: SOURCE_SELECTION_PROMPT,
      userPrompt: JSON.stringify({
        jd_profile: jdProfile,
        connectors: eligible,
        explicit_provider_keys: explicitProviderKeys
      }),
      responseLabel: "source_selection"
    });

    const allowedKeys = new Set(
      eligible.filter((row) => row.configured).map((row) => row.provider_key)
    );

    const aiKeys = (result.json?.selected_provider_keys || [])
      .map((key) => normalizeProviderKey(key))
      .filter((key) => allowedKeys.has(key));

    const finalKeys =
      aiKeys.length > 0 ? aiKeys : deterministic.selected_provider_keys;

    const selected = deterministic.selected_providers.filter((row) =>
      finalKeys.includes(row.provider_key)
    );

    const skipped = [...deterministic.skipped_providers];

    for (const row of eligible) {
      if (allowedKeys.has(row.provider_key) && !finalKeys.includes(row.provider_key)) {
        skipped.push({
          provider_key: row.provider_key,
          reason: "Not prioritized by AI source selection."
        });
      }
    }

    const selection = {
      schema_version: "oti_provider_selection_v1",
      source: "ai",
      selected_providers: selected,
      skipped_providers: skipped,
      selected_provider_keys: finalKeys,
      ai_notes: Array.isArray(result.json?.notes) ? result.json.notes : []
    };

    const cost = otiAiGovernanceService.estimateCostUsd(
      result.usage.total_tokens,
      result.model_id
    );

    await otiAiGovernanceService.recordSuccessfulAiCall(pool, runId, tracker, {
      model_provider: result.model_provider,
      model_id: result.model_id,
      request_type: "source_selection",
      input_tokens: result.usage.input_tokens,
      output_tokens: result.usage.output_tokens,
      total_tokens: result.usage.total_tokens,
      estimated_cost_usd: cost
    });

    return {
      selection,
      used_ai: true,
      fallback_reason: null
    };
  } catch (error) {
    tracker.limitation_notes.push(
      `Source selection AI unavailable (${error.message}); deterministic selection used.`
    );

    return {
      selection: deterministic,
      used_ai: false,
      fallback_reason: error.message
    };
  }
}

module.exports = {
  buildDeterministicSelection,
  selectSourceProviders,
  scoreConnectorRelevance
};
