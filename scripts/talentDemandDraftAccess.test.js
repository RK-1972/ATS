const assert = require("node:assert/strict");
const { describe, it, mock, afterEach } = require("node:test");

const talentDemandDraftService = require("../services/talentDemandDraftService");
const talentDemandDraftRepository = require("../repositories/talentDemandDraftRepository");

describe("talentDemandDraftService draft access control", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it("rejects loading a draft owned by another employee", async () => {
    mock.method(talentDemandDraftRepository, "getDraftById", async () => ({
      draft_id: 42,
      status: "DRAFT",
      owner_employee_code: "EMP-OTHER",
      approved_position_id: "AP-1"
    }));

    await assert.rejects(
      () =>
        talentDemandDraftService.getDraft(
          {},
          42,
          { employee_code: "EMP-1" }
        ),
      (error) => {
        assert.equal(error.status, 403);
        assert.match(error.message, /do not have access/i);
        return true;
      }
    );
  });

  it("returns owned drafts for listMyTalentDemandWork", async () => {
    mock.method(talentDemandDraftRepository, "listDraftsByOwner", async (_pool, code) => {
      assert.equal(code, "EMP-1");
      return [
        {
          draft_id: 7,
          draft_code: "TD-DRAFT-2026-7",
          status: "DRAFT",
          approved_position_id: "AP-1",
          job_title: "Engineer"
        }
      ];
    });

    const work = await talentDemandDraftService.listMyTalentDemandWork(
      {},
      { employee_code: "EMP-1" }
    );

    assert.equal(work.drafts.length, 1);
    assert.equal(work.drafts[0].draft_id, 7);
    assert.equal(work.drafts[0].approved_position_id, "AP-1");
  });
});
