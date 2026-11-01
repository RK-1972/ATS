"use strict";

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const otiAiProviderRegistry = require("../services/oti/ai/otiAiProviderRegistry");
const otiAiGovernanceService = require("../services/oti/otiAiGovernanceService");
const otiJdIntelligenceService = require("../services/oti/otiJdIntelligenceService");
const { validateJdIntelligenceProfile } = require("../services/oti/otiJdIntelligenceSchema");
const otiQueryGenerationService = require("../services/oti/otiQueryGenerationService");
const otiSourceSelectionService = require("../services/oti/otiSourceSelectionService");
const otiTalentAdjacencyService = require("../services/oti/otiTalentAdjacencyService");
const otiRecruiterActionService = require("../services/oti/otiRecruiterActionService");

const MOCK_JD_AI = {
  normalized_job_title: "Senior React Engineer",
  mandatory_skills: ["React"],
  preferred_skills: ["TypeScript"],
  related_skills: ["Next.js"],
  equivalent_skills: ["Frontend Engineer"],
  transferable_skills: ["Angular"],
  technologies: ["React", "TypeScript"],
  experience_expectations: { min_years: 5, max_years: 10, summary: "Senior IC" },
  industry_domain: ["SaaS"],
  seniority: "Senior",
  role_search_concepts: ["component architecture"],
  exclusion_criteria: [],
  confidence_notes: ["Mock AI"]
};

function mockAiProvider(responseJson) {
  return {
    providerKey: "openai",
    getConfiguration: () => ({ configured: true, model_id: "mock-gpt", max_output_tokens: 800 }),
    completeStructuredJson: async () => ({
      json: responseJson,
      usage: { input_tokens: 100, output_tokens: 80, total_tokens: 180 },
      model_id: "mock-gpt",
      model_provider: "openai"
    })
  };
}

function buildPlatformConfig({ otiEnabled = true, aiAssistEnabled = true } = {}) {
  const features = [{ key: "talent_intelligence", enabled: otiEnabled }];
  if (aiAssistEnabled === false) {
    features.push({ key: "oti_ai_assist", enabled: false });
  } else if (aiAssistEnabled) {
    features.push({ key: "oti_ai_assist", enabled: true });
  }

  return {
    modules: [{ key: "ai", enabled: true }],
    ai_features: features
  };
}

beforeEach(() => {
  otiAiProviderRegistry.resetProvidersForTests();
  otiAiProviderRegistry.registerProvider(mockAiProvider(MOCK_JD_AI));
});

describe("oti phase6 jd intelligence validation", () => {
  it("rejects profiles without title or mandatory skills", () => {
    assert.throws(() => validateJdIntelligenceProfile({ mandatory_skills: [] }));
  });

  it("builds deterministic profile without inventing mandatory skills", () => {
    const profile = otiJdIntelligenceService.buildDeterministicProfile({
      job_title: "Java Developer",
      primary_skill: "Java, Spring",
      secondary_skill: "Kafka",
      job_description: "Build microservices."
    });

    assert.equal(profile.source, "deterministic");
    assert.deepEqual(profile.mandatory_skills, ["Java", "Spring"]);
    assert.ok(profile.preferred_skills.includes("Kafka"));
  });

  it("uses mocked OpenAI JD interpretation with mandatory skill guardrails", async () => {
    const tracker = otiAiGovernanceService.createRunUsageTracker();
    const pool = { query: async () => ({ rows: [] }) };

    const output = await otiJdIntelligenceService.analyzeJdIntelligence(
      pool,
      1,
      {
        job_title: "React Developer",
        primary_skill: "React",
        job_description: "React required."
      },
      { useAi: true, tracker, provider: mockAiProvider({ ...MOCK_JD_AI, mandatory_skills: ["Kubernetes"] }) }
    );

    assert.equal(output.used_ai, true);
    assert.ok(output.profile.mandatory_skills.includes("React"));
    assert.equal(tracker.calls, 1);
  });
});

describe("oti phase6 query generation", () => {
  it("deduplicates identical query expressions", () => {
    const profile = otiJdIntelligenceService.buildDeterministicProfile({
      job_title: "Engineer",
      primary_skill: "Java"
    });

    const bundle = otiQueryGenerationService.buildDeterministicStrategies(profile, [
      { provider_key: "github", capabilities: ["github"] },
      { provider_key: "serper", capabilities: ["web_search"] }
    ]);

    const hashes = new Set(bundle.strategies.map((row) => row.query_hash));
    assert.equal(hashes.size, bundle.strategies.length);
    assert.ok(bundle.provider_queries.github);
    assert.notEqual(bundle.provider_queries.github, bundle.provider_queries.serper);
  });

  it("falls back when AI query generation fails", async () => {
    const failingProvider = {
      providerKey: "openai",
      getConfiguration: () => ({ configured: true, model_id: "mock" }),
      completeStructuredJson: async () => {
        throw new Error("timeout");
      }
    };

    const tracker = otiAiGovernanceService.createRunUsageTracker();
    const profile = otiJdIntelligenceService.buildDeterministicProfile({
      job_title: "DevOps Engineer",
      primary_skill: "AWS"
    });

    const output = await otiQueryGenerationService.generateSearchStrategies(
      { query: async () => ({ rows: [] }) },
      1,
      profile,
      [{ provider_key: "serper", capabilities: ["web_search"], configuration: { configured: true } }],
      { useAi: true, tracker, provider: failingProvider }
    );

    assert.equal(output.used_ai, false);
    assert.ok(output.bundle.strategies.length >= 3);
    assert.ok(tracker.limitation_notes.length > 0);
  });
});

describe("oti phase6 source selection", () => {
  it("skips unconfigured providers and never simulates results", () => {
    const catalog = [
      {
        provider_key: "github",
        display_name: "GitHub",
        capabilities: ["github"],
        configuration: { configured: false },
        health: { status: "not_configured" },
        permissions: { profile_search: true }
      },
      {
        provider_key: "serper",
        display_name: "Serper",
        capabilities: ["web_search"],
        configuration: { configured: true },
        health: { status: "healthy" },
        permissions: { profile_search: true }
      }
    ];

    const profile = otiJdIntelligenceService.buildDeterministicProfile({
      job_title: "Engineer",
      primary_skill: "Node.js"
    });

    const selection = otiSourceSelectionService.buildDeterministicSelection(catalog, profile);
    assert.deepEqual(selection.selected_provider_keys, ["serper"]);
    assert.ok(selection.skipped_providers.some((row) => row.provider_key === "github"));
  });
});

describe("oti phase6 talent adjacency", () => {
  it("never marks inferred semantic skills as verified qualifications", () => {
    const profile = validateJdIntelligenceProfile({
      normalized_job_title: "Frontend Engineer",
      mandatory_skills: ["React"],
      related_skills: ["Next.js"],
      transferable_skills: ["Angular"]
    });

    const enriched = otiTalentAdjacencyService.enrichCandidateAdjacency(
      {
        matched_skills: [{ name: "React", code: "REACT" }],
        explanation: {
          semantic_similarity: 0.82,
          semantically_related_skills: [{ name: "Vue", code: "VUE" }]
        }
      },
      profile
    );

    const inferred = enriched.explanation.talent_adjacency.findings.find(
      (row) => row.skill_name === "Vue"
    );

    assert.equal(inferred.verified, false);
    assert.match(inferred.adjacency_type, /unverified/);
  });

  it("classifies direct and transferable skills separately", () => {
    const profile = validateJdIntelligenceProfile({
      normalized_job_title: "Frontend Engineer",
      mandatory_skills: ["React"],
      transferable_skills: ["Angular"]
    });

    const enriched = otiTalentAdjacencyService.enrichCandidateAdjacency(
      {
        matched_skills: [
          { name: "React", code: "REACT" },
          { name: "Angular", code: "ANG" }
        ],
        explanation: {}
      },
      profile
    );

    const react = enriched.explanation.talent_adjacency.findings.find((row) => row.skill_name === "React");
    const angular = enriched.explanation.talent_adjacency.findings.find(
      (row) => row.skill_name === "Angular"
    );

    assert.equal(react.adjacency_type, "direct_skill_match");
    assert.equal(angular.adjacency_type, "transferable_skill");
    assert.equal(angular.verified, false);
  });
});

describe("oti phase6 ai governance", () => {
  it("fails closed when ai assist feature is disabled", async () => {
    const pool = {
      query: async () => ({
        rows: [{ published_payload: buildPlatformConfig({ aiAssistEnabled: false }) }]
      })
    };

    otiAiProviderRegistry.resetProvidersForTests();
    otiAiProviderRegistry.registerProvider(mockAiProvider(MOCK_JD_AI));

    await assert.rejects(
      () => otiAiGovernanceService.assertAiAssistEnabled(pool),
      (error) => error.status === 403
    );
  });

  it("enforces per-run AI call limits", () => {
    const tracker = otiAiGovernanceService.createRunUsageTracker();
    tracker.calls = Number(process.env.OTI_AI_MAX_CALLS_PER_RUN || 4);

    assert.throws(() => otiAiGovernanceService.assertWithinRunLimits(tracker), (error) => error.status === 429);
  });
});

describe("oti phase6 human-in-the-loop safeguards", () => {
  it("records map requests without auto mapping", async () => {
    const pool = {
      query: async (sql, params) => {
        const text = String(sql);
        if (text.includes("FROM oti_sourcing_result")) {
          return { rows: [{ result_id: 9, run_id: 1, candidate_id: 42 }] };
        }
        if (text.includes("FROM oti_sourcing_run")) {
          return { rows: [{ run_id: 1, initiated_by: "REC-1", requisition_code: "REQ-1" }] };
        }
        if (text.includes("INSERT INTO oti_recruiter_action")) {
          return {
            rows: [
              {
                action_id: 1,
                action_type: params[2],
                note: params[3],
                actor_employee_code: params[4],
                created_on: new Date().toISOString()
              }
            ]
          };
        }
        if (text.includes("rm_requisitions")) {
          return { rows: [{ requisition_code: "REQ-1", req_status: "Approved", is_open: true }] };
        }
        if (text.includes("pc_config_state")) {
          return { rows: [{ published_payload: buildPlatformConfig() }] };
        }
        return { rows: [] };
      }
    };

    const outcome = await otiRecruiterActionService.recordRecruiterAction(
      pool,
      9,
      { user: { employee_code: "REC-1", role_name: "Recruiter", name: "Recruiter" } },
      { action_type: "request_map", note: "Review first" }
    );

    assert.equal(outcome.action.action_type, "request_map");
    assert.equal(outcome.intent_only, true);
  });
});
