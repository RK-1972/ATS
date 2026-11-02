"use strict";

const { describe, it, mock } = require("node:test");
const assert = require("node:assert/strict");

const otiCapabilityAuth = require("../services/oti/otiCapabilityAuth");
const legacyOperationalAdapter = require("../services/legacyOperationalAdapter");
const workAssignmentService = require("../services/workAssignmentService");
const { REQUISITION_STATUS } = require("../constants/requisitionStatus");

function buildPlatformConfig() {
  return {
    modules: [{ key: "ai", enabled: true }],
    ai_features: [{ key: "talent_intelligence", enabled: true }]
  };
}

function buildPool(adminRows = []) {
  return {
    query: async (sql, params) => {
      const text = String(sql);

      if (text.includes("published_payload")) {
        return { rows: [{ published_payload: buildPlatformConfig() }] };
      }

      if (text.includes("FROM rm_requisitions r") && text.includes("req_status = $1")) {
        assert.equal(params[0], REQUISITION_STATUS.APPROVED);
        return { rows: adminRows };
      }

      return { rows: [] };
    }
  };
}

describe("oti workspace requisition list", () => {
  it("returns all approved open requisitions for Admin", async () => {
    const adminRows = [
      { req_code: "REQ-ADMIN-1", job_title: "Engineer A", req_status: "Approved" },
      { req_code: "REQ-ADMIN-2", job_title: "Engineer B", req_status: "Approved" }
    ];

    const pool = buildPool(adminRows);
    const getMyRequisitionsMock = mock.method(
      legacyOperationalAdapter,
      "getMyRequisitions",
      async () => {
        throw new Error("getMyRequisitions should not be called for Admin");
      }
    );

    const rows = await otiCapabilityAuth.listTalentIntelligenceWorkspaceRequisitions(pool, {
      user: { employee_code: "ADM-1", role_name: "Admin" }
    });

    assert.equal(getMyRequisitionsMock.mock.callCount(), 0);
    assert.deepEqual(rows, adminRows);
  });

  it("returns assigned requisitions for Recruiter via my-requisitions adapter", async () => {
    const assignedRows = [{ req_code: "REQ-REC-1", job_title: "Assigned only" }];
    const pool = buildPool([{ req_code: "REQ-ADMIN-ONLY" }]);

    mock.method(workAssignmentService, "getEmployeeWorkAssignments", async () => [
      {
        assignment_code: "TALENT_INTELLIGENCE",
        is_active: true,
        master_is_active: true,
        workspace_flag: "showTalentIntelligenceWorkspace"
      }
    ]);

    const getMyRequisitionsMock = mock.method(
      legacyOperationalAdapter,
      "getMyRequisitions",
      async (_pool, recruiterCode) => {
        assert.equal(recruiterCode, "REC-1");
        return assignedRows;
      }
    );

    const rows = await otiCapabilityAuth.listTalentIntelligenceWorkspaceRequisitions(pool, {
      user: { employee_code: "REC-1", role_name: "Recruiter" }
    });

    assert.equal(getMyRequisitionsMock.mock.callCount(), 1);
    assert.deepEqual(rows, assignedRows);
  });

  it("allows Recruiter workspace list with assigned requisitions only (no work assignment)", async () => {
    const assignedRows = [{ req_code: "REQ-REC-2", job_title: "Assigned via routing" }];
    const pool = buildPool([{ req_code: "REQ-ADMIN-ONLY" }]);

    mock.method(workAssignmentService, "getEmployeeWorkAssignments", async () => []);

    const getMyRequisitionsMock = mock.method(
      legacyOperationalAdapter,
      "getMyRequisitions",
      async (_pool, recruiterCode) => {
        assert.equal(recruiterCode, "REC-2");
        return assignedRows;
      }
    );

    const rows = await otiCapabilityAuth.listTalentIntelligenceWorkspaceRequisitions(pool, {
      user: { employee_code: "REC-2", role_name: "Recruiter" }
    });

    assert.equal(getMyRequisitionsMock.mock.callCount(), 2);
    assert.deepEqual(rows, assignedRows);
  });

  it("returns assigned requisitions for TA Lead via my-requisitions adapter", async () => {
    const assignedRows = [{ req_code: "REQ-TA-1", job_title: "TA scoped" }];
    const pool = buildPool([{ req_code: "REQ-ADMIN-ONLY" }]);

    mock.method(workAssignmentService, "getEmployeeWorkAssignments", async () => [
      {
        assignment_code: "TALENT_INTELLIGENCE",
        is_active: true,
        master_is_active: true,
        workspace_flag: "showTalentIntelligenceWorkspace"
      }
    ]);

    const getMyRequisitionsMock = mock.method(
      legacyOperationalAdapter,
      "getMyRequisitions",
      async (_pool, employeeCode) => {
        assert.equal(employeeCode, "TA-1");
        return assignedRows;
      }
    );

    const rows = await otiCapabilityAuth.listTalentIntelligenceWorkspaceRequisitions(pool, {
      user: { employee_code: "TA-1", role_name: "TA Lead" }
    });

    assert.equal(getMyRequisitionsMock.mock.callCount(), 1);
    assert.deepEqual(rows, assignedRows);
  });
});
