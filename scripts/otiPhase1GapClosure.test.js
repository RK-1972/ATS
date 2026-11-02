"use strict";

const { describe, it, mock } = require("node:test");
const assert = require("node:assert/strict");

const otiCapabilityAuth = require("../services/oti/otiCapabilityAuth");
const otiInternalDiscoveryAgentService = require("../services/oti/otiInternalDiscoveryAgentService");
const otiOrchestratorService = require("../services/oti/otiOrchestratorService");
const otiRecruiterActionService = require("../services/oti/otiRecruiterActionService");
const otiMatchRankAgentService = require("../services/oti/otiMatchRankAgentService");

function buildPlatformConfig({ featureEnabled = true } = {}) {
  return {
    modules: [{ key: "ai", enabled: true }],
    ai_features: [{ key: "talent_intelligence", enabled: featureEnabled }]
  };
}

function assignmentRows(flag) {
  return [
    {
      assignment_code: "TALENT_INTELLIGENCE",
      is_active: true,
      master_is_active: true,
      workspace_flag: flag
    }
  ];
}

describe("oti workspace authorization", () => {
  it("allows Admin without TALENT_INTELLIGENCE assignment", async () => {
    await otiCapabilityAuth.assertCanAccessOtiWorkspace(
      { query: async () => ({ rows: [] }) },
      { user: { role_name: "Admin", employee_code: "ADM-1" } }
    );
  });

  it("denies Recruiter without showTalentIntelligenceWorkspace or assigned requisitions", async () => {
    const legacyOperationalAdapter = require("../services/legacyOperationalAdapter");
    const pool = {
      query: async (sql) => {
        if (String(sql).includes("employee_work_assignment ewa")) {
          return { rows: [] };
        }
        return { rows: [] };
      }
    };

    mock.method(legacyOperationalAdapter, "getMyRequisitions", async () => []);

    await assert.rejects(
      () =>
        otiCapabilityAuth.assertCanAccessOtiWorkspace(pool, {
          user: { role_name: "Recruiter", employee_code: "REC-1" }
        }),
      (error) => error.status === 403
    );
  });

  it("allows Recruiter with assigned requisitions without TALENT_INTELLIGENCE assignment", async () => {
    const legacyOperationalAdapter = require("../services/legacyOperationalAdapter");
    const pool = {
      query: async (sql) => {
        if (String(sql).includes("employee_work_assignment ewa")) {
          return { rows: [] };
        }
        return { rows: [] };
      }
    };

    mock.method(legacyOperationalAdapter, "getMyRequisitions", async () => [
      { req_code: "REQ-REC-1" }
    ]);

    await otiCapabilityAuth.assertCanAccessOtiWorkspace(pool, {
      user: { role_name: "Recruiter", employee_code: "REC-1" }
    });
  });

  it("allows Recruiter with TALENT_INTELLIGENCE workspace flag", async () => {
    const pool = {
      query: async (sql) => {
        if (String(sql).includes("employee_work_assignment ewa")) {
          return { rows: assignmentRows("showTalentIntelligenceWorkspace") };
        }
        return { rows: [] };
      }
    };

    await otiCapabilityAuth.assertCanAccessOtiWorkspace(pool, {
      user: { role_name: "Recruiter", employee_code: "REC-1" }
    });
  });

  it("allows TA Lead with workspace flag (same assignment gate as Recruiter)", async () => {
    const pool = {
      query: async (sql) => {
        if (String(sql).includes("employee_work_assignment ewa")) {
          return { rows: assignmentRows("showTalentIntelligenceWorkspace") };
        }
        return { rows: [] };
      }
    };

    await otiCapabilityAuth.assertCanAccessOtiWorkspace(pool, {
      user: { role_name: "TA Lead", employee_code: "TAL-1" }
    });
  });
});

describe("oti requisition run access (panel vs workspace)", () => {
  it("execute path uses feature gate and resume-match access, not workspace flag", async () => {
    const resumeMatchService = require("../services/resumeMatchService");
    let resumeMatchCalled = false;

    mock.method(resumeMatchService, "assertResumeMatchAccess", async () => {
      resumeMatchCalled = true;
    });

    const pool = {
      query: async (sql) => {
        if (sql.includes("published_payload")) {
          return { rows: [{ published_payload: buildPlatformConfig() }] };
        }
        return { rows: [] };
      }
    };

    await otiCapabilityAuth.assertCanExecuteOtiRequisitionSourcingRun(
      pool,
      { user: { employee_code: "REC-1" } },
      { requisition_code: "REQ-1" }
    );

    assert.equal(resumeMatchCalled, true);
    mock.restoreAll();
  });
});

describe("active mapping exclusion", () => {
  it("talent pool SQL excludes active mappings on target requisition", async () => {
    let talentPoolSql = "";

    const pool = {
      query: async (sql) => {
        if (sql.includes("TALENT_POOL") && sql.includes("NOT EXISTS")) {
          talentPoolSql = sql;
          return { rows: [] };
        }
        if (sql.includes("m.is_active = FALSE")) {
          return { rows: [] };
        }
        if (sql.includes("m.requisition_code <>")) {
          return { rows: [] };
        }
        return { rows: [] };
      }
    };

    await otiInternalDiscoveryAgentService.discoverInternalCandidates(
      pool,
      { user: { employee_code: "REC-1", role_name: "Recruiter" } },
      "REQ-TARGET"
    );

    assert.match(talentPoolSql, /is_active = TRUE/);
    assert.match(talentPoolSql, /requisition_code = \$1/);
  });

  it("does not return historical rows when only active mapping exists on target", async () => {
    const pool = {
      query: async (sql) => {
        if (sql.includes("TALENT_POOL")) {
          return { rows: [{ candidate_id: 501 }] };
        }
        if (sql.includes("m.is_active = FALSE") && !sql.includes("<>")) {
          return { rows: [] };
        }
        if (sql.includes("m.requisition_code <>")) {
          return { rows: [] };
        }
        if (sql.includes("FROM cand_mstr") && sql.includes("candidate_id")) {
          return {
            rows: [
              {
                candidate_id: 501,
                candidate_container: "TALENT_POOL",
                owner_employee_code: null,
                candidate_status: "REGISTERED"
              }
            ]
          };
        }
        return { rows: [] };
      }
    };

    const result = await otiInternalDiscoveryAgentService.discoverInternalCandidates(
      pool,
      { user: { employee_code: "REC-1", role_name: "Recruiter" } },
      "REQ-TARGET"
    );

    assert.deepEqual(result.candidates.map((row) => row.candidate_id), [501]);
  });

  it("includes inactive same-requisition historical when access permits", async () => {
    const pool = {
      query: async (sql) => {
        if (sql.includes("TALENT_POOL")) {
          return { rows: [] };
        }
        if (sql.includes("m.is_active = FALSE") && !sql.includes("<>")) {
          return { rows: [{ candidate_id: 601 }] };
        }
        if (sql.includes("m.requisition_code <>")) {
          return { rows: [] };
        }
        if (String(sql).includes("FROM cand_mstr") && sql.includes("$1")) {
          return {
            rows: [
              {
                candidate_id: 601,
                candidate_container: "PIPELINE",
                owner_employee_code: "REC-1",
                candidate_status: "REGISTERED"
              }
            ]
          };
        }
        return { rows: [] };
      }
    };

    const result = await otiInternalDiscoveryAgentService.discoverInternalCandidates(
      pool,
      { user: { employee_code: "REC-1", role_name: "Recruiter" } },
      "REQ-TARGET"
    );

    assert.deepEqual(result.candidates, [{ candidate_id: 601, source_type: "historical" }]);
  });
});

describe("cross-requisition historical discovery", () => {
  it("includes authorized pipeline owner from inactive mapping on another requisition", async () => {
    const pool = {
      query: async (sql) => {
        if (sql.includes("TALENT_POOL")) {
          return { rows: [] };
        }
        if (sql.includes("m.is_active = FALSE") && !sql.includes("<>")) {
          return { rows: [] };
        }
        if (sql.includes("m.requisition_code <>")) {
          return { rows: [{ candidate_id: 701 }] };
        }
        if (String(sql).includes("FROM cand_mstr")) {
          return {
            rows: [
              {
                candidate_id: 701,
                candidate_container: "PIPELINE",
                owner_employee_code: "REC-1",
                candidate_status: "REGISTERED"
              }
            ]
          };
        }
        return { rows: [] };
      }
    };

    const result = await otiInternalDiscoveryAgentService.discoverInternalCandidates(
      pool,
      { user: { employee_code: "REC-1", role_name: "Recruiter" } },
      "REQ-NEW"
    );

    assert.deepEqual(result.candidates, [{ candidate_id: 701, source_type: "historical" }]);
  });

  it("excludes cross-requisition historical when pipeline owner differs", async () => {
    const pool = {
      query: async (sql) => {
        if (sql.includes("TALENT_POOL")) {
          return { rows: [] };
        }
        if (sql.includes("m.is_active = FALSE") && !sql.includes("<>")) {
          return { rows: [] };
        }
        if (sql.includes("m.requisition_code <>")) {
          return { rows: [{ candidate_id: 702 }] };
        }
        if (String(sql).includes("FROM cand_mstr")) {
          return {
            rows: [
              {
                candidate_id: 702,
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

    const result = await otiInternalDiscoveryAgentService.discoverInternalCandidates(
      pool,
      { user: { employee_code: "REC-1", role_name: "Recruiter" } },
      "REQ-NEW"
    );

    assert.deepEqual(result.candidates, []);
    assert.ok(result.excluded.some((row) => row.candidate_id === 702));
  });
});

describe("oti orchestrator lifecycle", () => {
  it("persists run, steps, results and completes successfully", async () => {
    const state = {
      runs: [],
      steps: [],
      results: [],
      runId: 0
    };

    const approvedReq = {
      requisition_code: "REQ-OK",
      req_status: "Approved",
      primary_skill: "Java",
      fulfillment_status: "Open"
    };

    const otiInternalDiscoveryAgentService = require("../services/oti/otiInternalDiscoveryAgentService");

    mock.method(otiInternalDiscoveryAgentService, "discoverInternalCandidates", async () => ({
      candidates: [{ candidate_id: 1, source_type: "talent_pool" }],
      excluded: [],
      limitation_notes: []
    }));

    mock.method(otiMatchRankAgentService, "rankInternalCandidates", async () => ({
      required_skills: [{ code: "SK-JAVA", name: "Java" }],
      ranked_results: [
        {
          candidate_id: 1,
          candidate_code: "C-1",
          candidate_name: "A B",
          match_pct: 100,
          rank_score: 1,
          rank_order: 1,
          matched_skills: [{ code: "JAV", name: "Java" }],
          missing_skills: [],
          source_type: "talent_pool",
          explanation: {},
          total_experience: 3
        }
      ]
    }));

    const pool = {
      query: async (sql, params) => {
        const text = String(sql);

        if (text.includes("FROM rm_requisitions")) {
          return { rows: [approvedReq] };
        }
        if (text.includes("published_payload")) {
          return { rows: [{ published_payload: buildPlatformConfig() }] };
        }
        if (text.includes("FROM rm_recruiter_assignments")) {
          return { rows: [{ assignment_id: 1 }] };
        }
        if (text.includes("INSERT INTO oti_sourcing_run") && text.includes("RETURNING")) {
          state.runId += 1;
          const row = {
            run_id: state.runId,
            run_uuid: params[0],
            requisition_code: params[1],
            initiated_by: params[2],
            status: "processing",
            query_text: params[3],
            query_structured: {},
            idempotency_key: params[4],
            error_message: null,
            created_on: new Date(),
            completed_on: null
          };
          state.runs.push(row);
          return { rows: [row] };
        }
        if (text.includes("UPDATE oti_sourcing_run SET query_structured")) {
          return { rows: [] };
        }
        if (text.includes("INSERT INTO oti_sourcing_run_step")) {
          state.steps.push({ agent_key: params[1], status: params[2] });
          return { rows: [] };
        }
        if (text.includes("UPDATE oti_sourcing_run") && text.includes("status = 'completed'")) {
          const run = state.runs.find((item) => item.run_id === params[0]);
          if (run) {
            run.status = "completed";
            run.completed_on = new Date();
          }
          return { rows: [] };
        }
        if (text.includes("INSERT INTO oti_sourcing_result")) {
          state.results.push({ candidate_id: params[1] });
          return { rows: [] };
        }
        if (text.includes("SELECT * FROM oti_sourcing_run WHERE run_id")) {
          const run = state.runs.find((item) => item.run_id === params[0]);
          return { rows: run ? [{ ...run, status: "completed" }] : [] };
        }
        if (text.includes("COUNT(*)::int AS total") && text.includes("oti_sourcing_result")) {
          return { rows: [{ total: state.results.length }] };
        }
        if (text.includes("INSERT INTO md_enterprise_audit")) {
          return { rows: [] };
        }
        return { rows: [] };
      }
    };

    const req = {
      user: {
        employee_code: "REC-1",
        role_name: "Recruiter",
        email_id: "rec@test.com"
      },
      headers: {}
    };

    const summary = await otiOrchestratorService.executeSourcingRun(
      pool,
      "REQ-OK",
      req,
      { query_text: "Java" }
    );

    assert.equal(summary.status, "completed");
    assert.equal(state.steps.length, 4);
    assert.equal(state.results.length, 1);
    assert.equal(summary.results_count, 1);

    mock.restoreAll();
  });

  it("marks run failed and does not persist results when ranking fails", async () => {
    const state = { runs: [], results: [], runId: 0 };

    const approvedReq = {
      requisition_code: "REQ-FAIL",
      req_status: "Approved",
      primary_skill: "Java",
      fulfillment_status: "Open"
    };

    const pool = {
      query: async (sql, params) => {
        const text = String(sql);

        if (text.includes("FROM rm_requisitions")) {
          return { rows: [approvedReq] };
        }
        if (text.includes("published_payload")) {
          return { rows: [{ published_payload: buildPlatformConfig() }] };
        }
        if (text.includes("FROM rm_recruiter_assignments")) {
          return { rows: [{ assignment_id: 1 }] };
        }
        if (text.includes("INSERT INTO oti_sourcing_run")) {
          state.runId += 1;
          const row = {
            run_id: state.runId,
            run_uuid: params[0],
            requisition_code: params[1],
            initiated_by: params[2],
            status: "processing",
            query_text: params[3],
            error_message: null,
            created_on: new Date(),
            completed_on: null
          };
          state.runs.push(row);
          return { rows: [row] };
        }
        if (text.includes("UPDATE oti_sourcing_run SET query_structured")) {
          return { rows: [] };
        }
        if (text.includes("INSERT INTO oti_sourcing_run_step")) {
          return { rows: [] };
        }
        if (text.includes("UPDATE oti_sourcing_run") && text.includes("'failed'")) {
          const run = state.runs[0];
          run.status = "failed";
          run.error_message = params[1];
          return { rows: [] };
        }
        if (text.includes("TALENT_POOL") || text.includes("m.is_active = FALSE")) {
          return { rows: [{ candidate_id: 9 }] };
        }
        if (text.includes("FROM cand_mstr")) {
          return {
            rows: [
              {
                candidate_id: 9,
                candidate_container: "TALENT_POOL",
                owner_employee_code: null,
                candidate_status: "REGISTERED"
              }
            ]
          };
        }
        if (text.includes("INSERT INTO md_enterprise_audit")) {
          return { rows: [] };
        }
        if (text.includes("INSERT INTO oti_sourcing_result")) {
          state.results.push({});
          return { rows: [] };
        }
        return { rows: [] };
      }
    };

    mock.method(otiMatchRankAgentService, "rankInternalCandidates", async () => {
      throw new Error("rank failure");
    });

    const req = {
      user: { employee_code: "REC-1", role_name: "Recruiter", email_id: "rec@test.com" }
    };

    await assert.rejects(
      () => otiOrchestratorService.executeSourcingRun(pool, "REQ-FAIL", req, {}),
      (error) => error.message === "rank failure"
    );

    assert.equal(state.runs[0].status, "failed");
    assert.equal(state.results.length, 0);

    mock.restoreAll();
  });

  it("returns existing run on idempotency key without creating a duplicate run", async () => {
    const existingRun = {
      run_id: 99,
      run_uuid: "oti-run-existing",
      requisition_code: "REQ-1",
      initiated_by: "REC-1",
      status: "completed",
      query_text: null,
      query_structured: {},
      error_message: null,
      created_on: new Date(),
      completed_on: new Date()
    };

    let insertRunCount = 0;

    const pool = {
      query: async (sql, params) => {
        const text = String(sql);

        if (text.includes("FROM rm_requisitions")) {
          return {
            rows: [
              {
                requisition_code: "REQ-1",
                req_status: "Approved",
                primary_skill: "Java",
                fulfillment_status: "Open"
              }
            ]
          };
        }
        if (text.includes("published_payload")) {
          return { rows: [{ published_payload: buildPlatformConfig() }] };
        }
        if (text.includes("FROM rm_recruiter_assignments")) {
          return { rows: [{ assignment_id: 1 }] };
        }
        if (text.includes("idempotency_key = $2")) {
          return { rows: [existingRun] };
        }
        if (text.includes("INSERT INTO oti_sourcing_run")) {
          insertRunCount += 1;
          return { rows: [] };
        }
        if (text.includes("SELECT * FROM oti_sourcing_run WHERE run_id")) {
          return { rows: [existingRun] };
        }
        if (text.includes("COUNT(*)::int AS total") && text.includes("oti_sourcing_result")) {
          return { rows: [{ total: 2 }] };
        }
        return { rows: [] };
      }
    };

    const summary = await otiOrchestratorService.executeSourcingRun(
      pool,
      "REQ-1",
      { user: { employee_code: "REC-1", role_name: "Recruiter", email_id: "r@t.com" } },
      { idempotency_key: "key-abc" }
    );

    assert.equal(insertRunCount, 0);
    assert.equal(summary.run_id, "oti-run-existing");
    assert.equal(summary.results_count, 2);
  });

  it("listRunResults returns empty results and run_failed for failed runs", async () => {
    const pool = {
      query: async (sql) => {
        if (sql.includes("FROM oti_sourcing_run WHERE run_uuid")) {
          return {
            rows: [
              {
                run_id: 1,
                run_uuid: "oti-run-failed",
                requisition_code: "REQ-1",
                initiated_by: "REC-1",
                status: "failed",
                error_message: "rank failure",
                query_text: null,
                query_structured: {},
                created_on: new Date(),
                completed_on: new Date()
              }
            ]
          };
        }
        if (sql.includes("published_payload")) {
          return { rows: [{ published_payload: buildPlatformConfig() }] };
        }
        return { rows: [] };
      }
    };

    const payload = await otiOrchestratorService.listRunResults(
      pool,
      "oti-run-failed",
      { user: { employee_code: "REC-1", role_name: "Recruiter" } }
    );

    assert.equal(payload.run_failed, true);
    assert.deepEqual(payload.results, []);
    assert.match(payload.error_message, /rank failure/);
  });
});

describe("oti recruiter actions human-in-the-loop", () => {
  it("records shortlist and dismiss without side effects", async () => {
    const inserted = [];

    const pool = {
      query: async (sql, params) => {
        if (sql.includes("FROM oti_sourcing_result r")) {
          return {
            rows: [
              {
                result_id: 8,
                run_id: 2,
                candidate_id: 100,
                run_uuid: "oti-run-x",
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
                run_id: 2,
                run_uuid: "oti-run-x",
                requisition_code: "REQ-1",
                initiated_by: "REC-1",
                status: "completed"
              }
            ]
          };
        }
        if (sql.includes("published_payload")) {
          return { rows: [{ published_payload: buildPlatformConfig() }] };
        }
        if (sql.includes("INSERT INTO oti_recruiter_action")) {
          inserted.push(params[2]);
          return {
            rows: [
              {
                action_id: inserted.length,
                action_type: params[2],
                note: params[3],
                actor_employee_code: params[4],
                created_on: new Date().toISOString()
              }
            ]
          };
        }
        if (sql.includes("INSERT INTO md_enterprise_audit")) {
          return { rows: [] };
        }
        return { rows: [] };
      }
    };

    const req = {
      user: { employee_code: "REC-1", role_name: "Recruiter", email_id: "rec@test.com" }
    };

    await otiRecruiterActionService.recordRecruiterAction(pool, 8, req, {
      action_type: "shortlist"
    });
    await otiRecruiterActionService.recordRecruiterAction(pool, 8, req, {
      action_type: "dismiss"
    });

    assert.deepEqual(inserted, ["shortlist", "dismiss"]);
  });
});
