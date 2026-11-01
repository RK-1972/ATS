/**
 * OTI Phase 3 external discovery agent — multi-provider connector runner + consolidate + stage.
 */

const { CONNECTOR_CAPABILITIES } = require("./connectors/otiConnectorContract");
const { executeExternalDiscovery } = require("./connectors/otiConnectorRunner");
const { describeConnectorCatalog } = require("./connectors/otiConnectorRegistry");
const { normalizeExternalProfiles } = require("./otiExternalProfileNormalizer");
const { filterResumeDocumentCandidates } = require("./otiExternalProfileCandidateGate");
const otiExternalLeadService = require("./otiExternalLeadService");
const {
  processDiscoveredResumeDocument,
  REUSE_QUALIFICATION_FAILURE_CATEGORY
} = require("./otiPublicResumeDocumentService");
const {
  buildConsolidatedTotals,
  buildProviderMetrics,
  consolidateStagedEntries,
  isQualifyingStagedEntry,
  mapExternalLeadRow
} = require("./otiExternalMultiSourceConsolidation");

async function discoverExternalCandidates(
  pool,
  runId,
  { queryText, structuredQuery, requisition, providerKeys = [], providerQueries = {}, limitPerProvider = 10 } = {}
) {
  const discovery = await executeExternalDiscovery({
    queryText,
    structuredQuery,
    requisition,
    providerKeys,
    providerQueries,
    limitPerProvider,
    capabilities: [
      CONNECTOR_CAPABILITIES.WEB_SEARCH,
      CONNECTOR_CAPABILITIES.PROFILE_SEARCH,
      CONNECTOR_CAPABILITIES.GITHUB,
      CONNECTOR_CAPABILITIES.PROFESSIONAL_NETWORK
    ]
  });

  const filtered = filterResumeDocumentCandidates(discovery.raw_profiles, { structuredQuery });
  const normalized = normalizeExternalProfiles(filtered.resumeCandidates);

  const stagedRaw = [];
  const ingestFailures = [];
  const reuseQualificationSkips = [];

  for (const profile of normalized) {
    const result = await processDiscoveredResumeDocument(pool, runId, profile, {
      structuredQuery,
      requisition
    });

    if (!result) {
      continue;
    }

    if (result.skipped) {
      const failureRow = {
        ...result,
        provider_key: result.provider_key || profile.provider_key
      };

      if (result.failure_category === REUSE_QUALIFICATION_FAILURE_CATEGORY) {
        reuseQualificationSkips.push(failureRow);
      } else {
        ingestFailures.push(failureRow);
      }
      continue;
    }

    stagedRaw.push(result);
  }

  const staged = consolidateStagedEntries(stagedRaw);

  staged.sort((left, right) => right.explanation.match_score - left.explanation.match_score);
  staged.forEach((entry, index) => {
    entry.rank_order = index + 1;
  });

  for (const entry of staged) {
    await otiExternalLeadService.linkLeadToRun(
      pool,
      runId,
      entry.external_lead_id,
      entry.profile,
      entry.explanation,
      entry.rank_order
    );
  }

  const configuredConnectors = (await describeConnectorCatalog()).filter(
    (item) => item.configuration?.configured
  );

  const qualifyingStaged = staged.filter((entry) => isQualifyingStagedEntry(entry));

  const discoveryFilter = {
    raw_hits: discovery.raw_profiles.length,
    resume_document_candidates: filtered.resumeCandidates.length,
    profile_references: filtered.profileReferences.length,
    rejected_non_candidates: filtered.rejected.length,
    ingest_failures: ingestFailures.length,
    reuse_qualification_skips: reuseQualificationSkips.length,
    indexed_resume_leads: staged.length
  };

  const providerMetrics = buildProviderMetrics({
    connectorResults: discovery.connector_results,
    rawProfiles: discovery.raw_profiles,
    filtered,
    staged,
    ingestFailures,
    reuseQualificationSkips,
    qualifyingStaged
  });

  const consolidatedTotals = buildConsolidatedTotals(
    providerMetrics,
    discoveryFilter,
    staged,
    qualifyingStaged
  );

  return {
    connector_results: discovery.connector_results,
    external_leads: staged.map((entry) => mapExternalLeadRow(entry)),
    staged_count: qualifyingStaged.length,
    staged_total: staged.length,
    configured_connector_count: configuredConnectors.length,
    provider_metrics: providerMetrics,
    consolidated_totals: consolidatedTotals,
    discovery_filter: discoveryFilter,
    limitation_notes: [
      ...(configuredConnectors.length === 0
        ? [
            "No external web search connectors are configured. OpenAI assists JD analysis and matching only; set at least one of SERPER_API_KEY, BRAVE_SEARCH_API_KEY, AZURE_BING_SEARCH_KEY, or GITHUB_TOKEN for resume discovery."
          ]
        : []),
      ...(Object.values(providerMetrics).some((row) => row.connector_outcome !== "ok")
        ? [
            "One or more external providers failed or were rate-limited; successful provider results were still consolidated."
          ]
        : []),
      ...(filtered.profileReferences.length > 0
        ? [
            `${filtered.profileReferences.length} profile-only result(s) were recorded as discovery references and are not resume-qualified candidates.`
          ]
        : []),
      ...(filtered.rejected.length > 0
        ? [
            `Filtered ${filtered.rejected.length} non-resume web result(s) (articles, jobs, training pages, or non-document URLs).`
          ]
        : []),
      ...(ingestFailures.length > 0
        ? [
            `${ingestFailures.length} public resume URL(s) could not be retrieved or parsed from document content.`
          ]
        : []),
      ...(reuseQualificationSkips.length > 0
        ? [
            `${reuseQualificationSkips.length} indexed duplicate resume(s) were rediscovered but did not pass re-qualification for this run.`
          ]
        : []),
      ...(filtered.resumeCandidates.length > 0 && staged.length === 0
        ? [
            "Resume document URLs were found but none were successfully retrieved, indexed, and qualified from parsed content."
          ]
        : []),
      ...(discovery.raw_profiles.length > 0 && filtered.resumeCandidates.length === 0
        ? [
            "External providers returned hits, but none were direct public resume/CV documents (PDF/DOC/DOCX)."
          ]
        : [])
    ]
  };
}

module.exports = {
  discoverExternalCandidates
};
