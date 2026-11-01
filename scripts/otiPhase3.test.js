"use strict";

const { describe, it, mock, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const {
  CONNECTOR_CAPABILITIES,
  CONNECTOR_STATUS,
  SEARCH_OUTCOME
} = require("../services/oti/connectors/otiConnectorContract");
const otiConnectorRegistry = require("../services/oti/connectors/otiConnectorRegistry");
const otiConnectorRunner = require("../services/oti/connectors/otiConnectorRunner");
const { resetRateLimitsForTests } = require("../services/oti/connectors/otiConnectorRateLimit");
const { normalizeExternalProfiles } = require("../services/oti/otiExternalProfileNormalizer");
const { classifyDuplicate, choosePrimaryFingerprint } = require("../services/oti/otiExternalDedupService");
const otiExternalRecruiterActionService = require("../services/oti/otiExternalRecruiterActionService");
const { buildPermissionProfile } = require("../services/oti/connectors/otiConnectorPermissions");
const otiExternalLeadService = require("../services/oti/otiExternalLeadService");
const githubSearchConnector = require("../services/oti/connectors/githubSearchConnector");

beforeEach(() => {
  resetRateLimitsForTests();
});

describe("oti phase3 connector registry", () => {
  it("registers default connectors with capability metadata", () => {
    otiConnectorRegistry.resetRegistryForTests();
    otiConnectorRegistry.bootstrapDefaultConnectors();

    const connectors = otiConnectorRegistry.listConnectors();
    assert.ok(connectors.length >= 5);
    assert.ok(connectors.some((row) => row.providerKey === "github"));
  });

  it("selects connectors by capability without provider hardcoding in runner", async () => {
    otiConnectorRegistry.resetRegistryForTests();

    otiConnectorRegistry.registerConnector({
      providerKey: "mock_web",
      displayName: "Mock Web",
      capabilities: [CONNECTOR_CAPABILITIES.WEB_SEARCH],
      getConfigurationState: () => ({ provider_key: "mock_web", configured: true }),
      getHealth: async () => ({ provider_key: "mock_web", status: CONNECTOR_STATUS.HEALTHY }),
      searchProfiles: async () => ({
        outcome: SEARCH_OUTCOME.OK,
        provider_key: "mock_web",
        profiles: [
          {
            provider_key: "mock_web",
            source_record_id: "abc",
            profile_url: "https://example.com/profile/abc",
            display_name: "Alex Example",
            skills: ["Java"]
          }
        ]
      })
    });

    const output = await otiConnectorRunner.executeExternalDiscovery({
      queryText: "Java",
      structuredQuery: { skill_tokens: ["Java"] },
      capabilities: [CONNECTOR_CAPABILITIES.WEB_SEARCH]
    });

    assert.equal(output.raw_profiles.length, 1);
    assert.equal(output.connector_results[0].provider_key, "mock_web");
  });

  it("resolves provider key aliases and skips unconfigured connectors", async () => {
    otiConnectorRegistry.resetRegistryForTests();

    otiConnectorRegistry.registerConnector({
      providerKey: "serper_web_search",
      displayName: "Mock Serper",
      capabilities: [CONNECTOR_CAPABILITIES.WEB_SEARCH],
      getConfigurationState: () => ({ provider_key: "serper_web_search", configured: true }),
      getHealth: async () => ({ provider_key: "serper_web_search", status: CONNECTOR_STATUS.HEALTHY }),
      searchProfiles: async () => ({
        outcome: SEARCH_OUTCOME.OK,
        provider_key: "serper_web_search",
        profiles: [
          {
            provider_key: "serper_web_search",
            source_record_id: "hit-1",
            profile_url: "https://example.com/u/hit-1",
            display_name: "Serper Hit",
            skills: ["Java"]
          }
        ]
      })
    });

    otiConnectorRegistry.registerConnector({
      providerKey: "github",
      displayName: "Mock GitHub",
      capabilities: [CONNECTOR_CAPABILITIES.GITHUB],
      getConfigurationState: () => ({ provider_key: "github", configured: false }),
      getHealth: async () => ({ provider_key: "github", status: CONNECTOR_STATUS.NOT_CONFIGURED }),
      searchProfiles: async () => {
        throw new Error("Unconfigured connector must not be invoked.");
      }
    });

    const output = await otiConnectorRunner.executeExternalDiscovery({
      queryText: "Java engineer",
      structuredQuery: { skill_tokens: ["Java"] },
      providerKeys: ["serper"],
      capabilities: [CONNECTOR_CAPABILITIES.WEB_SEARCH, CONNECTOR_CAPABILITIES.GITHUB]
    });

    assert.equal(output.raw_profiles.length, 1);
    assert.equal(output.connector_results.length, 1);
    assert.equal(output.connector_results[0].provider_key, "serper_web_search");
  });
});

describe("oti phase3 provider configuration states", () => {
  it("reports GitHub as not configured when token is absent", () => {
    const previous = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    delete process.env.OTI_GITHUB_TOKEN;

    const config = githubSearchConnector.getConfigurationState();
    assert.equal(config.configured, false);

    if (previous) {
      process.env.GITHUB_TOKEN = previous;
    }
  });

  it("returns not_configured outcome instead of simulated profiles", async () => {
    const previous = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    delete process.env.OTI_GITHUB_TOKEN;

    const result = await githubSearchConnector.searchProfiles({
      queryText: "Java",
      structuredQuery: { skill_tokens: ["Java"] }
    });

    assert.equal(result.outcome, SEARCH_OUTCOME.NOT_CONFIGURED);
    assert.deepEqual(result.profiles, []);

    if (previous) {
      process.env.GITHUB_TOKEN = previous;
    }
  });
});

describe("oti phase3 normalization", () => {
  it("normalizes provider hits without inventing missing fields", () => {
    const normalized = normalizeExternalProfiles([
      {
        provider_key: "mock_web",
        source_record_id: "1",
        profile_url: "https://example.com/u/1/",
        display_name: "Sam Dev",
        headline: "Backend engineer",
        skills: ["Java", "Spring"]
      }
    ]);

    assert.equal(normalized.length, 1);
    assert.equal(normalized[0].organization, null);
    assert.ok(normalized[0].profile_completeness > 0);
    assert.equal(normalized[0].raw_source_reference.provider_key, "mock_web");
  });
});

describe("oti phase3 duplicate detection", () => {
  it("does not treat similar names alone as duplicates", async () => {
    const pool = {
      query: async (sql) => {
        const text = String(sql);
        if (text.includes("oti_external_lead_source")) {
          return { rows: [] };
        }
        if (text.includes("oti_external_lead")) {
          return { rows: [] };
        }
        if (text.includes("cand_mstr")) {
          return { rows: [] };
        }
        return { rows: [] };
      }
    };

    const left = await classifyDuplicate(pool, {
      provider_key: "mock",
      source_record_id: "1",
      display_name: "John Smith",
      profile_url: "https://example.com/a"
    });

    const right = await classifyDuplicate(pool, {
      provider_key: "mock",
      source_record_id: "2",
      display_name: "John Smith",
      profile_url: "https://example.com/b"
    });

    assert.equal(left.duplicate, false);
    assert.equal(right.duplicate, false);
    assert.notEqual(
      choosePrimaryFingerprint({
        provider_key: "mock",
        source_record_id: "1"
      }),
      choosePrimaryFingerprint({
        provider_key: "mock",
        source_record_id: "2"
      })
    );
  });

  it("detects repeated discoveries from the same provider record", async () => {
    const pool = {
      query: async (sql) => {
        if (String(sql).includes("oti_external_lead_source")) {
          return {
            rows: [{ external_lead_id: 88, lead_uuid: "oti-ext-88", dedup_fingerprint: "x", import_status: "staged" }]
          };
        }
        return { rows: [] };
      }
    };

    const dedup = await classifyDuplicate(pool, {
      provider_key: "github",
      source_record_id: "12345",
      profile_url: "https://github.com/dev"
    });

    assert.equal(dedup.duplicate, true);
    assert.equal(dedup.duplicate_reason, "same_provider_record");
    assert.equal(dedup.existing_lead_id, 88);
  });
});

describe("oti phase3 external staging persistence", () => {
  it("stages leads and links them to a run without touching cand_mstr", async () => {
    const state = { leads: [], sources: [], snapshots: [], runLinks: [] };

    const pool = {
      query: async (sql, params) => {
        const text = String(sql);

        if (text.includes("FROM oti_external_lead_source") && text.includes("provider_key = $1")) {
          return { rows: [] };
        }
        if (text.includes("FROM oti_external_lead") && text.includes("dedup_fingerprint")) {
          return { rows: [] };
        }
        if (
          text.includes("INSERT INTO oti_external_lead (") &&
          !text.includes("oti_external_lead_source") &&
          !text.includes("oti_external_lead_snapshot")
        ) {
          state.leads.push({ external_lead_id: 501, lead_uuid: params[0] });
          return { rows: [{ external_lead_id: 501 }] };
        }
        if (text.includes("SELECT lead_uuid FROM oti_external_lead")) {
          return { rows: [{ lead_uuid: params[0] === 501 ? state.leads[0].lead_uuid : "x" }] };
        }
        if (text.includes("INSERT INTO oti_external_lead_source")) {
          state.sources.push(params[1]);
          return { rows: [] };
        }
        if (text.includes("INSERT INTO oti_external_lead_snapshot")) {
          state.snapshots.push(params[0]);
          return { rows: [] };
        }
        if (text.includes("INSERT INTO oti_external_run_lead")) {
          state.runLinks.push(params[0]);
          return { rows: [] };
        }
        if (text.includes("UPDATE oti_external_lead")) {
          return { rows: [] };
        }
        return { rows: [] };
      }
    };

    const staged = await otiExternalLeadService.stageExternalProfiles(
      pool,
      77,
      normalizeExternalProfiles([
        {
          provider_key: "mock_web",
          source_record_id: "abc",
          profile_url: "https://example.com/abc",
          display_name: "Alex",
          skills: ["Java"]
        }
      ]),
      { structuredQuery: { skill_tokens: ["Java"] }, requisition: { job_title: "Engineer" } }
    );

    assert.equal(staged.length, 1);
    assert.equal(state.leads.length, 1);
    assert.equal(state.runLinks[0], 77);
  });
});

describe("oti phase3 recruiter workflow safeguards", () => {
  it("records import request without auto registration", async () => {
    const pool = {
      query: async (sql, params) => {
        const text = String(sql);

        if (text.includes("FROM oti_external_lead WHERE external_lead_id")) {
          return {
            rows: [{ external_lead_id: 9, import_status: "staged", lead_uuid: "oti-ext-9" }]
          };
        }
        if (text.includes("UPDATE oti_external_lead SET import_status")) {
          return { rows: [] };
        }
        if (text.includes("INSERT INTO oti_external_recruiter_action")) {
          return {
            rows: [
              {
                action_id: 1,
                action_type: params[2],
                note: params[3],
                actor_employee_code: params[4],
                created_on: new Date()
              }
            ]
          };
        }
        if (text.includes("published_payload")) {
          return {
            rows: [
              {
                published_payload: {
                  modules: [{ key: "ai", enabled: true }],
                  ai_features: [{ key: "talent_intelligence", enabled: true }]
                }
              }
            ]
          };
        }
        if (text.includes("FROM rm_requisitions")) {
          return {
            rows: [
              {
                requisition_code: "REQ-1",
                req_status: "Approved",
                fulfillment_status: "Open",
                primary_skill: "Java"
              }
            ]
          };
        }
        if (text.includes("FROM rm_recruiter_assignments")) {
          return { rows: [{ assignment_id: 1 }] };
        }
        if (text.includes("oti_external_run_lead")) {
          return { rows: [{ linked: true }] };
        }
        if (text.includes("INSERT INTO md_enterprise_audit")) {
          return { rows: [] };
        }
        return { rows: [] };
      }
    };

    const response = await otiExternalRecruiterActionService.recordExternalLeadAction(
      pool,
      9,
      { user: { employee_code: "REC-1", role_name: "Recruiter", full_name: "Rec" } },
      { action_type: "request_import", requisition_code: "REQ-1" }
    );

    assert.equal(response.auto_registration, false);
    assert.equal(response.import_status, "import_requested");
    assert.match(String(response.registration_instructions || ""), /manually/i);
  });

  it("blocks resume retrieval when provider does not permit it", async () => {
    otiConnectorRegistry.resetRegistryForTests();
    otiConnectorRegistry.registerConnector({
      providerKey: "github",
      displayName: "GitHub",
      capabilities: [CONNECTOR_CAPABILITIES.GITHUB],
      getConfigurationState: () => ({ configured: true, resume_retrieval_permitted: false }),
      getPermissionProfile: () =>
        buildPermissionProfile({
          providerKey: "github",
          profileSearch: true,
          profileRead: true,
          resumeDownload: false,
          licenseConfigured: true
        }),
      getHealth: async () => ({ status: CONNECTOR_STATUS.HEALTHY }),
      searchProfiles: async () => ({ outcome: SEARCH_OUTCOME.OK, profiles: [] })
    });

    const pool = {
      query: async (sql) => {
        if (String(sql).includes("FROM oti_external_lead WHERE external_lead_id")) {
          return { rows: [{ external_lead_id: 3, import_status: "staged" }] };
        }
        if (String(sql).includes("FROM oti_external_lead_source")) {
          return {
            rows: [{ provider_key: "github", resume_retrieval_permitted: false, licensing_notes: null }]
          };
        }
        if (String(sql).includes("published_payload")) {
          return {
            rows: [
              {
                published_payload: {
                  modules: [{ key: "ai", enabled: true }],
                  ai_features: [{ key: "talent_intelligence", enabled: true }]
                }
              }
            ]
          };
        }
        if (String(sql).includes("FROM rm_requisitions")) {
          return {
            rows: [
              {
                requisition_code: "REQ-1",
                req_status: "Approved",
                fulfillment_status: "Open",
                primary_skill: "Java"
              }
            ]
          };
        }
        if (String(sql).includes("FROM rm_recruiter_assignments")) {
          return { rows: [{ assignment_id: 1 }] };
        }
        if (String(sql).includes("oti_external_run_lead")) {
          return { rows: [{ linked: true }] };
        }
        return { rows: [] };
      }
    };

    await assert.rejects(
      () =>
        otiExternalRecruiterActionService.recordExternalLeadAction(
          pool,
          3,
          { user: { employee_code: "REC-1", role_name: "Recruiter" } },
          {
            action_type: "request_resume_retrieval",
            requisition_code: "REQ-1"
          }
        ),
      (error) => error.status === 403
    );
  });
});

describe("oti phase3 connector rate limits", () => {
  it("surfaces rate limit outcome from runner", async () => {
    otiConnectorRegistry.resetRegistryForTests();
    otiConnectorRegistry.registerConnector({
      providerKey: "limited",
      displayName: "Limited",
      capabilities: [CONNECTOR_CAPABILITIES.WEB_SEARCH],
      getConfigurationState: () => ({ configured: true }),
      getHealth: async () => ({ status: CONNECTOR_STATUS.HEALTHY }),
      searchProfiles: async () => {
        const error = new Error("Connector rate limit exceeded.");
        error.connectorCode = "rate_limited";
        throw error;
      }
    });

    const result = await otiConnectorRunner.runConnectorSearch(
      otiConnectorRegistry.getConnector("limited"),
      {}
    );

    assert.equal(result.outcome, SEARCH_OUTCOME.RATE_LIMITED);
  });
});
