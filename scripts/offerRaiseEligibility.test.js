const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const {
  interviewQualifiesForOfferRaise,
  assertMappingEligibleForOfferRaise,
  FINAL_HR_INTERVIEW_ROUND_TYPE,
  FINAL_HR_INTERVIEW_OUTCOME_SELECTED
} = require("../services/offerRaiseEligibilityService");

const mapping = {
  mapping_id: 101,
  map_id: 101,
  candidate_id: 5001,
  requisition_code: "REQ-100"
};

describe("interviewQualifiesForOfferRaise", () => {
  it("accepts HR Round Selected with matching requisition and map_id", () => {
    const interview = {
      map_id: 101,
      candidate_id: 5001,
      requisition_code: "REQ-100",
      round_type: FINAL_HR_INTERVIEW_ROUND_TYPE,
      final_outcome: FINAL_HR_INTERVIEW_OUTCOME_SELECTED,
      feedback_submitted: true
    };
    assert.equal(interviewQualifiesForOfferRaise(mapping, interview), true);
  });

  it("rejects non-Selected outcome", () => {
    const interview = {
      map_id: 101,
      candidate_id: 5001,
      requisition_code: "REQ-100",
      round_type: FINAL_HR_INTERVIEW_ROUND_TYPE,
      final_outcome: "Rejected",
      feedback_submitted: true
    };
    assert.equal(interviewQualifiesForOfferRaise(mapping, interview), false);
  });

  it("rejects Selected outcome from a different interview round", () => {
    const interview = {
      map_id: 101,
      candidate_id: 5001,
      requisition_code: "REQ-100",
      round_type: "L1 Technical",
      final_outcome: FINAL_HR_INTERVIEW_OUTCOME_SELECTED,
      feedback_submitted: true
    };
    assert.equal(interviewQualifiesForOfferRaise(mapping, interview), false);
  });

  it("rejects Selected HR outcome for a different requisition", () => {
    const interview = {
      map_id: 101,
      candidate_id: 5001,
      requisition_code: "REQ-200",
      round_type: FINAL_HR_INTERVIEW_ROUND_TYPE,
      final_outcome: FINAL_HR_INTERVIEW_OUTCOME_SELECTED,
      feedback_submitted: true
    };
    assert.equal(interviewQualifiesForOfferRaise(mapping, interview), false);
  });

  it("rejects Selected HR outcome for a different candidate on same requisition", () => {
    const interview = {
      map_id: 101,
      candidate_id: 9999,
      requisition_code: "REQ-100",
      round_type: FINAL_HR_INTERVIEW_ROUND_TYPE,
      final_outcome: FINAL_HR_INTERVIEW_OUTCOME_SELECTED,
      feedback_submitted: true
    };
    assert.equal(interviewQualifiesForOfferRaise(mapping, interview), false);
  });

  it("rejects when interview map_id does not match mapping", () => {
    const interview = {
      map_id: 202,
      candidate_id: 5001,
      requisition_code: "REQ-100",
      round_type: FINAL_HR_INTERVIEW_ROUND_TYPE,
      final_outcome: FINAL_HR_INTERVIEW_OUTCOME_SELECTED,
      feedback_submitted: true
    };
    assert.equal(interviewQualifiesForOfferRaise(mapping, interview), false);
  });
});

describe("assertMappingEligibleForOfferRaise", () => {
  it("rejects direct offer creation when no qualifying interview exists", async () => {
    const pool = {
      query: async () => ({ rows: [] })
    };

    await assert.rejects(
      () => assertMappingEligibleForOfferRaise(pool, mapping, null),
      (error) => {
        assert.equal(error.status, 400);
        assert.match(error.message, /Final HR Interview outcome is Selected/);
        return true;
      }
    );
  });

  it("accepts when a qualifying HR Selected interview exists for the mapping", async () => {
    const pool = {
      query: async () => ({
        rows: [
          {
            map_id: 101,
            candidate_id: 5001,
            requisition_code: "REQ-100",
            round_type: FINAL_HR_INTERVIEW_ROUND_TYPE,
            final_outcome: FINAL_HR_INTERVIEW_OUTCOME_SELECTED,
            feedback_submitted: true
          }
        ]
      })
    };

    await assertMappingEligibleForOfferRaise(pool, mapping, null);
  });
});
