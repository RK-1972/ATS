const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  REPEAT_GUARD_CODES,
  resolveInterviewStageBucket,
  resolveCurrentStageDecision,
  assignSessionNumbers,
  shouldApplyPipelineStageFromInterviewFeedback,
  isInterviewCurrentStageDecision,
  evaluateRepeatScheduleGuardState,
  parseRepeatSchedulePayload
} = require("../services/interviewRepeatStageService");

function session(overrides) {
  return {
    interview_id: "INT-1",
    round_type: "L1 Technical",
    interview_status: "Scheduled",
    feedback_submitted: false,
    final_outcome: null,
    interview_date: "2026-01-01",
    ...overrides
  };
}

describe("interview stage buckets", () => {
  it("maps L1/L2/HR round types", () => {
    assert.equal(resolveInterviewStageBucket("L1 Technical"), "L1");
    assert.equal(resolveInterviewStageBucket("L2 Managerial"), "L2");
    assert.equal(resolveInterviewStageBucket("HR Round"), "HR");
  });
});

describe("current stage decision", () => {
  it("uses the latest completed session outcome for the bucket", () => {
    const sessions = [
      session({
        interview_id: "INT-1",
        interview_status: "Completed",
        feedback_submitted: true,
        final_outcome: "Selected",
        interview_date: "2026-01-01"
      }),
      session({
        interview_id: "INT-2",
        interview_status: "Completed",
        feedback_submitted: true,
        final_outcome: "Rejected",
        interview_date: "2026-02-01"
      })
    ];

    const decision = resolveCurrentStageDecision(sessions, "L1");

    assert.equal(decision.outcome, "Rejected");
    assert.equal(decision.interviewId, "INT-2");
  });

  it("uses feedback completion time rather than interview slot date", () => {
    const sessions = [
      session({
        interview_id: "INT-1",
        interview_status: "Completed",
        feedback_submitted: true,
        final_outcome: "Selected",
        interview_date: "2026-03-01",
        modified_on: "2026-03-15T10:00:00.000Z"
      }),
      session({
        interview_id: "INT-2",
        interview_status: "Completed",
        feedback_submitted: true,
        final_outcome: "Rejected",
        interview_date: "2026-01-01",
        modified_on: "2026-02-01T10:00:00.000Z"
      })
    ];

    const decision = resolveCurrentStageDecision(sessions, "L1");

    assert.equal(decision.outcome, "Selected");
    assert.equal(decision.interviewId, "INT-1");
  });

  it("ignores cancelled sessions without feedback", () => {
    const guard = evaluateRepeatScheduleGuardState(
      [
        session({
          interview_status: "Cancelled",
          feedback_submitted: false
        }),
        session({
          interview_id: "INT-2",
          interview_status: "Completed",
          feedback_submitted: true,
          final_outcome: "Selected"
        })
      ],
      "L1 Technical"
    );

    assert.equal(guard.code, REPEAT_GUARD_CODES.CONFIRM_SELECTED);
    assert.equal(guard.currentDecision.outcome, "Selected");
  });
});

describe("session numbering", () => {
  it("labels sessions per stage bucket", () => {
    const numbered = assignSessionNumbers([
      session({ interview_id: "A", round_type: "L1 Technical" }),
      session({ interview_id: "B", round_type: "L2 Technical" }),
      session({ interview_id: "C", round_type: "L1 Non-Technical" })
    ]);

    const l1Sessions = numbered.filter((row) => row.stageBucket === "L1");

    assert.equal(l1Sessions.length, 2);
    assert.equal(l1Sessions[0].sessionLabel, "L1 Session 1");
    assert.equal(l1Sessions[1].sessionLabel, "L1 Session 2");
  });
});

describe("pipeline regression guard", () => {
  it("skips pipeline updates when mapping is beyond the interview bucket", () => {
    assert.equal(
      shouldApplyPipelineStageFromInterviewFeedback(
        "L2 Technical Cleared",
        "L1 Technical"
      ),
      false
    );
  });

  it("allows pipeline updates when mapping is still within the bucket", () => {
    assert.equal(
      shouldApplyPipelineStageFromInterviewFeedback(
        "L1 Interview Scheduled",
        "L1 Technical"
      ),
      true
    );
  });

  it("blocks L1 feedback from changing an HR-advanced mapping", () => {
    assert.equal(
      shouldApplyPipelineStageFromInterviewFeedback("HR Cleared", "L1 Technical"),
      false
    );
  });

  it("blocks L2 feedback from changing an HR-advanced mapping", () => {
    assert.equal(
      shouldApplyPipelineStageFromInterviewFeedback("HR Cleared", "L2 Technical"),
      false
    );
  });
});

describe("current stage decision ownership for pipeline updates", () => {
  it("allows pipeline update only for the winning session", () => {
    const sessions = [
      session({
        interview_id: "INT-1",
        interview_status: "Completed",
        feedback_submitted: true,
        final_outcome: "Selected",
        modified_on: "2026-03-01T10:00:00.000Z"
      }),
      session({
        interview_id: "INT-2",
        interview_status: "Completed",
        feedback_submitted: true,
        final_outcome: "Rejected",
        modified_on: "2026-04-01T10:00:00.000Z"
      })
    ];

    assert.equal(
      isInterviewCurrentStageDecision(sessions[1], sessions),
      true
    );
    assert.equal(
      isInterviewCurrentStageDecision(sessions[0], sessions),
      false
    );
  });
});

describe("repeat schedule guard state", () => {
  it("requires confirmation after a selected session", () => {
    const guard = evaluateRepeatScheduleGuardState(
      [
        session({
          interview_status: "Completed",
          feedback_submitted: true,
          final_outcome: "Selected"
        })
      ],
      "L1 Technical"
    );

    assert.equal(guard.code, REPEAT_GUARD_CODES.CONFIRM_SELECTED);
  });

  it("requires override after a rejected session", () => {
    const guard = evaluateRepeatScheduleGuardState(
      [
        session({
          interview_status: "Completed",
          feedback_submitted: true,
          final_outcome: "Rejected"
        })
      ],
      "L1 Technical"
    );

    assert.equal(guard.code, REPEAT_GUARD_CODES.OVERRIDE_REJECTED);
  });

  it("blocks duplicate active scheduled sessions", () => {
    const guard = evaluateRepeatScheduleGuardState(
      [session({ interview_status: "Scheduled", feedback_submitted: false })],
      "L1 Technical"
    );

    assert.equal(guard.code, REPEAT_GUARD_CODES.ACTIVE_SCHEDULED);
  });

  it("allows scheduling when prior session was cancelled", () => {
    const guard = evaluateRepeatScheduleGuardState(
      [
        session({
          interview_status: "Cancelled",
          feedback_submitted: false
        })
      ],
      "L1 Technical"
    );

    assert.equal(guard.code, REPEAT_GUARD_CODES.ALLOW);
  });
});

describe("repeat schedule payload parsing", () => {
  it("reads snake_case and camelCase confirmation fields", () => {
    const parsed = parseRepeatSchedulePayload({
      repeat_confirmation: true,
      repeat_reason: "Panel unavailable",
      repeat_override_acknowledged: true
    });

    assert.equal(parsed.repeatConfirmation, true);
    assert.equal(parsed.repeatReason, "Panel unavailable");
    assert.equal(parsed.repeatOverrideAcknowledged, true);
  });
});
