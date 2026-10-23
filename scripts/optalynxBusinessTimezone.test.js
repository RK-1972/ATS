const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  OPTALYNX_BUSINESS_TIMEZONE,
  getBusinessCalendarDateKey,
  getInterviewBusinessCalendarDateKey,
  instantToBusinessCalendarDateKey
} = require("../utils/optalynxBusinessTimezone");

describe("optalynxBusinessTimezone", () => {
  it("uses Asia/Kolkata as the business timezone constant", () => {
    assert.equal(OPTALYNX_BUSINESS_TIMEZONE, "Asia/Kolkata");
  });

  it("maps instants to IST calendar dates", () => {
    const justAfterMidnightIst = new Date("2026-10-23T18:45:00.000Z");
    assert.equal(instantToBusinessCalendarDateKey(justAfterMidnightIst), "2026-10-24");
  });

  it("maps reference instants to IST today", () => {
    const istMorning = new Date("2026-10-23T04:00:00.000Z");
    assert.equal(getBusinessCalendarDateKey(istMorning), "2026-10-23");
  });

  it("resolves interview rows from UTC timestamps across IST midnight", () => {
    const row = {
      interview_date: "2026-10-23T18:45:00.000Z",
      interview_status: "Scheduled",
      feedback_submitted: false
    };

    assert.equal(getInterviewBusinessCalendarDateKey(row), "2026-10-24");
  });

  it("resolves DD-MM-YYYY interview dates as IST calendar days", () => {
    const row = {
      interview_date: "24-10-2026",
      interview_time: "00:15",
      interview_status: "Scheduled",
      feedback_submitted: false
    };

    assert.equal(getInterviewBusinessCalendarDateKey(row), "2026-10-24");
  });

  it("returns empty keys for missing or invalid interview dates", () => {
    assert.equal(getInterviewBusinessCalendarDateKey({}), "");
    assert.equal(
      getInterviewBusinessCalendarDateKey({ interview_date: "not-a-date" }),
      ""
    );
  });

  it("uses date-only values without shifting calendar day in IST", () => {
    const row = {
      interview_date: "2026-10-23",
      interview_status: "Scheduled",
      feedback_submitted: false
    };

    assert.equal(getInterviewBusinessCalendarDateKey(row), "2026-10-23");
  });
});
