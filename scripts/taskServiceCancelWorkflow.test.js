const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

const taskServicePath = require.resolve("../services/taskService");
const workflowServicePath = require.resolve("../services/workflowService");
const enterpriseAuditPath = require.resolve("../services/enterpriseAuditService");

describe("taskService.cancelTask workflow mirror", () => {
  let queries = [];
  let originalWorkflow;
  let originalAudit;

  before(() => {
    originalWorkflow = require.cache[workflowServicePath];
    originalAudit = require.cache[enterpriseAuditPath];

    require.cache[workflowServicePath] = {
      id: workflowServicePath,
      filename: workflowServicePath,
      loaded: true,
      exports: {
        TASK_STATUS: { CANCELLED: "Cancelled" },
        completeTask: async () => {}
      }
    };

    require.cache[enterpriseAuditPath] = {
      id: enterpriseAuditPath,
      filename: enterpriseAuditPath,
      loaded: true,
      exports: {
        userContext: () => ({ name: "Tester", role: "Admin" }),
        writeEnterpriseAudit: async () => {}
      }
    };

    delete require.cache[taskServicePath];
  });

  after(() => {
    delete require.cache[taskServicePath];
    if (originalWorkflow) {
      require.cache[workflowServicePath] = originalWorkflow;
    } else {
      delete require.cache[workflowServicePath];
    }
    if (originalAudit) {
      require.cache[enterpriseAuditPath] = originalAudit;
    } else {
      delete require.cache[enterpriseAuditPath];
    }
  });

  it("cancels linked wf_tasks and deactivates wf_assignments", async () => {
    queries = [];

    const pool = {
      query: async (sql, params) => {
        queries.push({ sql, params });

        if (sql.includes("FROM et_tasks WHERE task_id")) {
          return {
            rows: [
              {
                task_id: 10,
                module: "Interview Management",
                task_type: "Conduct Interview",
                title: "Conduct L1",
                status: "Pending",
                workflow_task_id: 99,
                business_object_type: "Interview",
                business_object_id: "INT-1",
                metadata: {}
              }
            ]
          };
        }

        if (sql.includes("FROM wf_tasks WHERE task_id")) {
          return { rows: [{ status: "Pending" }] };
        }

        if (sql.includes("UPDATE et_tasks")) {
          return { rows: [] };
        }

        if (sql.includes("UPDATE wf_tasks")) {
          return { rows: [] };
        }

        if (sql.includes("UPDATE wf_assignments")) {
          return { rows: [] };
        }

        if (sql.includes("INSERT INTO et_task_history")) {
          return { rows: [] };
        }

        return { rows: [] };
      }
    };

    const taskService = require("../services/taskService");
    await taskService.cancelTask(pool, 10, { user: { role_name: "Admin" } }, "Interview cancelled");

    const wfUpdate = queries.find((entry) => entry.sql.includes("UPDATE wf_tasks"));
    const assignmentUpdate = queries.find((entry) => entry.sql.includes("UPDATE wf_assignments"));

    assert.ok(wfUpdate, "expected wf_tasks cancellation update");
    assert.equal(wfUpdate.params[0], "Cancelled");
    assert.equal(wfUpdate.params[1], 99);
    assert.ok(assignmentUpdate, "expected wf_assignments deactivation");
    assert.equal(assignmentUpdate.params[0], 99);
  });
});
