const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  filterInterviewsToday,
  filterInterviewsPendingFeedback,
  filterInterviewsUpcoming
} = require("../services/copilotInterviewFilters");
const { getBusinessCalendarDateKey } = require("../utils/optalynxBusinessTimezone");

describe("copilotInterviewFilters", () => {
  const referenceDate = new Date("2026-10-23T04:00:00.000Z");

  const rows = [
    {
      interview_date: "2026-10-23",
      interview_status: "Scheduled",
      feedback_submitted: false
    },
    {
      interview_date: "2026-10-24",
      interview_status: "Scheduled",
      feedback_submitted: false
    },
    {
      interview_date: "2026-10-23",
      interview_status: "Cancelled",
      feedback_submitted: false
    },
    {
      interview_date: "2026-10-22",
      interview_status: "Scheduled",
      feedback_submitted: true
    },
    {
      interview_date: "2026-10-22",
      interview_status: "Completed",
      feedback_submitted: false
    }
  ];

  it("filters today actionable interviews for the panel scope (IST)", () => {
    assert.equal(getBusinessCalendarDateKey(referenceDate), "2026-10-23");
    const today = filterInterviewsToday(rows, referenceDate);
    assert.equal(today.length, 1);
    assert.equal(today[0].interview_date, "2026-10-23");
  });

  it("pending feedback excludes completed feedback and cancelled rows", () => {
    const pending = filterInterviewsPendingFeedback(rows);
    assert.equal(pending.length, 2);
  });

  it("upcoming excludes cancelled and completed interviews (IST)", () => {
    const upcoming = filterInterviewsUpcoming(rows, referenceDate);
    assert.equal(upcoming.length, 2);
    assert.ok(upcoming.every((row) => row.interview_status !== "Cancelled"));
  });

  it("counts UTC timestamps after IST midnight as the new IST day", () => {
    const referenceOnIstOct24 = new Date("2026-10-23T20:00:00.000Z");
    const midnightIstRow = {
      interview_date: "2026-10-23T18:45:00.000Z",
      interview_time: "00:15",
      interview_status: "Scheduled",
      feedback_submitted: false
    };

    const today = filterInterviewsToday([midnightIstRow], referenceOnIstOct24);
    assert.equal(today.length, 1);
  });

  it("excludes post-midnight IST interviews before the IST calendar rolls", () => {
    const referenceBeforeIstMidnight = new Date("2026-10-23T18:29:00.000Z");
    const midnightIstRow = {
      interview_date: "2026-10-23T18:45:00.000Z",
      interview_time: "00:15",
      interview_status: "Scheduled",
      feedback_submitted: false
    };

    const today = filterInterviewsToday(
      [midnightIstRow],
      referenceBeforeIstMidnight
    );
    assert.equal(today.length, 0);
  });
});
