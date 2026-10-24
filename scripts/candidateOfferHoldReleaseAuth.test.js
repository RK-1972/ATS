const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const candidateOfferHoldService = require("../services/candidateOfferHoldService");

function mockClient(responses = {}) {
  return {
    query: async (sql, params) => {
      if (sql.includes("om_offers") && responses.offerRequisition) {
        return { rows: [{ requisition_code: responses.offerRequisition }] };
      }

      if (sql.includes("rm_recruiter_assignments") && responses.assignments) {
        return { rows: responses.assignments };
      }

      return { rows: [] };
    }
  };
}

describe("offer hold release authorization", () => {
  it("allows release when exactly one active assignment matches source requisition", async () => {
    const hold = {
      source_requisition_code: "REQ-100",
      offer_id: "OFF-1"
    };

    const client = mockClient({
      assignments: [
        {
          assignment_id: 7,
          recruiter_code: "REC-1",
          requisition_code: "REQ-100"
        }
      ]
    });

    const result = await candidateOfferHoldService.resolveOfferHoldReleaseAssignment(
      client,
      hold,
      "REC-1"
    );

    assert.equal(result.requisitionCode, "REQ-100");
    assert.equal(result.assignment.assignment_id, 7);
  });

  it("denies release when recruiter is not assigned to the hold source requisition", async () => {
    const hold = { source_requisition_code: "REQ-100", offer_id: "OFF-1" };
    const client = mockClient({ assignments: [] });

    await assert.rejects(
      () =>
        candidateOfferHoldService.resolveOfferHoldReleaseAssignment(
          client,
          hold,
          "REC-OTHER"
        ),
      (error) => error.status === 403
    );
  });

  it("denies release when multiple active assignments are ambiguous", async () => {
    const hold = { source_requisition_code: "REQ-100", offer_id: "OFF-1" };
    const client = mockClient({
      assignments: [
        { assignment_id: 1, recruiter_code: "REC-1", requisition_code: "REQ-100" },
        { assignment_id: 2, recruiter_code: "REC-1", requisition_code: "REQ-100" }
      ]
    });

    await assert.rejects(
      () =>
        candidateOfferHoldService.resolveOfferHoldReleaseAssignment(
          client,
          hold,
          "REC-1"
        ),
      (error) => error.status === 409
    );
  });

  it("resolves requisition from offer when hold source code is missing", async () => {
    const hold = { source_requisition_code: null, offer_id: "OFF-9" };
    const client = mockClient({
      offerRequisition: "REQ-FROM-OFFER",
      assignments: [
        {
          assignment_id: 3,
          recruiter_code: "REC-1",
          requisition_code: "REQ-FROM-OFFER"
        }
      ]
    });

    const result = await candidateOfferHoldService.resolveOfferHoldReleaseAssignment(
      client,
      hold,
      "REC-1"
    );

    assert.equal(result.requisitionCode, "REQ-FROM-OFFER");
  });
});
