const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  filterInterviewsToday,
  filterInterviewsUpcoming
} = require("../services/copilotInterviewFilters");
const { getBusinessCalendarDateKey } = require("../utils/optalynxBusinessTimezone");
const {
  applyInterviewerViewFilter
} = require("./lib/copilotInterviewerViewFilterContract");

describe("copilot interviewer filter parity (backend vs frontend contract)", () => {
  const midnightIstRow = {
    interview_date: "2026-10-23T18:45:00.000Z",
    interview_time: "00:15",
    interview_status: "Scheduled",
    feedback_submitted: false
  };

  const referenceOnIstOct24 = new Date("2026-10-23T20:00:00.000Z");
  const referenceBeforeIstMidnight = new Date("2026-10-23T18:29:00.000Z");

  it("agrees on today filter across IST midnight (UTC previous calendar day)", () => {
    const rows = [midnightIstRow];

    const backendToday = filterInterviewsToday(rows, referenceOnIstOct24);
    const contractToday = applyInterviewerViewFilter(rows, "today", referenceOnIstOct24);

    assert.deepEqual(
      backendToday.map((row) => row.interview_date),
      contractToday.map((row) => row.interview_date)
    );
    assert.equal(backendToday.length, 1);
  });

  it("excludes post-midnight IST interview before IST calendar day rolls", () => {
    const rows = [midnightIstRow];

    const backendToday = filterInterviewsToday(rows, referenceBeforeIstMidnight);
    const contractToday = applyInterviewerViewFilter(
      rows,
      "today",
      referenceBeforeIstMidnight
    );

    assert.equal(backendToday.length, 0);
    assert.equal(contractToday.length, 0);
  });

  it("agrees on upcoming filter with IST today boundary", () => {
    const rows = [
      midnightIstRow,
      {
        interview_date: "2026-10-20",
        interview_status: "Scheduled",
        feedback_submitted: false
      }
    ];

    const backendUpcoming = filterInterviewsUpcoming(rows, referenceOnIstOct24);
    const contractUpcoming = applyInterviewerViewFilter(
      rows,
      "upcoming",
      referenceOnIstOct24
    );

    assert.deepEqual(
      backendUpcoming.map((row) => row.interview_date),
      contractUpcoming.map((row) => row.interview_date)
    );

    const today = getBusinessCalendarDateKey(referenceOnIstOct24);
    assert.equal(today, "2026-10-24");
  });
});
