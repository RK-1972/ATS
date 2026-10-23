const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  mapInterviewRowsToFeedbackSummaries,
  resolveCurrentStageDecision,
  shouldApplyPipelineStageFromInterviewFeedback,
  isInterviewCurrentStageDecision
} = require("../services/interviewRepeatStageService");

describe("feedback visibility summaries", () => {
  it("keeps each session feedback independently addressable by schedule_id", () => {
    const summaries = mapInterviewRowsToFeedbackSummaries([
      {
        interview_id: "INT-1",
        schedule_id: 101,
        round_type: "L1 Technical",
        feedback_submitted: true,
        final_outcome: "Selected",
        feedback_id: 1,
        feedback_outcome: "Selected",
        created_on: "2026-01-01T10:00:00.000Z",
        modified_on: "2026-01-02T10:00:00.000Z"
      },
      {
        interview_id: "INT-2",
        schedule_id: 102,
        round_type: "L1 Technical",
        feedback_submitted: true,
        final_outcome: "Rejected",
        feedback_id: 2,
        feedback_outcome: "Rejected",
        created_on: "2026-02-01T10:00:00.000Z",
        modified_on: "2026-03-01T10:00:00.000Z"
      }
    ]);

    assert.equal(summaries.length, 2);
    assert.equal(summaries[0].feedbackId, 1);
    assert.equal(summaries[0].viewFeedbackPath, "/view-feedback/101");
    assert.equal(summaries[1].feedbackId, 2);
    assert.equal(summaries[1].viewFeedbackPath, "/view-feedback/102");
    assert.equal(summaries[1].sessionLabel, "L1 Session 2");
  });
});

describe("repeat interview regression with feedback visibility", () => {
  it("selects the latest completed decision by feedback completion time", () => {
    const sessions = [
      {
        interview_id: "INT-1",
        round_type: "L1 Technical",
        interview_status: "Completed",
        feedback_submitted: true,
        final_outcome: "Selected",
        interview_date: "2026-03-01",
        modified_on: "2026-03-15T10:00:00.000Z"
      },
      {
        interview_id: "INT-2",
        round_type: "L1 Technical",
        interview_status: "Completed",
        feedback_submitted: true,
        final_outcome: "Rejected",
        interview_date: "2026-01-01",
        modified_on: "2026-02-01T10:00:00.000Z"
      }
    ];

    const decision = resolveCurrentStageDecision(sessions, "L1");

    assert.equal(decision.interviewId, "INT-1");
    assert.equal(decision.outcome, "Selected");
  });

  it("blocks L1 pipeline updates when mapping is already HR-advanced", () => {
    assert.equal(
      shouldApplyPipelineStageFromInterviewFeedback("HR Cleared", "L1 Technical"),
      false
    );
  });

  it("does not treat stale L1 feedback as the current stage decision owner", () => {
    const sessions = [
      {
        interview_id: "INT-1",
        round_type: "L1 Technical",
        interview_status: "Completed",
        feedback_submitted: true,
        final_outcome: "Selected",
        modified_on: "2026-02-01T10:00:00.000Z"
      },
      {
        interview_id: "INT-2",
        round_type: "L1 Technical",
        interview_status: "Completed",
        feedback_submitted: true,
        final_outcome: "Rejected",
        modified_on: "2026-04-01T10:00:00.000Z"
      }
    ];

    assert.equal(isInterviewCurrentStageDecision(sessions[0], sessions), false);
    assert.equal(isInterviewCurrentStageDecision(sessions[1], sessions), true);
  });
});
