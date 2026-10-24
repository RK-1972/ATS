const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const candidateOfferHoldService = require("../services/candidateOfferHoldService");

describe("candidateOfferHoldService policy locks", () => {
  it("assertNoActiveHoldUnderPolicyLock rejects when active hold exists", async () => {
    const client = {
      query: async (sql) => {
        if (sql.includes("rm_candidate_offer_hold")) {
          return {
            rows: [
              {
                hold_id: 9,
                hold_status: "Active",
                source_requisition_code: "REQ-1"
              }
            ]
          };
        }

        return { rows: [] };
      }
    };

    await assert.rejects(
      () =>
        candidateOfferHoldService.assertNoActiveHoldUnderPolicyLock(
          client,
          1001,
          { user: { employee_code: "E1" } }
        ),
      (error) => {
        assert.equal(error.status, 409);
        assert.match(error.message, /Offer Hold/i);
        return true;
      }
    );
  });

  it("assertCandidateEligibleForStageOnMapping allows same requisition", async () => {
    const client = {
      query: async (sql) => {
        if (sql.includes("rm_candidate_offer_hold")) {
          return {
            rows: [
              {
                hold_id: 1,
                source_requisition_code: "REQ-SOURCE"
              }
            ]
          };
        }

        return { rows: [] };
      }
    };

    const hold =
      await candidateOfferHoldService.assertCandidateEligibleForStageOnMapping(
        client,
        55,
        "REQ-SOURCE",
        { user: { employee_code: "E1" } },
        { client }
      );

    assert.equal(hold.hold_id, 1);
  });

  it("assertCandidateEligibleForStageOnMapping blocks other requisitions", async () => {
    const client = {
      query: async (sql) => {
        if (sql.includes("rm_candidate_offer_hold")) {
          return {
            rows: [
              {
                hold_id: 1,
                source_requisition_code: "REQ-SOURCE"
              }
            ]
          };
        }

        return { rows: [] };
      }
    };

    await assert.rejects(
      () =>
        candidateOfferHoldService.assertCandidateEligibleForStageOnMapping(
          client,
          55,
          "REQ-OTHER",
          { user: { employee_code: "E1" } },
          { client }
        ),
      (error) => error.status === 409
    );
  });
});
