const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const taskService = require("../services/taskService");

describe("actionable task inbox queries", () => {
  it("listInbox excludes completed and cancelled tasks", async () => {
    let sql = "";

    const pool = {
      query: async (statement) => {
        sql = statement;
        return { rows: [] };
      }
    };

    await taskService.listInbox(pool);

    assert.match(sql, /status NOT IN \('Completed', 'Cancelled'\)/);
  });

  it("listMyTasks excludes completed and cancelled tasks", async () => {
    let sql = "";

    const pool = {
      query: async (statement) => {
        sql = statement;
        return { rows: [] };
      }
    };

    await taskService.listMyTasks(pool, {
      user: { name: "Recruiter User", role_name: "Recruiter", employee_code: "REC-1" }
    });

    assert.match(sql, /status NOT IN \('Completed', 'Cancelled'\)/);
  });
});
