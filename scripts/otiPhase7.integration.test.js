"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const otiOrchestratorService = require("../services/oti/otiOrchestratorService");
const otiExternalRecruiterActionService = require("../services/oti/otiExternalRecruiterActionService");
const otiRecruiterActionService = require("../services/oti/otiRecruiterActionService");
const otiCapabilityAuth = require("../services/oti/otiCapabilityAuth");
describe("oti phase7 run results pagination", () => {
  it("returns paginated internal and external slices", async () => {
    const pool = {
      query: async (sql, params) => {
        const text = String(sql);

        if (text.includes("FROM oti_sourcing_run WHERE run_uuid")) {
          return {
            rows: [
              {
                run_id: 1,
                run_uuid: "oti-run-page",
                requisition_code: "REQ-1",
                status: "completed",
                initiated_by: "REC-1"
              }
            ]
          };
        }

        if (text.includes("COUNT(*)::int AS total") && text.includes("oti_sourcing_result")) {
          return { rows: [{ total: 40 }] };
        }

        if (text.includes("FROM oti_sourcing_result") && text.includes("LIMIT")) {
          assert.equal(params[1], 10);
          assert.equal(params[2], 10);
          return {
            rows: Array.from({ length: 10 }).map((_, index) => ({
              result_id: index + 11,
              candidate_id: index + 100,
              candidate_code: `C-${index}`,
              candidate_name: `Candidate ${index}`,
              source_type: "talent_pool",
              rank_order: index + 11,
              match_pct: 80,
              rank_score: 0.8,
              matched_skills: [{ code: "JAV", name: "Java" }],
              missing_skills: [],
              explanation: {},
              total_experience: 5
            }))
          };
        }

        if (text.includes("FROM oti_recruiter_action")) {
          return { rows: [] };
        }

        if (text.includes("pc_config_state")) {
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

        if (text.includes("rm_requisitions")) {
          return { rows: [{ requisition_code: "REQ-1", req_status: "Approved", is_open: true }] };
        }

        return { rows: [] };
      }
    };

    const leads = Array.from({ length: 15 }).map((_, index) => ({
      external_lead_id: index + 1,
      display_name: `Lead ${index}`,
      provider_key: "serper",
      match_score: 0.7,
      import_status: "staged"
    }));

    const originalListLeads = require("../services/oti/otiExternalLeadService").listExternalLeadsForRun;
    require("../services/oti/otiExternalLeadService").listExternalLeadsForRun = async () => leads;

    try {
      const payload = await otiOrchestratorService.listRunResults(
        pool,
        "oti-run-page",
        { user: { role_name: "Admin", employee_code: "ADM-1" } },
        { page: 2, page_size: 10, external_page: 2, external_page_size: 5 }
      );

      assert.equal(payload.results.length, 10);
      assert.equal(payload.external_leads.length, 5);
      assert.equal(payload.pagination.internal.total, 40);
      assert.equal(payload.pagination.external.total, 15);
    } finally {
      require("../services/oti/otiExternalLeadService").listExternalLeadsForRun = originalListLeads;
    }
  });

  it("does not expose results for failed runs", async () => {
    const pool = {
      query: async (sql) => {
        if (String(sql).includes("FROM oti_sourcing_run WHERE run_uuid")) {
          return {
            rows: [
              {
                run_id: 9,
                run_uuid: "oti-run-fail",
                status: "failed",
                error_message: "Ranking failed",
                initiated_by: "REC-1",
                requisition_code: "REQ-1"
              }
            ]
          };
        }

        if (String(sql).includes("pc_config_state")) {
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

        return { rows: [] };
      }
    };

    const payload = await otiOrchestratorService.listRunResults(
      pool,
      "oti-run-fail",
      { user: { role_name: "Admin", employee_code: "ADM-1" } }
    );

    assert.equal(payload.run_failed, true);
    assert.equal(payload.results.length, 0);
  });
});

describe("oti phase7 journey safeguards", () => {
  it("journey E mapping remains explicit recruiter action", async () => {
    const pool = {
      query: async (sql, params) => {
        const text = String(sql);
        if (text.includes("FROM oti_sourcing_result")) {
          return {
            rows: [{ result_id: 3, run_id: 1, candidate_id: 55, run_uuid: "run", requisition_code: "REQ-1", initiated_by: "REC-1" }]
          };
        }
        if (text.includes("FROM oti_sourcing_run WHERE run_id")) {
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
        if (text.includes("pc_config_state")) {
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
        if (text.includes("rm_requisitions")) {
          return { rows: [{ requisition_code: "REQ-1", req_status: "Approved", is_open: true }] };
        }
        return { rows: [] };
      }
    };

    const outcome = await otiRecruiterActionService.recordRecruiterAction(
      pool,
      3,
      { user: { employee_code: "REC-1", role_name: "Recruiter", name: "Rec" } },
      { action_type: "request_map" }
    );

    assert.equal(outcome.intent_only, true);
  });

  it("journey D external import remains request-only", async () => {
    const pool = {
      query: async (sql, params) => {
        const text = String(sql);
        if (text.includes("FROM oti_external_lead") && text.includes("external_lead_id")) {
          return {
            rows: [
              {
                external_lead_id: 8,
                lead_uuid: "lead-8",
                import_status: "staged"
              }
            ]
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
                created_on: new Date().toISOString()
              }
            ]
          };
        }
        if (text.includes("pc_config_state")) {
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
        if (text.includes("rm_requisitions")) {
          return { rows: [{ requisition_code: "REQ-1", req_status: "Approved", is_open: true }] };
        }
        if (text.includes("oti_external_run_lead")) {
          return { rows: [{ linked: true }] };
        }
        return { rows: [] };
      }
    };

    const outcome = await otiExternalRecruiterActionService.recordExternalLeadAction(
      pool,
      8,
      { user: { employee_code: "ADM-1", role_name: "Admin", name: "Admin" } },
      { action_type: "request_import", note: "Review duplicate check", requisition_code: "REQ-1" }
    );

    assert.equal(outcome.auto_registration, false);
  });
});

describe("oti phase7 workspace authorization regression", () => {
  it("denies workspace without assignment for recruiter", async () => {
    const pool = {
      query: async (sql) => {
        if (String(sql).includes("employee_work_assignment ewa")) {
          return { rows: [] };
        }
        return { rows: [] };
      }
    };

    await assert.rejects(
      () =>
        otiCapabilityAuth.assertCanAccessOtiWorkspace(pool, {
          user: { role_name: "Recruiter", employee_code: "REC-7" }
        }),
      (error) => error.status === 403
    );
  });
});
