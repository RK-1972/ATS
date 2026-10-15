const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const {
  isRequisitionConsumedForCatalogue,
  enrichApprovedPositionsCatalogue
} = require("../services/workforcePlanningService");
const { REQUISITION_STATUS } = require("../constants/requisitionStatus");

describe("workforce approved position catalogue lifecycle", () => {
  it("treats unsubmitted open requisitions as resumable (not consumed)", () => {
    assert.equal(
      isRequisitionConsumedForCatalogue({
        requisition_code: "REQ-2026-0100",
        requestor_submitted_on: null,
        req_status: REQUISITION_STATUS.OPEN
      }),
      false
    );
  });

  it("treats submitted requisitions as consumed for catalogue hiding", () => {
    assert.equal(
      isRequisitionConsumedForCatalogue({
        requisition_code: "REQ-2026-0100",
        requestor_submitted_on: new Date().toISOString(),
        req_status: REQUISITION_STATUS.PENDING_LEVEL_1
      }),
      true
    );
  });

  it("keeps positions with open requisitions visible for resume", async () => {
    const pool = {
      query: async (sql) => {
        const text = String(sql);
        if (text.includes("FROM rm_requisitions")) {
          return {
            rows: [
              {
                approved_position_id: "AP-1",
                requisition_code: "REQ-2026-0200",
                requestor_submitted_on: null,
                req_status: REQUISITION_STATUS.OPEN,
                created_by: "EMP-1"
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

    const enriched = await enrichApprovedPositionsCatalogue(
      pool,
      {
        approved_positions: [
          { id: "AP-1", position: "Analyst", department: "HR" }
        ]
      },
      { user: { employee_code: "EMP-1" } }
    );

    assert.equal(enriched.approved_positions.length, 1);
    assert.equal(enriched.approved_positions[0].resume_mode, "requisition");
    assert.equal(enriched.approved_positions[0].open_requisition_code, "REQ-2026-0200");
  });

  it("hides positions after requisition submit consumes the slot", async () => {
    const pool = {
      query: async (sql) => {
        if (String(sql).includes("FROM rm_requisitions")) {
          return {
            rows: [
              {
                approved_position_id: "AP-2",
                requisition_code: "REQ-2026-0201",
                requestor_submitted_on: new Date().toISOString(),
                req_status: REQUISITION_STATUS.PENDING_LEVEL_1
              }
            ]
          };
        }
        return { rows: [] };
      }
    };

    const enriched = await enrichApprovedPositionsCatalogue(
      pool,
      {
        approved_positions: [{ id: "AP-2", position: "Lead", department: "HR" }]
      },
      { user: { employee_code: "EMP-1" } }
    );

    assert.equal(enriched.approved_positions.length, 0);
  });

  it("surfaces in-progress talent demand drafts for resume", async () => {
    const pool = {
      query: async (sql) => {
        const text = String(sql);
        if (text.includes("FROM rm_requisitions")) {
          return { rows: [] };
        }
        if (text.includes("FROM td_draft_mstr")) {
          return {
            rows: [
              {
                draft_id: 99,
                draft_code: "TD-DRAFT-2026-00009999",
                approved_position_id: "AP-3",
                status: "DRAFT",
                result_requisition_code: null,
                owner_employee_code: "EMP-1"
              }
            ]
          };
        }
        return { rows: [] };
      }
    };

    const enriched = await enrichApprovedPositionsCatalogue(
      pool,
      {
        approved_positions: [{ id: "AP-3", position: "Dev", department: "HR" }]
      },
      { user: { employee_code: "EMP-1" } }
    );

    assert.equal(enriched.approved_positions[0].resume_mode, "draft");
    assert.equal(enriched.approved_positions[0].open_draft_id, 99);
  });

  it("does not expose legacy requisition resume metadata to non-owners", async () => {
    const pool = {
      query: async (sql) => {
        const text = String(sql);
        if (text.includes("FROM rm_requisitions")) {
          return {
            rows: [
              {
                approved_position_id: "AP-4",
                requisition_code: "REQ-2026-0202",
                requestor_submitted_on: null,
                req_status: REQUISITION_STATUS.OPEN,
                created_by: "EMP-OTHER"
              }
            ]
          };
        }
        if (text.includes("FROM td_draft_mstr")) {
          return { rows: [] };
        }
        if (text.includes("FROM user_mstr")) {
          return { rows: [{ full_name: "Requestor One" }] };
        }
        return { rows: [] };
      }
    };

    const enriched = await enrichApprovedPositionsCatalogue(
      pool,
      {
        approved_positions: [{ id: "AP-4", position: "Mgr", department: "HR" }]
      },
      { user: { employee_code: "EMP-1", email_id: "req1@example.com" } }
    );

    assert.equal(enriched.approved_positions.length, 0);
  });
});
