const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const { createRequisition } = require("../services/workforcePlanningService");
const recruitmentService = require("../services/recruitmentService");
const { REQUISITION_STATUS } = require("../constants/requisitionStatus");

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
          requisitions_created: 0,
          status: "Active"
        }
      ],
      meta: { last_updated: new Date().toISOString() }
    }
  };
}

describe("legacy requisition requestor authorization", () => {
  it("createRequisition returns existing code for the owning requestor", async () => {
    const positionId = "AP-OWNER-1";
    const pool = {
      query: async (sql) => {
        const text = String(sql);
        if (text.includes("FROM wp_config_state")) {
          return { rows: [buildConfigRow(positionId)] };
        }
        if (text.includes("FROM wp_approved_positions")) {
          return {
            rows: [
              {
                position_id: positionId,
                position_title: "Analyst",
                department: "HR",
                grade: "G1",
                headcount: 1,
                budget_approved: 1000000,
                remaining_budget: 500000,
                status: "Active"
              }
            ]
          };
        }
        if (text.includes("FROM rm_requisitions") && text.includes("approved_position_id = $1")) {
          return {
            rows: [
              {
                requisition_code: "REQ-OWN-1",
                requestor_submitted_on: null,
                req_status: REQUISITION_STATUS.OPEN,
                created_by: "EMP-OWNER"
              }
            ]
          };
        }
        if (text.includes("FROM rm_requisitions") && text.includes("ANY")) {
          return {
            rows: [
              {
                approved_position_id: positionId,
                requisition_code: "REQ-OWN-1",
                requestor_submitted_on: null,
                req_status: REQUISITION_STATUS.OPEN,
                created_by: "EMP-OWNER"
              }
            ]
          };
        }
        if (text.includes("FROM td_draft_mstr")) {
          return { rows: [] };
        }
        return { rows: [] };
      }
    };

    const result = await createRequisition(pool, positionId, {
      user: { employee_code: "EMP-OWNER", email_id: "owner@example.com" }
    });

    assert.equal(result.requisitionId, "REQ-OWN-1");
    assert.equal(result.resumeMode, "requisition");
  });

  it("createRequisition denies non-owner resume of legacy open requisition", async () => {
    const positionId = "AP-FOREIGN-1";
    const pool = {
      query: async (sql) => {
        const text = String(sql);
        if (text.includes("FROM wp_config_state")) {
          return { rows: [buildConfigRow(positionId)] };
        }
        if (text.includes("FROM wp_approved_positions")) {
          return {
            rows: [
              {
                position_id: positionId,
                position_title: "Analyst",
                department: "HR",
                grade: "G1",
                headcount: 1,
                budget_approved: 1000000,
                remaining_budget: 500000,
                status: "Active"
              }
            ]
          };
        }
        if (text.includes("FROM rm_requisitions") && text.includes("approved_position_id = $1")) {
          return {
            rows: [
              {
                requisition_code: "REQ-FOREIGN",
                requestor_submitted_on: null,
                req_status: REQUISITION_STATUS.OPEN,
                created_by: "EMP-OTHER"
              }
            ]
          };
        }
        if (text.includes("FROM user_mstr")) {
          return { rows: [{ full_name: "Intruder User" }] };
        }
        return { rows: [] };
      }
    };

    await assert.rejects(
      () =>
        createRequisition(pool, positionId, {
          user: { employee_code: "EMP-INTRUDER", email_id: "intruder@example.com" }
        }),
      (error) => {
        assert.equal(error.status, 403);
        assert.match(error.message, /not authorized/i);
        return true;
      }
    );
  });

  it("submitRequisition denies non-owner submit", async () => {
    const pool = {
      query: async (sql) => {
        const text = String(sql);
        if (text.includes("pc_config_state")) {
          return { rows: [{ published_payload: null }] };
        }
        if (text.includes("FROM user_mstr")) {
          return { rows: [{ full_name: "Intruder User" }] };
        }
        return { rows: [] };
      },
      connect: async () => ({
        query: async (sql) => {
          const text = String(sql);
          if (text === "BEGIN" || text === "ROLLBACK") {
            return { rows: [] };
          }
          if (text.includes("FROM rm_requisitions r")) {
            return {
              rows: [
                {
                  requisition_code: "REQ-SUBMIT-1",
                  created_by: "EMP-OWNER",
                  requestor_submitted_on: null,
                  req_status: REQUISITION_STATUS.OPEN,
                  approved_position_id: "AP-1"
                }
              ]
            };
          }
          throw new Error(`Unexpected client query: ${text}`);
        },
        release: () => {}
      })
    };

    await assert.rejects(
      () =>
        recruitmentService.submitRequisition(pool, "REQ-SUBMIT-1", {}, {
          user: { employee_code: "EMP-INTRUDER", email_id: "intruder@example.com" }
        }),
      (error) => {
        assert.equal(error.status, 403);
        assert.match(error.message, /not authorized/i);
        return true;
      }
    );
  });
});
