const assert = require("node:assert/strict");
const { describe, it, mock } = require("node:test");

const requisitionFieldResolutionService = require("../services/requisitionFieldResolutionService");
const { createRequisition } = require("../services/workforcePlanningService");
const recruitmentService = require("../services/recruitmentService");
const talentDemandDraftService = require("../services/talentDemandDraftService");
const workAssignmentService = require("../services/workAssignmentService");

function buildConfigRow(positionId) {
  return {
    draft_payload: {
      approved_positions: [
        {
          id: positionId,
          position: "Analyst",
          department: "HR",
          grade: "G1",
          headcount: 1,
          budget_approved: 1000000,
          remaining_budget: 500000,
          requisitions_created: 0,
          status: "Active"
        }
      ],
      meta: { last_updated: new Date().toISOString() }
    }
  };
}

function approvedPositionRow(positionId, overrides = {}) {
  return {
    position_id: positionId,
    position_title: "Analyst",
    department: "HR",
    grade: "G1",
    headcount: 1,
    budget_approved: 1000000,
    remaining_budget: 500000,
    status: "Active",
    ...overrides
  };
}

describe("approved position requisition creation gate", () => {
  it("rejects selectable positions with no remaining budget", async () => {
    const pool = {
      query: async (sql, params) => {
        const text = String(sql);
        if (text.includes("FROM wp_approved_positions")) {
          return {
            rows: [
              approvedPositionRow("AP-1", {
                remaining_budget: 0,
                status: "Active"
              })
            ]
          };
        }
        if (text.includes("FROM rm_requisitions") && text.includes("approved_position_id")) {
          return { rows: [] };
        }
        throw new Error(`unexpected query: ${text}`);
      }
    };

    await assert.rejects(
      () =>
        requisitionFieldResolutionService.assertApprovedPositionSelectable(
          pool,
          "AP-1"
        ),
      (error) => {
        assert.equal(error.status, 400);
        assert.match(error.message, /remaining approved budget/i);
        return true;
      }
    );
  });

  it("createRequisition denies users without REQUISITION_REQUESTOR assignment", async () => {
    const restore = mock.method(
      workAssignmentService,
      "getEmployeeWorkAssignments",
      async () => []
    );

    try {
      await assert.rejects(
        () =>
          createRequisition(
            {
              query: async (sql) => {
                const text = String(sql);
                if (text.includes("FROM wp_config_state")) {
                  return { rows: [buildConfigRow("AP-1")] };
                }
                if (text.includes("FROM wp_approved_positions")) {
                  return { rows: [approvedPositionRow("AP-1")] };
                }
                if (text.includes("FROM rm_requisitions")) {
                  return { rows: [] };
                }
                if (text.includes("FROM td_draft_mstr")) {
                  return { rows: [] };
                }
                return { rows: [] };
              }
            },
            "AP-1",
            { user: { employee_code: "EMP-NO-REQ" } }
          ),
        (error) => {
          assert.equal(error.status, 403);
          assert.match(error.message, /not authorized to create a Requisition/i);
          return true;
        }
      );
    } finally {
      restore.mock.restore();
    }
  });

  it("createFromApprovedPosition rejects missing approved_position_id", async () => {
    await assert.rejects(
      () =>
        recruitmentService.createFromApprovedPosition(
          { query: async () => ({ rows: [] }) },
          "",
          {},
          { user: { employee_code: "EMP-1" } }
        ),
      (error) => {
        assert.equal(error.status, 400);
        assert.match(error.message, /approved_position_id/i);
        return true;
      }
    );
  });

  it("createDraft requires approved_position_id", async () => {
    await assert.rejects(
      () =>
        talentDemandDraftService.createDraft(
          { query: async () => ({ rows: [] }) },
          { job_title: "Engineer" },
          { employee_code: "EMP-1" }
        ),
      (error) => {
        assert.equal(error.status, 400);
        assert.match(error.message, /approved_position_id is required/i);
        return true;
      }
    );
  });

  it("authorized requestor can start createRequisition for an eligible position", async () => {
    const positionId = "AP-OK-1";
    const restore = mock.method(
      workAssignmentService,
      "getEmployeeWorkAssignments",
      async () => [
        {
          assignment_code: "REQUISITION_REQUESTOR",
          is_active: true,
          master_is_active: true
        }
      ]
    );

    const pool = {
      query: async (sql, params) => {
        const text = String(sql);
        if (text.includes("FROM wp_config_state")) {
          return { rows: [buildConfigRow(positionId)] };
        }
        if (text.includes("FROM wp_approved_positions")) {
          return { rows: [approvedPositionRow(positionId)] };
        }
        if (text.includes("FROM rm_requisitions") && text.includes("approved_position_id = $1")) {
          return { rows: [] };
        }
        if (text.includes("FROM rm_requisitions") && text.includes("ANY")) {
          return { rows: [] };
        }
        if (text.includes("FROM td_draft_mstr")) {
          return { rows: [] };
        }
        if (text.includes("INSERT INTO td_draft_mstr")) {
          return {
            rows: [
              {
                draft_id: 501,
                draft_code: "TD-DRAFT-501",
                status: "DRAFT",
                approved_position_id: positionId,
                owner_employee_code: "EMP-REQ"
              }
            ]
          };
        }
        if (text.includes("pc_config_state")) {
          return { rows: [{ published_payload: { modules: [] } }] };
        }
        return { rows: [] };
      }
    };

    try {
      const result = await createRequisition(pool, positionId, {
        user: { employee_code: "EMP-REQ", email_id: "req@example.com", full_name: "Req User" }
      });

      assert.equal(result.resumeMode, "create");
      assert.equal(result.draftId, 501);
    } finally {
      restore.mock.restore();
    }
  });
});
