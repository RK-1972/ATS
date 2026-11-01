/**
 * OTI Phase 6 — intelligent multi-strategy query generation per connector capabilities.
 */

const crypto = require("crypto");
const { CONNECTOR_CAPABILITIES } = require("./connectors/otiConnectorContract");
const { getActiveProvider } = require("./ai/otiAiProviderRegistry");
const otiAiGovernanceService = require("./otiAiGovernanceService");
const { buildWebSearchCandidateQuery } = require("./connectors/otiWebSearchCandidateQuery");

const STRATEGY_TYPES = Object.freeze([
  "exact_job_title",
  "equivalent_job_title",
  "mandatory_skill_combination",
  "related_skill_combination",
  "technology_stack",
  "experience_seniority",
  "transferable_skill",
  "professional_profile"
]);

function hashQuery(text) {
  return crypto.createHash("sha256").update(String(text || "")).digest("hex");
}

function uniqueQueries(entries) {
  const seen = new Set();
  const output = [];

  for (const entry of entries) {
    const key = hashQuery(entry.query_text);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    output.push({ ...entry, query_hash: key });
  }

  return output;
}

function buildDeterministicStrategies(jdProfile, connectors, requisition = null) {
  const title = jdProfile.normalized_job_title || "software engineer";
  const mandatory = (jdProfile.mandatory_skills || []).slice(0, 4);
  const related = (jdProfile.related_skills || jdProfile.transferable_skills || []).slice(0, 3);
  const tech = (jdProfile.technologies || mandatory).slice(0, 4);
  const seniority = jdProfile.seniority || "";

  const reqContext = {
    job_title: requisition?.job_title || requisition?.position_title || title,
    position_title: requisition?.position_title || requisition?.job_title || title,
    location: requisition?.location || requisition?.work_location || null,
    work_location: requisition?.work_location || requisition?.location || null,
    preferred_location: requisition?.preferred_location || null,
    experience_min:
      requisition?.experience_min ?? jdProfile.experience_expectations?.min_years ?? null,
    experience_max:
      requisition?.experience_max ?? jdProfile.experience_expectations?.max_years ?? null
  };

  const strategies = [
    {
      strategy_id: "exact-title",
      strategy_type: "exact_job_title",
      description: "Exact job title search",
      query_text: title
    },
    {
      strategy_id: "equiv-title",
      strategy_type: "equivalent_job_title",
      description: "Equivalent title with core skills",
      query_text: `${title} ${mandatory.slice(0, 2).join(" ")}`.trim()
    },
    {
      strategy_id: "mandatory-skills",
      strategy_type: "mandatory_skill_combination",
      description: "Mandatory skill combination",
      query_text: mandatory.join(" ")
    },
    {
      strategy_id: "related-skills",
      strategy_type: "related_skill_combination",
      description: "Related and adjacent skills",
      query_text: [...mandatory.slice(0, 1), ...related].join(" ")
    },
    {
      strategy_id: "tech-stack",
      strategy_type: "technology_stack",
      description: "Technology stack focus",
      query_text: tech.join(" ")
    },
    {
      strategy_id: "experience",
      strategy_type: "experience_seniority",
      description: "Experience and seniority oriented search",
      query_text: `${seniority} ${title} ${mandatory.slice(0, 2).join(" ")}`.trim()
    },
    {
      strategy_id: "transferable",
      strategy_type: "transferable_skill",
      description: "Transferable skill search",
      query_text: (jdProfile.transferable_skills || related).slice(0, 4).join(" ")
    },
    {
      strategy_id: "profile",
      strategy_type: "professional_profile",
      description: "Professional profile discovery",
      query_text: `${title} portfolio ${tech.slice(0, 2).join(" ")}`.trim()
    }
  ].filter((row) => String(row.query_text || "").trim());

  const deduped = uniqueQueries(strategies);

  const providerQueries = {};
  for (const connector of connectors || []) {
    providerQueries[connector.provider_key] = adaptQueryForConnector(
      connector,
      deduped,
      jdProfile,
      reqContext
    );
  }

  return {
    schema_version: "oti_search_strategy_v1",
    source: "deterministic",
    strategies: deduped,
    provider_queries: providerQueries,
    deduplicated_query_hashes: deduped.map((row) => row.query_hash)
  };
}

function adaptQueryForConnector(connector, strategies, jdProfile, requisition = null) {
  const caps = new Set(connector.capabilities || []);
  const title = jdProfile.normalized_job_title || "";
  const mandatory = (jdProfile.mandatory_skills || []).slice(0, 3).join(" ");
  const tech = (jdProfile.technologies || []).slice(0, 3).join(" ");

  if (caps.has(CONNECTOR_CAPABILITIES.GITHUB)) {
    const techStrategy =
      strategies.find((row) => row.strategy_type === "technology_stack") ||
      strategies.find((row) => row.strategy_type === "mandatory_skill_combination");
    return `${techStrategy?.query_text || `${mandatory} ${tech}`.trim()}`.trim();
  }

  if (caps.has(CONNECTOR_CAPABILITIES.PROFESSIONAL_NETWORK)) {
    const profileStrategy = strategies.find((row) => row.strategy_type === "professional_profile");
    return `${profileStrategy?.query_text || `${title} ${mandatory}`.trim()}`.trim();
  }

  if (caps.has(CONNECTOR_CAPABILITIES.WEB_SEARCH) || caps.has(CONNECTOR_CAPABILITIES.PROFILE_SEARCH)) {
    return buildWebSearchCandidateQuery({
      queryText: strategies.find((row) => row.strategy_type === "professional_profile")?.query_text,
      structuredQuery: { skill_tokens: (jdProfile.mandatory_skills || mandatory.split(" ")).filter(Boolean) },
      requisition: requisition || {
        job_title: title,
        position_title: title,
        experience_min: jdProfile.experience_expectations?.min_years ?? null,
        experience_max: jdProfile.experience_expectations?.max_years ?? null
      }
    });
  }

  const fallback = strategies[0]?.query_text || `${title} ${mandatory}`.trim();
  return fallback;
}

const QUERY_SYSTEM_PROMPT = `You generate distinct recruiter search strategies for Optalynx OTI.
Return JSON: { "strategies": [ { "strategy_id", "strategy_type", "description", "query_text", "provider_queries": { "<provider_key>": "..." } } ] }
Use only provider keys supplied. Do not repeat identical query_text values. Avoid overly restrictive boolean-only expressions.`;

async function generateSearchStrategies(pool, runId, jdProfile, connectors, options = {}) {
  const { useAi = false, tracker, provider = getActiveProvider(), requisition = null } = options;
  const deterministic = buildDeterministicStrategies(jdProfile, connectors, requisition);

  if (!useAi || !(connectors || []).length) {
    return {
      bundle: deterministic,
      used_ai: false,
      fallback_reason: null
    };
  }

  try {
    otiAiGovernanceService.assertWithinRunLimits(tracker);

    const connectorBrief = (connectors || []).map((row) => ({
      provider_key: row.provider_key,
      capabilities: row.capabilities,
      configured: Boolean(row.configuration?.configured),
      health_status: row.health?.status || null
    }));

    const result = await provider.completeStructuredJson({
      systemPrompt: QUERY_SYSTEM_PROMPT,
      userPrompt: JSON.stringify({
        jd_profile: jdProfile,
        connectors: connectorBrief,
        allowed_strategy_types: STRATEGY_TYPES
      }),
      responseLabel: "search_strategy_generation"
    });

    const aiStrategies = Array.isArray(result.json?.strategies) ? result.json.strategies : [];
    const normalized = uniqueQueries(
      aiStrategies
        .map((row, index) => ({
          strategy_id: String(row.strategy_id || `ai-strategy-${index + 1}`),
          strategy_type: STRATEGY_TYPES.includes(row.strategy_type)
            ? row.strategy_type
            : "related_skill_combination",
          description: String(row.description || "AI-generated strategy").trim(),
          query_text: String(row.query_text || "").trim()
        }))
        .filter((row) => row.query_text)
    );

    const providerQueries = { ...deterministic.provider_queries };
    for (const strategy of aiStrategies) {
      const perProvider = strategy.provider_queries || {};
      for (const [providerKey, queryText] of Object.entries(perProvider)) {
        if (!providerQueries[providerKey] && String(queryText || "").trim()) {
          providerQueries[providerKey] = String(queryText).trim();
        }
      }
    }

    for (const connector of connectors) {
      if (!providerQueries[connector.provider_key]) {
        providerQueries[connector.provider_key] = adaptQueryForConnector(
          connector,
          normalized.length ? normalized : deterministic.strategies,
          jdProfile,
          requisition
        );
      }
    }

    const bundle = {
      schema_version: "oti_search_strategy_v1",
      source: "ai",
      strategies: normalized.length ? normalized : deterministic.strategies,
      provider_queries: providerQueries,
      deduplicated_query_hashes: (normalized.length ? normalized : deterministic.strategies).map(
        (row) => row.query_hash
      )
    };

    const cost = otiAiGovernanceService.estimateCostUsd(
      result.usage.total_tokens,
      result.model_id
    );

    await otiAiGovernanceService.recordSuccessfulAiCall(pool, runId, tracker, {
      model_provider: result.model_provider,
      model_id: result.model_id,
      request_type: "search_strategy_generation",
      input_tokens: result.usage.input_tokens,
      output_tokens: result.usage.output_tokens,
      total_tokens: result.usage.total_tokens,
      estimated_cost_usd: cost
    });

    return {
      bundle,
      used_ai: true,
      fallback_reason: null
    };
  } catch (error) {
    tracker.limitation_notes.push(
      `Search strategy AI unavailable (${error.message}); deterministic strategies used.`
    );

    return {
      bundle: deterministic,
      used_ai: false,
      fallback_reason: error.message
    };
  }
}

module.exports = {
  STRATEGY_TYPES,
  buildDeterministicStrategies,
  generateSearchStrategies,
  adaptQueryForConnector,
  hashQuery
};
