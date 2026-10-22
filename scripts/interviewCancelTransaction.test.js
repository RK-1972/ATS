const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

const interviewServicePath = require.resolve("../services/interviewService");
const taskServicePath = require.resolve("../services/taskService");
const recruitmentServicePath = require.resolve("../services/recruitmentService");

describe("cancelInterview database transaction", () => {
  let originalInterviewService;
  let originalTaskService;
  let originalRecruitmentService;
  let clientQueries;
  let rolledBack;
  let committed;

  before(() => {
    originalInterviewService = require.cache[interviewServicePath];
    originalTaskService = require.cache[taskServicePath];
    originalRecruitmentService = require.cache[recruitmentServicePath];

    require.cache[recruitmentServicePath] = {
      id: recruitmentServicePath,
      filename: recruitmentServicePath,
      loaded: true,
      exports: {
        assertAuthorizedMappingAccess: async () => ({})
      }
    };

    require.cache[taskServicePath] = {
      id: taskServicePath,
      filename: taskServicePath,
      loaded: true,
      exports: {
        cancelTask: async () => {
          throw new Error("Simulated task cancellation failure");
        }
      }
    };

    delete require.cache[interviewServicePath];
  });

  after(() => {
    delete require.cache[interviewServicePath];

    if (originalTaskService) {
      require.cache[taskServicePath] = originalTaskService;
    } else {
      delete require.cache[taskServicePath];
    }

    if (originalRecruitmentService) {
      require.cache[recruitmentServicePath] = originalRecruitmentService;
    } else {
      delete require.cache[recruitmentServicePath];
    }

    if (originalInterviewService) {
      require.cache[interviewServicePath] = originalInterviewService;
    }
  });

  it("rolls back when a required cancellation step fails", async () => {
    clientQueries = [];
    rolledBack = false;
    committed = false;

    const client = {
      query: async (sql) => {
        clientQueries.push(sql);

        if (sql === "ROLLBACK") {
          rolledBack = true;
        }

        if (sql === "COMMIT") {
          committed = true;
        }

        if (sql.includes("FROM im_interviews WHERE")) {
          return {
            rows: [
              {
                interview_id: "INT-TEST-1",
                schedule_id: 42,
                map_id: 7,
                interview_status: "Scheduled",
                feedback_submitted: false,
                round_type: "L1 Technical"
              }
            ]
          };
        }

        if (sql.includes("information_schema.tables")) {
          return { rows: [{ exists: false }] };
        }

        if (sql.includes("FROM et_tasks")) {
          return {
            rows: [{ task_id: 5, task_type: "Conduct Interview", status: "Pending" }]
          };
        }

        return { rows: [] };
      },
      release: () => {}
    };

    const pool = {
      connect: async () => client,
      query: async (sql) => {
        if (sql.includes("FROM im_interviews WHERE")) {
          return {
            rows: [
              {
                interview_id: "INT-TEST-1",
                schedule_id: 42,
                map_id: 7,
                interview_status: "Scheduled",
                feedback_submitted: false,
                round_type: "L1 Technical"
              }
            ]
          };
        }

        if (sql.includes("pc_config_state")) {
          return { rows: [{ published_payload: { modules: [] } }] };
        }

        if (sql.includes("FROM et_tasks")) {
          return {
            rows: [{ task_id: 5, task_type: "Conduct Interview", status: "Pending" }]
          };
        }

        return { rows: [] };
      }
    };

    const interviewService = require("../services/interviewService");

    await assert.rejects(
      () =>
        interviewService.cancelInterview(
          pool,
          "INT-TEST-1",
          { cancellation_reason: "Candidate unavailable" },
          { user: { role_name: "Admin", name: "Admin User", employee_code: "ADM-1" } }
        ),
      /Simulated task cancellation failure/
    );

    assert.ok(clientQueries.includes("BEGIN"), "expected transaction BEGIN");
    assert.equal(committed, false, "COMMIT must not run after failure");
    assert.equal(rolledBack, true, "ROLLBACK must run after failure");
  });
});
