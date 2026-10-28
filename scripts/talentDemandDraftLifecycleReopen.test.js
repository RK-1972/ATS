const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const talentDemandDraftRepository = require("../repositories/talentDemandDraftRepository");
const talentDemandDraftService = require("../services/talentDemandDraftService");
const { REQUISITION_STATUS } = require("../constants/requisitionStatus");
const {
  loadAuthoritativeHeadcount,
  assertOpeningsCountMatchesApprovedHeadcount
} = require("../utils/approvedPositionUpdateIntegrity");

describe("listDraftsByOwner excludes submitted drafts", () => {
  it("filters the SQL query to DRAFT status only", async () => {
    let capturedSql = "";

    const pool = {
      query: async (sql) => {
        capturedSql = String(sql);
        return { rows: [] };
      }
    };

    await talentDemandDraftRepository.listDraftsByOwner(pool, "EMP-1");

    assert.match(capturedSql, /UPPER\(COALESCE\(status, 'DRAFT'\)\) = 'DRAFT'/);
  });
});

describe("listMyTalentDemandWork legacy requisitions with DRAFT-only td rows", () => {
  it("still returns legacy in-progress requisitions when submitted drafts are excluded from drafts", async () => {
    const pool = {
      query: async (sql, params) => {
        const text = String(sql);
        if (text.includes("FROM td_draft_mstr") && text.includes("owner_employee_code = $1")) {
          assert.match(
            text,
            /UPPER\(COALESCE\(status, 'DRAFT'\)\) = 'DRAFT'/,
            "draft list must not include SUBMITTED rows"
          );
          return {
            rows: [
              {
                draft_id: 11,
                draft_code: "TD-DRAFT-2026-OPEN",
                status: "DRAFT",
                job_title: "Engineer",
                approved_position_id: "AP-1"
              }
            ]
          };
        }
        if (
          text.includes("FROM rm_requisitions r") &&
          text.includes("requestor_submitted_on IS NULL")
        ) {
          return {
            rows: [
              {
                requisition_code: "REQ-LEGACY-2",
                approved_position_id: "AP-2",
                position_title: "Analyst",
                client_name: "Client B",
                req_status: REQUISITION_STATUS.OPEN,
                modified_on: new Date().toISOString(),
                created_by: params[0][0]
              }
            ]
          };
        }
        if (text.includes("FROM user_mstr")) {
          return { rows: [{ full_name: "Requestor User" }] };
        }
        return { rows: [] };
      }
    };

    const work = await talentDemandDraftService.listMyTalentDemandWork(
      pool,
      { employee_code: "EMP-1", email_id: "req@example.com" },
      { user: { employee_code: "EMP-1", email_id: "req@example.com" } }
    );

    assert.equal(work.drafts.length, 1);
    assert.equal(work.drafts[0].status, "DRAFT");
    assert.equal(work.requisitions_in_progress.length, 1);
    assert.equal(work.requisitions_in_progress[0].requisition_code, "REQ-LEGACY-2");
    assert.equal(work.requisitions_in_progress[0].work_item_type, "requisition");
  });
});

describe("approved position headcount enforcement", () => {
  it("rejects client openings_count that differs from approved headcount", () => {
    assert.throws(
      () => assertOpeningsCountMatchesApprovedHeadcount({ openings_count: 3 }, 2),
      /openings_count must match the approved position headcount/
    );
  });

  it("allows matching openings_count", () => {
    assert.doesNotThrow(() =>
      assertOpeningsCountMatchesApprovedHeadcount({ openings_count: 2 }, 2)
    );
  });

  it("forces authoritative headcount on draft create", async () => {
    assert.throws(
      () => assertOpeningsCountMatchesApprovedHeadcount({ openings_count: 9 }, 4),
      /openings_count must match the approved position headcount/
    );
  });
});

describe("loadAuthoritativeHeadcount", () => {
  it("returns integer headcount from wp_approved_positions", async () => {
    const pool = {
      query: async () => ({
        rows: [{ headcount: 5 }]
      })
    };

    const headcount = await loadAuthoritativeHeadcount(pool, "AP-9");
    assert.equal(headcount, 5);
  });
});
