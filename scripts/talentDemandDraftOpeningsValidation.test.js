const assert = require("node:assert/strict");
const { describe, it, mock } = require("node:test");

const talentDemandDraftService = require("../services/talentDemandDraftService");
const workAssignmentService = require("../services/workAssignmentService");

describe("talentDemandDraftService openings validation", () => {
  it("rejects negative openings_count on createDraft", async () => {
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
      query: async (sql) => {
        const text = String(sql);
        if (text.includes("FROM wp_approved_positions")) {
          return {
            rows: [
              {
                position_id: "AP-1",
                position_title: "Engineer",
                department: "Eng",
                grade: "G2",
                headcount: 1,
                budget_approved: 1000000,
                remaining_budget: 500000,
                status: "Active"
              }
            ]
          };
        }
        if (text.includes("FROM rm_requisitions")) {
          return { rows: [] };
        }
        return { rows: [] };
      }
    };

    try {
      await assert.rejects(
        () =>
          talentDemandDraftService.createDraft(
            pool,
            {
              approved_position_id: "AP-1",
              openings_count: -1,
              job_title: "Engineer"
            },
            { employee_code: "EMP-1", full_name: "User" }
          ),
        (error) => {
          assert.equal(error.status, 400);
          assert.match(error.message, /openings_count must be a whole number/i);
          return true;
        }
      );
    } finally {
      restore.mock.restore();
    }
  });
});
