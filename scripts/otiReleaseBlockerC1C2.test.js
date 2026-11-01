"use strict";

const { describe, it, mock } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const otiCapabilityAuth = require("../services/oti/otiCapabilityAuth");
const otiOrchestratorService = require("../services/oti/otiOrchestratorService");
const otiExternalRecruiterActionService = require("../services/oti/otiExternalRecruiterActionService");
const requisitionCapabilityAuth = require("../services/requisitionCapabilityAuth");
const resumeMatchService = require("../services/resumeMatchService");

function buildPlatformConfig() {
  return {
    modules: [{ key: "ai", enabled: true }],
    ai_features: [{ key: "talent_intelligence", enabled: true }]
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

function platformPool() {
  return {
    query: async (sql) => {
      if (String(sql).includes("published_payload")) {
        return { rows: [{ published_payload: buildPlatformConfig() }] };
      }
      return { rows: [] };
    }
  };
}

const approvedReq = {
  requisition_code: "REQ-1",
  req_status: "Approved",
  primary_skill: "Java",
  fulfillment_status: "Open"
};

describe("C-1 migration 075 BIGINT FK consistency", () => {
  it("uses BIGINT for all external_lead_id foreign keys", () => {
    const migrationPath = path.join(
      __dirname,
      "..",
      "migrations",
      "075_oti_phase4_resume_retrieval.sql"
    );
    const sql = fs.readFileSync(migrationPath, "utf8");

    assert.doesNotMatch(sql, /external_lead_id\s+INT\b/i);
    assert.match(sql, /external_lead_id BIGINT NOT NULL REFERENCES oti_external_lead\(external_lead_id\)/);
    assert.match(sql, /oti_resume_retrieval_event[\s\S]*external_lead_id BIGINT NOT NULL/);
  });
});

describe("C-2 standalone workspace authorization", () => {
  it("1 — Admin standalone workspace access without assignment", async () => {
    await otiCapabilityAuth.assertCanAccessOtiWorkspace(platformPool(), {
      user: { role_name: "Admin", employee_code: "ADM-1" }
    });

    mock.method(resumeMatchService, "assertResumeMatchAccess", async () => {});
    await otiCapabilityAuth.assertCanExecuteOtiWorkspaceSourcingRun(
      platformPool(),
      { user: { role_name: "Admin", employee_code: "ADM-1" } },
      approvedReq
    );
    mock.restoreAll();
  });

  it("2 — Recruiter standalone workspace with TALENT_INTELLIGENCE assignment", async () => {
    const pool = {
      query: async (sql) => {
        if (String(sql).includes("employee_work_assignment ewa")) {
          return { rows: assignmentRows("showTalentIntelligenceWorkspace") };
        }
        if (String(sql).includes("published_payload")) {
          return { rows: [{ published_payload: buildPlatformConfig() }] };
        }
        return { rows: [] };
      }
    };

    await otiCapabilityAuth.assertCanAccessOtiWorkspace(pool, {
      user: { role_name: "Recruiter", employee_code: "REC-1" }
    });
  });

  it("3 — Recruiter standalone workspace denied without assignment", async () => {
    const pool = {
      query: async (sql) => {
        if (String(sql).includes("employee_work_assignment ewa")) {
          return { rows: [] };
        }
        if (String(sql).includes("published_payload")) {
          return { rows: [{ published_payload: buildPlatformConfig() }] };
        }
        return { rows: [] };
      }
    };

    await assert.rejects(
      () =>
        otiCapabilityAuth.assertCanExecuteOtiWorkspaceSourcingRun(
          pool,
          { user: { role_name: "Recruiter", employee_code: "REC-1" } },
          approvedReq
        ),
      (error) => error.status === 403
    );
  });

  it("4 — TA Lead standalone workspace with assignment", async () => {
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

  it("5 — TA Lead denied when assigner permissions are absent", async () => {
    const pool = {
      query: async (sql) => {
        if (String(sql).includes("employee_work_assignment ewa")) {
          return { rows: assignmentRows("showTalentIntelligenceWorkspace") };
        }
        return { rows: [] };
      }
    };

    mock.method(requisitionCapabilityAuth, "assertCanAssignRecruiters", async () => {
      const error = new Error("Enterprise Access Denied.");
      error.status = 403;
      throw error;
    });

    await assert.rejects(
      () =>
        otiCapabilityAuth.assertCanAccessOtiWorkspace(pool, {
          user: { role_name: "TA Lead", employee_code: "TAL-1" }
        }),
      (error) => error.status === 403
    );

    mock.restoreAll();
  });
});

describe("C-2 requisition panel authorization", () => {
  it("6 — authorized requisition panel sourcing without workspace assignment", async () => {
    let resumeMatchCalled = false;
    mock.method(resumeMatchService, "assertResumeMatchAccess", async () => {
      resumeMatchCalled = true;
    });

    await otiCapabilityAuth.assertCanExecuteOtiRequisitionSourcingRun(
      platformPool(),
      { user: { role_name: "Recruiter", employee_code: "REC-1" } },
      approvedReq
    );

    assert.equal(resumeMatchCalled, true);
    mock.restoreAll();
  });

  it("7 — unauthorized requisition panel access denied", async () => {
    mock.method(resumeMatchService, "assertResumeMatchAccess", async () => {
      const error = new Error("Enterprise Access Denied.");
      error.status = 403;
      throw error;
    });

    await assert.rejects(
      () =>
        otiCapabilityAuth.assertCanExecuteOtiRequisitionSourcingRun(
          platformPool(),
          { user: { role_name: "Recruiter", employee_code: "REC-9" } },
          approvedReq
        ),
      (error) => error.status === 403
    );

    mock.restoreAll();
  });
});

describe("C-2 entry-point enforcement on orchestrator", () => {
  it("8 — workspace entry point rejects recruiter without assignment", async () => {
    const pool = {
      query: async (sql) => {
        if (String(sql).includes("FROM rm_requisitions")) {
          return { rows: [approvedReq] };
        }
        if (String(sql).includes("employee_work_assignment ewa")) {
          return { rows: [] };
        }
        if (String(sql).includes("published_payload")) {
          return { rows: [{ published_payload: buildPlatformConfig() }] };
        }
        return { rows: [] };
      }
    };

    mock.method(resumeMatchService, "assertResumeMatchAccess", async () => {});

    await assert.rejects(
      () =>
        otiOrchestratorService.executeSourcingRun(
          pool,
          "REQ-1",
          { user: { employee_code: "REC-1", role_name: "Recruiter" } },
          {},
          "workspace"
        ),
      (error) => error.status === 403
    );

    mock.restoreAll();
  });

  it("8b — requisition entry point allows sourcing without workspace assignment", async () => {
    let resumeMatchCalled = false;
    const pool = {
      query: async (sql) => {
        if (String(sql).includes("FROM rm_requisitions")) {
          return { rows: [approvedReq] };
        }
        if (String(sql).includes("published_payload")) {
          return { rows: [{ published_payload: buildPlatformConfig() }] };
        }
        return { rows: [] };
      }
    };

    mock.method(resumeMatchService, "assertResumeMatchAccess", async () => {
      resumeMatchCalled = true;
      const error = new Error("stop before run insert");
      error.status = 499;
      throw error;
    });

    await assert.rejects(
      () =>
        otiOrchestratorService.executeSourcingRun(
          pool,
          "REQ-1",
          { user: { employee_code: "REC-1", role_name: "Recruiter" } },
          {},
          "requisition"
        ),
      (error) => error.status === 499
    );

    assert.equal(resumeMatchCalled, true);
    mock.restoreAll();
  });

  it("9 — run history and results use run-record authorization", async () => {
    const pool = {
      query: async (sql) => {
        if (sql.includes("FROM oti_sourcing_run WHERE run_uuid")) {
          return {
            rows: [
              {
                run_id: 1,
                run_uuid: "oti-run-x",
                requisition_code: "REQ-1",
                initiated_by: "OTHER",
                status: "completed",
                error_message: null,
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
        if (sql.includes("FROM rm_requisitions")) {
          return { rows: [approvedReq] };
        }
        if (sql.includes("FROM rm_recruiter_assignments")) {
          return { rows: [{ assignment_id: 1 }] };
        }
        if (sql.includes("FROM oti_sourcing_result")) {
          return { rows: [] };
        }
        if (sql.includes("COUNT(*)::int AS total")) {
          return { rows: [{ total: 0 }] };
        }
        return { rows: [] };
      }
    };

    mock.method(resumeMatchService, "assertResumeMatchAccess", async () => {});

    const results = await otiOrchestratorService.listRunResults(pool, "oti-run-x", {
      user: { employee_code: "REC-1", role_name: "Recruiter" }
    });

    assert.equal(results.run.run_id, "oti-run-x");
    mock.restoreAll();
  });
});

describe("C-2 external lead and resume operations", () => {
  it("10 — external lead action uses requisition resume-match gate when run context absent", async () => {
    let resumeMatchCalled = false;
    const pool = {
      query: async (sql) => {
        const text = String(sql);
        if (text.includes("FROM oti_external_lead")) {
          return {
            rows: [
              {
                external_lead_id: 9007199254740991,
                lead_uuid: "lead-x",
                import_status: "new"
              }
            ]
          };
        }
        if (text.includes("published_payload")) {
          return { rows: [{ published_payload: buildPlatformConfig() }] };
        }
        if (text.includes("rm_requisitions")) {
          return { rows: [approvedReq] };
        }
        if (text.includes("oti_external_run_lead")) {
          return { rows: [{ linked: true }] };
        }
        if (text.includes("INSERT INTO oti_external_recruiter_action")) {
          return {
            rows: [
              {
                action_id: 1,
                action_type: "shortlist",
                created_on: new Date().toISOString()
              }
            ]
          };
        }
        if (text.includes("INSERT INTO md_enterprise_audit")) {
          return { rows: [] };
        }
        return { rows: [] };
      }
    };

    mock.method(resumeMatchService, "assertResumeMatchAccess", async () => {
      resumeMatchCalled = true;
    });

    await otiExternalRecruiterActionService.recordExternalLeadAction(
      pool,
      9007199254740991,
      { user: { employee_code: "REC-1", role_name: "Recruiter", name: "Rec" } },
      { action_type: "shortlist", requisition_code: "REQ-1" }
    );

    assert.equal(resumeMatchCalled, true);
    mock.restoreAll();
  });
});
