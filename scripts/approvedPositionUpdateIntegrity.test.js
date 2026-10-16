const assert = require("node:assert/strict");
const { describe, it, beforeEach, mock } = require("node:test");

const requisitionFieldResolutionService = require("../services/requisitionFieldResolutionService");
const integrity = require("../utils/approvedPositionUpdateIntegrity");
const talentDemandDraftRepository = require("../repositories/talentDemandDraftRepository");
const talentDemandDraftService = require("../services/talentDemandDraftService");

function createMockQueryable(positionTitle = "Senior Engineer") {
  return {
    query: async (sql, params) => {
      const text = String(sql);
      if (text.includes("FROM wp_approved_positions") && text.includes("position_id")) {
        return {
          rows: [
            {
              position_id: params[0],
              position_title: positionTitle,
              status: "Active"
            }
          ]
        };
      }
      if (text.includes("FROM rm_requisitions")) {
        return { rows: [] };
      }
      throw new Error(`Unexpected query: ${text.slice(0, 100)}`);
    }
  };
}

describe("approvedPositionUpdateIntegrity", () => {
  /** @type {import('node:test').Mock<typeof requisitionFieldResolutionService.assertApprovedPositionSelectable>} */
  let assertSelectableMock;

  beforeEach(() => {
    assertSelectableMock = mock.method(
      requisitionFieldResolutionService,
      "assertApprovedPositionSelectable",
      async (_queryable, positionId) => ({
        position_id: positionId,
        position_title: "Senior Engineer",
        status: "Active"
      })
    );
  });

  it("rejects a conflicting job_title when the record is linked to an approved position", async () => {
    const queryable = createMockQueryable("Senior Engineer");

    await assert.rejects(
      () =>
        integrity.assertApprovedPositionUpdateIntegrity(queryable, {
          existingApprovedPositionId: "AP-1",
          payload: { job_title: "Fake Title" }
        }),
      (error) => {
        assert.equal(error.status, 400);
        assert.match(error.message, /job_title must match/);
        return true;
      }
    );
  });

  it("rejects changing approved_position_id once linked", async () => {
    const queryable = createMockQueryable();

    await assert.rejects(
      () =>
        integrity.assertApprovedPositionUpdateIntegrity(queryable, {
          existingApprovedPositionId: "AP-1",
          payload: { approved_position_id: "AP-2", job_title: "Senior Engineer" }
        }),
      (error) => {
        assert.equal(error.status, 400);
        assert.match(error.message, /approved_position_id cannot be changed/);
        return true;
      }
    );
  });

  it("allows valid updates to other fields with matching designation", async () => {
    const queryable = createMockQueryable("Senior Engineer");

    await integrity.assertApprovedPositionUpdateIntegrity(queryable, {
      existingApprovedPositionId: "AP-1",
      payload: {
        job_title: "Senior Engineer",
        primary_skill: "Java",
        work_location: "Remote"
      }
    });
  });

  it("allows updates that omit job_title when position is already linked", async () => {
    const queryable = createMockQueryable("Senior Engineer");

    await integrity.assertApprovedPositionUpdateIntegrity(queryable, {
      existingApprovedPositionId: "AP-1",
      payload: { primary_skill: "Python" }
    });
  });

  it("allows first-time approved_position_id selection with matching title", async () => {
    const queryable = createMockQueryable("Analyst");

    await integrity.assertApprovedPositionUpdateIntegrity(queryable, {
      existingApprovedPositionId: null,
      payload: {
        approved_position_id: "AP-NEW",
        job_title: "Analyst"
      }
    });

    assert.equal(assertSelectableMock.mock.calls.length, 1);
  });
});

describe("talentDemandDraftService approved-position update integrity", () => {
  /** @type {import('node:test').Mock<typeof talentDemandDraftRepository.getDraftById>} */
  let getDraftMock;
  /** @type {import('node:test').Mock<typeof talentDemandDraftRepository.updateDraft>} */
  let updateDraftMock;

  beforeEach(() => {
    getDraftMock = mock.method(
      talentDemandDraftRepository,
      "getDraftById",
      async () => ({
        draft_id: 1,
        status: "DRAFT",
        owner_employee_code: "EMP-1",
        approved_position_id: "AP-1",
        job_title: "Senior Engineer",
        result_requisition_code: null
      })
    );

    updateDraftMock = mock.method(
      talentDemandDraftRepository,
      "updateDraft",
      async (_pool, _id, data) => ({
        draft_id: 1,
        ...data
      })
    );

    mock.method(
      requisitionFieldResolutionService,
      "assertApprovedPositionSelectable",
      async (_queryable, positionId) => ({
        position_id: positionId,
        position_title: "Senior Engineer",
        status: "Active"
      })
    );
  });

  it("blocks persisting a conflicting title through updateDraft", async () => {
    const pool = createMockQueryable("Senior Engineer");

    await assert.rejects(
      () =>
        talentDemandDraftService.updateDraft(
          pool,
          1,
          { job_title: "Hacked Title", primary_skill: "Go" },
          { employee_code: "EMP-1" }
        ),
      (error) => {
        assert.equal(error.status, 400);
        assert.match(error.message, /job_title must match/);
        return true;
      }
    );

    assert.equal(updateDraftMock.mock.calls.length, 0);
  });

  it("persists non-designation field updates when title matches", async () => {
    const pool = createMockQueryable("Senior Engineer");

    const updated = await talentDemandDraftService.updateDraft(
      pool,
      1,
      { primary_skill: "Kotlin", job_title: "Senior Engineer" },
      { employee_code: "EMP-1" }
    );

    assert.equal(updated.primary_skill, "Kotlin");
    assert.equal(updateDraftMock.mock.calls.length, 1);
    getDraftMock.mock.restore();
    updateDraftMock.mock.restore();
  });
});
