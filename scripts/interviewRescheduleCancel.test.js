const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  INTERVIEW_STATUS,
  assertInterviewMutableState,
  assertFutureInterviewSlot,
  buildInterviewBundleSummary
} = require("../services/interviewService");

function baseInterview(overrides = {}) {
  return {
    interviewId: "INT-1",
    interviewStatus: INTERVIEW_STATUS.SCHEDULED,
    feedbackSubmitted: false,
    ...overrides
  };
}

describe("interview reschedule/cancel eligibility rules", () => {
  it("allows scheduled interviews without feedback", () => {
    assert.doesNotThrow(() => assertInterviewMutableState(baseInterview()));
  });

  it("rejects completed interviews", () => {
    assert.throws(
      () =>
        assertInterviewMutableState(
          baseInterview({ interviewStatus: INTERVIEW_STATUS.COMPLETED })
        ),
      /Completed interviews cannot be rescheduled or cancelled/
    );
  });

  it("rejects cancelled interviews", () => {
    assert.throws(
      () =>
        assertInterviewMutableState(
          baseInterview({ interviewStatus: INTERVIEW_STATUS.CANCELLED })
        ),
      /already cancelled/
    );
  });

  it("rejects feedback-submitted interviews", () => {
    assert.throws(
      () => assertInterviewMutableState(baseInterview({ feedbackSubmitted: true })),
      /feedback has been submitted/
    );
  });
});

describe("interview bundle pending feedback summary", () => {
  it("excludes cancelled interviews from pendingFeedback", () => {
    const summary = buildInterviewBundleSummary([
      {
        interview_status: INTERVIEW_STATUS.SCHEDULED,
        feedback_submitted: false
      },
      {
        interview_status: INTERVIEW_STATUS.CANCELLED,
        feedback_submitted: false
      },
      {
        interview_status: INTERVIEW_STATUS.SCHEDULED,
        feedback_submitted: true
      }
    ]);

    assert.equal(summary.pendingFeedback, 1);
  });

  it("still counts scheduled interviews awaiting feedback", () => {
    const summary = buildInterviewBundleSummary([
      {
        interview_status: INTERVIEW_STATUS.SCHEDULED,
        feedback_submitted: false
      }
    ]);

    assert.equal(summary.pendingFeedback, 1);
  });
});

describe("interview future slot validation", () => {
  it("rejects missing date or time", () => {
    assert.throws(() => assertFutureInterviewSlot("", "10:00"), /required/);
  });

  it("rejects past dates", () => {
    assert.throws(
      () => assertFutureInterviewSlot("2000-01-01", "10:00"),
      /cannot be in the past/
    );
  });

  it("accepts a future date", () => {
    const future = new Date();
    future.setDate(future.getDate() + 7);
    const iso = future.toISOString().slice(0, 10);
    assert.doesNotThrow(() => assertFutureInterviewSlot(iso, "23:59"));
  });
});
