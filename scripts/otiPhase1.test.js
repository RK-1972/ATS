"use strict";

const { describe, it, mock } = require("node:test");
const assert = require("node:assert/strict");

const otiCapabilityAuth = require("../services/oti/otiCapabilityAuth");
const otiQueryAgentService = require("../services/oti/otiQueryAgentService");
const otiInternalDiscoveryAgentService = require("../services/oti/otiInternalDiscoveryAgentService");
const otiRecruiterActionService = require("../services/oti/otiRecruiterActionService");
const {
  rankInternalCandidates
} = require("../services/oti/otiMatchRankAgentService");

function buildPlatformConfig({ featureEnabled = true, moduleEnabled = true } = {}) {
  return {
    modules: [{ key: "ai", enabled: moduleEnabled }],
    ai_features: [{ key: "talent_intelligence", enabled: featureEnabled }]
  };
}

describe("otiCapabilityAuth feature gate", () => {
  it("reports unavailable when feature disabled", async () => {
    const pool = {
      query: async () => ({
        rows: [{ published_payload: buildPlatformConfig({ featureEnabled: false }) }]
      })
    };

    const availability = await otiCapabilityAuth.getOtiAvailability(pool);
    assert.equal(availability.available, false);
    assert.equal(availability.feature_enabled, false);
  });

  it("throws when feature disabled on assert", async () => {
    const pool = {
      query: async () => ({
        rows: [{ published_payload: buildPlatformConfig({ featureEnabled: false }) }]
      })
    };

    await assert.rejects(
      () => otiCapabilityAuth.assertOtiFeatureEnabled(pool),
      (error) => error.status === 403
    );
  });
});

describe("otiQueryAgentService", () => {
  it("builds deterministic structured query without LLM", () => {
    const output = otiQueryAgentService.buildStructuredQuery({
      queryText: "Java, AWS",
      requisition: { requisition_code: "REQ-1", primary_skill: "Java" }
    });

    assert.equal(output.used_llm, false);
    assert.ok(output.structured_query.skill_tokens.includes("Java"));
  });
});

describe("otiInternalDiscoveryAgentService authorization", () => {
  it("excludes pipeline candidates outside owner scope", async () => {
    const queries = [];

    const pool = {
      query: async (sql, params) => {
        queries.push(String(sql));

        if (sql.includes("TALENT_POOL") && sql.includes("NOT EXISTS")) {
          return { rows: [{ candidate_id: 10 }] };
        }

        if (sql.includes("m.is_active = FALSE") && !sql.includes("<>")) {
          return { rows: [{ candidate_id: 20 }] };
        }
        if (sql.includes("m.requisition_code <>")) {
          return { rows: [] };
        }

        if (sql.includes("FROM cand_mstr") && params?.[0] === 10) {
          return {
            rows: [
              {
                candidate_id: 10,
                candidate_container: "TALENT_POOL",
                owner_employee_code: null,
                candidate_status: "REGISTERED"
              }
            ]
          };
        }

        if (sql.includes("FROM cand_mstr") && params?.[0] === 20) {
          return {
            rows: [
              {
                candidate_id: 20,
                candidate_container: "PIPELINE",
                owner_employee_code: "OTHER-REC",
                candidate_status: "REGISTERED"
              }
            ]
          };
        }

        return { rows: [] };
      }
    };

    const req = { user: { employee_code: "REC-1", role_name: "Recruiter" } };
    const result = await otiInternalDiscoveryAgentService.discoverInternalCandidates(
      pool,
      req,
      "REQ-9"
    );

    assert.deepEqual(
      result.candidates.map((row) => row.candidate_id),
      [10]
    );
    assert.ok(result.excluded.some((row) => row.candidate_id === 20));
  });
});

describe("otiMatchRankAgentService scoring", () => {
  it("scores required skill overlap at 100 percent", async () => {
    const publishedSkills = [
      {
        code: "SK-JAVA",
        name: "Java",
        status: "Active",
        versionStatus: "Published"
      }
    ];

    const masterDataService = require("../services/masterDataService");
    mock.method(masterDataService, "listByEntityType", async () => publishedSkills);

    const pool = {
      query: async (sql, params) => {
        if (sql.includes("FROM cand_mstr") && params?.[0] === 1) {
          return {
            rows: [
              {
                candidate_id: 1,
                candidate_code: "C-1",
                first_name: "Alex",
                last_name: "Dev",
                primary_skill: "Java",
                secondary_skill: "",
                total_experience: 5
              }
            ]
          };
        }

        if (sql.includes("FROM can_skill_map")) {
          return { rows: [] };
        }

        return { rows: [] };
      }
    };

    const requisition = { requisition_code: "REQ-1", primary_skill: "Java" };
    const ranked = await rankInternalCandidates(pool, requisition, [
      { candidate_id: 1, source_type: "talent_pool" }
    ]);

    assert.equal(ranked.ranked_results[0].match_pct, 100);
    assert.ok(Array.isArray(ranked.ranked_results[0].matched_skills));
    assert.equal(ranked.ranked_results[0].source_type, "talent_pool");

    mock.restoreAll();
  });
});

describe("otiRecruiterActionService", () => {
  it("records request_map without invoking mapCandidate", async () => {
    let mappingCalled = false;

    const pool = {
      query: async (sql, params) => {
        if (sql.includes("FROM oti_sourcing_result r")) {
          return {
            rows: [
              {
                result_id: 5,
                run_id: 1,
                candidate_id: 100,
                run_uuid: "oti-run-test",
                requisition_code: "REQ-1",
                initiated_by: "REC-1"
              }
            ]
          };
        }

        if (sql.includes("FROM oti_sourcing_run WHERE run_id")) {
          return {
            rows: [
              {
                run_id: 1,
                run_uuid: "oti-run-test",
                requisition_code: "REQ-1",
                initiated_by: "REC-1"
              }
            ]
          };
        }

        if (sql.includes("FROM oti_sourcing_run WHERE run_id")) {
          return {
            rows: [
              {
                run_id: 1,
                run_uuid: "oti-run-test",
                requisition_code: "REQ-1",
                initiated_by: "REC-1"
              }
            ]
          };
        }

        if (sql.includes("INSERT INTO oti_recruiter_action")) {
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

        if (sql.includes("published_payload")) {
          return { rows: [{ published_payload: buildPlatformConfig() }] };
        }

        if (sql.includes("INSERT INTO md_enterprise_audit")) {
          return { rows: [] };
        }

        return { rows: [] };
      }
    };

    const recruitmentService = require("../services/recruitmentService");
    mock.method(recruitmentService, "mapCandidate", async () => {
      mappingCalled = true;
      return {};
    });

    const req = {
      user: {
        employee_code: "REC-1",
        role_name: "Recruiter",
        email_id: "rec@test.com"
      }
    };

    const response = await otiRecruiterActionService.recordRecruiterAction(
      pool,
      5,
      req,
      { action_type: "request_map", note: "Ready to map" }
    );

    assert.equal(response.intent_only, true);
    assert.equal(mappingCalled, false);

    mock.restoreAll();
  });

  it("rejects unsupported action types", async () => {
    await assert.rejects(
      () =>
        otiRecruiterActionService.recordRecruiterAction(
          { query: async () => ({ rows: [] }) },
          1,
          { user: { employee_code: "REC-1" } },
          { action_type: "auto_map" }
        ),
      (error) => error.status === 400
    );
  });
});
