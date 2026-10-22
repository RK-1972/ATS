const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("fs");
const path = require("path");

describe("workflow getCurrentTasks actionable filter", () => {
  it("excludes cancelled workflow tasks from current task listing", () => {
    const source = readFileSync(
      path.join(__dirname, "..", "services", "workflowService.js"),
      "utf8"
    );

    assert.match(
      source,
      /FROM wf_tasks WHERE instance_id = \$1 AND status NOT IN \('Completed', 'Cancelled'\)/
    );
  });
});
