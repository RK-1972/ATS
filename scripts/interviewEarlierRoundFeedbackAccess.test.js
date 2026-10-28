const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

describe("earlier-round non-HR feedback read access", () => {

  it("allows L2 panel interviewer to read L1 feedback on the same mapping", async () => {
    const interviewService = require("../services/interviewService");

    const pool = {
      query: async (sql, params) => {
        const text = String(sql);

        if (text.includes("FROM interview_panel_mstr")) {
          return { rows: [{ panel_id: 55 }] };
        }

        if (text.includes("SELECT round_type") && text.includes("FROM im_interviews")) {
          return { rows: [{ round_type: "L1 Technical" }] };
        }

        if (text.includes("schedule_id::text")) {
          return {
            rows: [
              {
                interview_id: "INT-L1",
                schedule_id: 101,
                map_id: "MAP-1"
              }
            ]
          };
        }

        if (text.includes("im_panel_assignments") && text.includes("interview_id = $1")) {
          return { rows: [] };
        }

        if (text.includes("i.map_id = $1") && text.includes("im_panel_assignments")) {
          assert.equal(params[0], "MAP-1");
          assert.deepEqual(params[1], [55]);
          return { rows: [{ "?column?": 1 }] };
        }

        if (text.includes("showOfferWorkspace") || text.includes("work_assignment")) {
          return { rows: [] };
        }

        return { rows: [] };
      }
    };

    await assert.doesNotReject(() =>
      interviewService.assertInterviewFeedbackReadAccess(pool, {
        user: {
          employee_code: "EMP-L2",
          role_name: "Interviewer"
        }
      }, { scheduleId: 101 })
    );
  });

  it("denies unrelated mapping feedback even with a panel profile", async () => {
    const interviewService = require("../services/interviewService");

    const pool = {
      query: async (sql) => {
        const text = String(sql);

        if (text.includes("FROM interview_panel_mstr")) {
          return { rows: [{ panel_id: 55 }] };
        }

        if (text.includes("SELECT round_type") && text.includes("FROM im_interviews")) {
          return { rows: [{ round_type: "L1 Technical" }] };
        }

        if (text.includes("schedule_id::text")) {
          return {
            rows: [
              {
                interview_id: "INT-FOREIGN",
                schedule_id: 999,
                map_id: "MAP-OTHER"
              }
            ]
          };
        }

        if (text.includes("im_panel_assignments") && text.includes("interview_id = $1")) {
          return { rows: [] };
        }

        if (text.includes("i.map_id = $1")) {
          return { rows: [] };
        }

        if (text.includes("showOfferWorkspace") || text.includes("work_assignment")) {
          return { rows: [] };
        }

        return { rows: [] };
      }
    };

    await assert.rejects(
      () =>
        interviewService.assertInterviewFeedbackReadAccess(pool, {
          user: {
            employee_code: "EMP-L2",
            role_name: "Interviewer"
          }
        }, { scheduleId: 999 }),
      (error) => error.status === 403
    );
  });

  it("still denies HR feedback to non-HR interviewers on the same mapping", async () => {
    const interviewService = require("../services/interviewService");

    const pool = {
      query: async (sql, params) => {
        const text = String(sql);

        if (text.includes("FROM interview_panel_mstr")) {
          return { rows: [{ panel_id: 55 }] };
        }

        if (text.includes("SELECT round_type") && text.includes("FROM im_interviews")) {
          return { rows: [{ round_type: "HR Round" }] };
        }

        if (text.includes("schedule_id::text")) {
          return {
            rows: [
              {
                interview_id: "INT-HR",
                schedule_id: 202,
                map_id: "MAP-1"
              }
            ]
          };
        }

        if (text.includes("im_panel_assignments") && text.includes("interview_id = $1")) {
          return { rows: [] };
        }

        if (text.includes("i.map_id = $1") && text.includes("im_panel_assignments")) {
          return { rows: [{ "?column?": 1 }] };
        }

        if (text.includes("showOfferWorkspace") || text.includes("work_assignment")) {
          return { rows: [] };
        }

        return { rows: [] };
      }
    };

    await assert.rejects(
      () =>
        interviewService.assertInterviewFeedbackReadAccess(pool, {
          user: {
            employee_code: "EMP-L2",
            role_name: "Interviewer"
          }
        }, { scheduleId: 202 }),
      (error) => {
        assert.equal(error.status, 403);
        assert.match(error.message, /not authorized to access feedback/i);
        return true;
      }
    );
  });

  it("does not broaden write access via assertInterviewFeedbackAccess", async () => {
    const interviewService = require("../services/interviewService");

    const pool = {
      query: async (sql) => {
        const text = String(sql);

        if (text.includes("FROM interview_panel_mstr")) {
          return { rows: [{ panel_id: 55 }] };
        }

        if (text.includes("SELECT round_type") && text.includes("FROM im_interviews")) {
          return { rows: [{ round_type: "L1 Technical" }] };
        }

        if (text.includes("schedule_id::text")) {
          return {
            rows: [
              {
                interview_id: "INT-L1",
                schedule_id: 101,
                map_id: "MAP-1"
              }
            ]
          };
        }

        if (text.includes("im_panel_assignments") && text.includes("interview_id = $1")) {
          return { rows: [] };
        }

        if (text.includes("schedule_id = $1 AND interviewer_id")) {
          return { rows: [] };
        }

        if (text.includes("i.map_id = $1")) {
          return { rows: [{ "?column?": 1 }] };
        }

        return { rows: [] };
      }
    };

    await assert.rejects(
      () =>
        interviewService.assertInterviewFeedbackAccess(pool, {
          user: {
            employee_code: "EMP-L2",
            role_name: "Interviewer"
          }
        }, { scheduleId: 101 }),
      (error) => error.status === 403
    );
  });
});
