/**
 * Multi-provider external discovery metrics and consolidated totals.
 */

const { SEARCH_OUTCOME } = require("./connectors/otiConnectorContract");
const { isQualifyingExternalLead } = require("./otiRecommendationQualification");

const PROVIDER_DISPLAY_NAMES = Object.freeze({
  serper_web_search: "Serper",
  brave_search: "Brave",
  bing_web_search: "Bing",
  github: "GitHub",
  linkedin_licensed: "LinkedIn"
});

function providerDisplayName(providerKey) {
  const key = String(providerKey || "").trim();
  return PROVIDER_DISPLAY_NAMES[key] || key || "Unknown";
}

function emptyProviderMetric() {
  return {
    discovered: 0,
    resume_candidates: 0,
    profile_references: 0,
    rejected: 0,
    resume_retrieved: 0,
    ingest_failed: 0,
    reuse_qualification_skipped: 0,
    parsed_qualified: 0,
    connector_outcome: SEARCH_OUTCOME.OK,
    connector_message: null,
    code_search_errors: []
  };
}

function bumpMetric(metrics, providerKey, field, amount = 1) {
  const key = String(providerKey || "unknown").trim() || "unknown";

  if (!metrics[key]) {
    metrics[key] = emptyProviderMetric();
  }

  metrics[key][field] += amount;
}

function countProfilesByProvider(profiles) {
  const counts = {};

  for (const profile of profiles || []) {
    const key = profile?.provider_key || "unknown";
    counts[key] = (counts[key] || 0) + 1;
  }

  return counts;
}

function applyConnectorResults(metrics, connectorResults = []) {
  for (const result of connectorResults) {
    const key = result.provider_key || "unknown";

    if (!metrics[key]) {
      metrics[key] = emptyProviderMetric();
    }

    metrics[key].connector_outcome = result.outcome || SEARCH_OUTCOME.OK;
    metrics[key].connector_message = result.message || null;

    if (Array.isArray(result.code_search_errors) && result.code_search_errors.length) {
      metrics[key].code_search_errors = result.code_search_errors;
    }

    if (result.outcome !== SEARCH_OUTCOME.OK) {
      continue;
    }

    metrics[key].discovered = (result.profiles || []).length;
  }
}

function buildProviderMetrics({
  connectorResults = [],
  rawProfiles = [],
  filtered = {},
  staged = [],
  ingestFailures = [],
  reuseQualificationSkips = [],
  qualifyingStaged = []
}) {
  const metrics = {};

  applyConnectorResults(metrics, connectorResults);

  for (const [providerKey, count] of Object.entries(countProfilesByProvider(rawProfiles))) {
    bumpMetric(metrics, providerKey, "discovered", 0);
    metrics[providerKey].discovered = Math.max(metrics[providerKey].discovered, count);
  }

  for (const profile of filtered.resumeCandidates || []) {
    bumpMetric(metrics, profile.provider_key, "resume_candidates");
  }

  for (const profile of filtered.profileReferences || []) {
    bumpMetric(metrics, profile.provider_key, "profile_references");
  }

  for (const row of filtered.rejected || []) {
    bumpMetric(metrics, row.provider_key, "rejected");
  }

  const stagedLeadIds = new Set();

  for (const entry of staged) {
    bumpMetric(metrics, entry.profile?.provider_key, "resume_retrieved");

    if (entry.external_lead_id) {
      stagedLeadIds.add(entry.external_lead_id);
    }

    for (const source of entry.source_providers || []) {
      bumpMetric(metrics, source.provider_key, "resume_retrieved", 0);
    }
  }

  for (const failure of ingestFailures) {
    bumpMetric(metrics, failure.provider_key, "ingest_failed");
  }

  for (const skip of reuseQualificationSkips) {
    bumpMetric(metrics, skip.provider_key, "reuse_qualification_skipped");
  }

  for (const entry of qualifyingStaged) {
    bumpMetric(metrics, entry.profile?.provider_key, "parsed_qualified");
  }

  return Object.fromEntries(
    Object.entries(metrics).map(([providerKey, row]) => [
      providerKey,
      {
        ...row,
        display_name: providerDisplayName(providerKey)
      }
    ])
  );
}

function buildConsolidatedTotals(providerMetrics = {}, discoveryFilter = {}, staged = [], qualifyingStaged = []) {
  const providers = Object.values(providerMetrics);

  return {
    providers_executed: providers.length,
    providers_succeeded: providers.filter((row) => row.connector_outcome === SEARCH_OUTCOME.OK).length,
    providers_failed: providers.filter((row) => row.connector_outcome !== SEARCH_OUTCOME.OK).length,
    discovered: providers.reduce((sum, row) => sum + row.discovered, 0),
    resume_candidates: discoveryFilter.resume_document_candidates || 0,
    profile_references: discoveryFilter.profile_references || 0,
    rejected: discoveryFilter.rejected_non_candidates || 0,
    resume_retrieved: staged.length,
    ingest_failed: discoveryFilter.ingest_failures || 0,
    reuse_qualification_skipped: discoveryFilter.reuse_qualification_skips || 0,
    parsed_qualified: qualifyingStaged.length,
    unique_staged_leads: new Set(staged.map((entry) => entry.external_lead_id)).size
  };
}

function consolidateStagedEntries(stagedEntries = []) {
  const byLeadId = new Map();

  for (const entry of stagedEntries) {
    const leadId = entry.external_lead_id;

    if (!leadId) {
      continue;
    }

    const existing = byLeadId.get(leadId);

    if (!existing) {
      byLeadId.set(leadId, {
        ...entry,
        source_providers: buildSourceProviders(entry)
      });
      continue;
    }

    existing.source_providers = mergeSourceProviders(existing.source_providers, buildSourceProviders(entry));

    if ((entry.explanation?.match_score || 0) > (existing.explanation?.match_score || 0)) {
      existing.explanation = entry.explanation;
      existing.profile = {
        ...existing.profile,
        ...entry.profile,
        provider_key: entry.profile?.provider_key || existing.profile?.provider_key
      };
      existing.rank_order = entry.rank_order;
    }
  }

  return Array.from(byLeadId.values());
}

function buildSourceProviders(entry) {
  const primary = {
    provider_key: entry.profile?.provider_key,
    profile_url: entry.profile?.profile_url,
    source_attribution: entry.profile?.source_attribution || null
  };

  const extras = Array.isArray(entry.additional_sources) ? entry.additional_sources : [];

  return [primary, ...extras].filter((row) => row.provider_key && row.profile_url);
}

function mergeSourceProviders(left = [], right = []) {
  const seen = new Set();
  const output = [];

  for (const row of [...left, ...right]) {
    const key = `${row.provider_key}:${String(row.profile_url || "").toLowerCase()}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    output.push(row);
  }

  return output;
}

function mapExternalLeadRow(entry) {
  const sources = entry.source_providers || buildSourceProviders(entry);

  return {
    external_lead_id: entry.external_lead_id,
    lead_uuid: entry.lead_uuid,
    rank_order: entry.rank_order,
    match_score: entry.explanation.match_score,
    provider_key: entry.profile.provider_key,
    display_name: entry.profile.display_name,
    profile_url: entry.profile.profile_url,
    resume_document_id: entry.document_id || null,
    source_providers: sources,
    source_display_names: sources.map((row) => providerDisplayName(row.provider_key)),
    dedup: {
      duplicate: Boolean(entry.dedup?.duplicate),
      duplicate_reason: entry.dedup?.duplicate_reason || null,
      possible_internal_candidate_id: entry.dedup?.possible_internal_candidate_id || null
    }
  };
}

function isQualifyingStagedEntry(entry) {
  return isQualifyingExternalLead({
    match_score: entry.explanation.match_score,
    match_explanation: entry.explanation,
    resume_index_status: "indexed"
  });
}

module.exports = {
  PROVIDER_DISPLAY_NAMES,
  providerDisplayName,
  buildProviderMetrics,
  buildConsolidatedTotals,
  consolidateStagedEntries,
  mapExternalLeadRow,
  isQualifyingStagedEntry
};
