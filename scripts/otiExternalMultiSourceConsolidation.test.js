"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { SEARCH_OUTCOME } = require("../services/oti/connectors/otiConnectorContract");
const {
  buildConsolidatedTotals,
  buildProviderMetrics,
  consolidateStagedEntries,
  mapExternalLeadRow
} = require("../services/oti/otiExternalMultiSourceConsolidation");

describe("oti external multi-source consolidation", () => {
  it("builds per-provider metrics and consolidated totals", () => {
    const providerMetrics = buildProviderMetrics({
      connectorResults: [
        { provider_key: "serper_web_search", outcome: SEARCH_OUTCOME.OK, profiles: [{}, {}] },
        { provider_key: "github", outcome: SEARCH_OUTCOME.RATE_LIMITED, profiles: [], message: "limited" }
      ],
      rawProfiles: [
        { provider_key: "serper_web_search" },
        { provider_key: "github" }
      ],
      filtered: {
        resumeCandidates: [{ provider_key: "serper_web_search" }],
        profileReferences: [{ provider_key: "github" }],
        rejected: [{ provider_key: "serper_web_search" }]
      },
      staged: [
        {
          external_lead_id: 1,
          profile: { provider_key: "serper_web_search", profile_url: "https://a.example/r.pdf" },
          explanation: { match_score: 0.8 }
        }
      ],
      ingestFailures: [{ provider_key: "github" }],
      reuseQualificationSkips: [{ provider_key: "serper_web_search" }],
      qualifyingStaged: [
        {
          external_lead_id: 1,
          profile: { provider_key: "serper_web_search" },
          explanation: { match_score: 0.8 }
        }
      ]
    });

    assert.equal(providerMetrics.serper_web_search.display_name, "Serper");
    assert.equal(providerMetrics.serper_web_search.resume_candidates, 1);
    assert.equal(providerMetrics.serper_web_search.parsed_qualified, 1);
    assert.equal(providerMetrics.serper_web_search.reuse_qualification_skipped, 1);
    assert.equal(providerMetrics.github.connector_outcome, SEARCH_OUTCOME.RATE_LIMITED);

    const totals = buildConsolidatedTotals(
      providerMetrics,
      {
        resume_document_candidates: 1,
        profile_references: 1,
        rejected_non_candidates: 1,
        ingest_failures: 1,
        reuse_qualification_skips: 1
      },
      [{ external_lead_id: 1 }],
      [{ external_lead_id: 1 }]
    );

    assert.equal(totals.providers_executed, 2);
    assert.equal(totals.providers_failed, 1);
    assert.equal(totals.parsed_qualified, 1);
    assert.equal(totals.reuse_qualification_skipped, 1);
    assert.equal(totals.unique_staged_leads, 1);
  });

  it("surfaces GitHub code search API errors on provider metrics", () => {
    const providerMetrics = buildProviderMetrics({
      connectorResults: [
        {
          provider_key: "github",
          outcome: SEARCH_OUTCOME.OK,
          profiles: [{ provider_key: "github" }],
          message: "GitHub code search failed (HTTP 422: unable to parse query!).",
          code_search_errors: [{ query: "bad", status: 422, message: "unable to parse query!" }]
        }
      ],
      rawProfiles: [{ provider_key: "github" }],
      filtered: { resumeCandidates: [], profileReferences: [{ provider_key: "github" }], rejected: [] },
      staged: [],
      ingestFailures: [],
      reuseQualificationSkips: [],
      qualifyingStaged: []
    });

    assert.equal(providerMetrics.github.connector_message, "GitHub code search failed (HTTP 422: unable to parse query!).");
    assert.equal(providerMetrics.github.code_search_errors.length, 1);
  });

  it("consolidates duplicate lead ids and retains multiple source providers", () => {
    const consolidated = consolidateStagedEntries([
      {
        external_lead_id: 42,
        profile: {
          provider_key: "serper_web_search",
          profile_url: "https://cdn.example.com/resume.pdf",
          source_attribution: { provider: "Serper" }
        },
        explanation: { match_score: 0.55 },
        dedup: { duplicate: true, duplicate_reason: "same_public_resume_url" }
      },
      {
        external_lead_id: 42,
        profile: {
          provider_key: "github",
          profile_url: "https://cdn.example.com/resume.pdf",
          source_attribution: { provider: "GitHub" }
        },
        explanation: { match_score: 0.62 },
        dedup: { duplicate: true, duplicate_reason: "same_public_resume_url" }
      }
    ]);

    assert.equal(consolidated.length, 1);
    assert.equal(consolidated[0].source_providers.length, 2);
    assert.equal(consolidated[0].profile.provider_key, "github");

    const row = mapExternalLeadRow(consolidated[0]);
    assert.equal(row.source_display_names.length, 2);
    assert.ok(row.source_providers.some((source) => source.provider_key === "serper_web_search"));
  });
});
