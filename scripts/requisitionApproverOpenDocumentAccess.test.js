const assert = require("node:assert/strict");
const { describe, it, mock, afterEach } = require("node:test");

const workforcePlanningService = require("../services/workforcePlanningService");
const recruitmentService = require("../services/recruitmentService");
const requisitionCapabilityAuth = require("../services/requisitionCapabilityAuth");

function createPoolWithActiveTask(assigneeCode) {
  return {
    query: async (sql) => {
      const text = String(sql);

      if (text.includes("FROM wf_tasks t") && text.includes("wf_assignments")) {
        return {
          rows: [
            {
              task_id: 42,
              instance_id: "WF-RM-REQ-100",
              assignee: assigneeCode,
              assignment_assignee: assigneeCode,
              active: true
            }
          ]
        };
      }

      if (text.includes("FROM user_mstr")) {
        return {
          rows: [
            {
              full_name: "Requestor User",
              employee_code: "EMP-OWN",
              email_id: "req@example.com"
            }
          ]
        };
      }

      return { rows: [] };
    }
  };
}

describe("getRequisitionInspectorDetail approver read access", () => {
  afterEach(() => {
    mock.restoreAll();
    delete require.cache[require.resolve("../services/workforcePlanningService")];
    delete require.cache[require.resolve("../services/recruitmentService")];
    delete require.cache[require.resolve("../services/requisitionCapabilityAuth")];
  });

  it("allows assigned approver via approval participant access", async () => {
    let capturedAssignee = null;

    mock.method(recruitmentService, "loadRequisitionByCode", async () => ({
      requisition_code: "REQ-100",
      created_by: "EMP-OWN",
      req_status: "Pending Level-1 Approval",
      workflow_instance_id: "WF-RM-REQ-100",
      created_on: new Date().toISOString()
    }));

    mock.method(
      requisitionCapabilityAuth,
      "assertRequisitionApprovalParticipantAccess",
      async (_pool, _req, _row, options) => {
        capturedAssignee = options?.assigneeEmployeeCode || null;
      }
    );

    mock.method(
      requisitionCapabilityAuth,
      "resolveRequisitionRequestorCreatedByKeys",
      async () => ["EMP-OWN"]
    );

    delete require.cache[require.resolve("../services/workforcePlanningService")];
    const freshService = require("../services/workforcePlanningService");

    const result = await freshService.getRequisitionInspectorDetail(
      createPoolWithActiveTask("EMP-APP"),
      "REQ-100",
      { user: { employee_code: "EMP-APP", role_name: "Recruiter" } }
    );

    assert.equal(capturedAssignee, "EMP-APP");
    assert.equal(result.requisition.requisition_code, "REQ-100");
  });

  it("denies unrelated users when participant access fails", async () => {
    mock.method(recruitmentService, "loadRequisitionByCode", async () => ({
      requisition_code: "REQ-200",
      created_by: "EMP-OWN",
      req_status: "Pending Level-1 Approval",
      workflow_instance_id: "WF-RM-REQ-200",
      created_on: new Date().toISOString()
    }));

    mock.method(
      requisitionCapabilityAuth,
      "assertRequisitionApprovalParticipantAccess",
      async () => {
        const error = new Error(
          "Enterprise Access Denied. You are not authorized to view this requisition."
        );
        error.status = 403;
        throw error;
      }
    );

    delete require.cache[require.resolve("../services/recruitmentService")];
    delete require.cache[require.resolve("../services/workforcePlanningService")];
    const freshRecruitmentService = require("../services/recruitmentService");
    mock.method(freshRecruitmentService, "loadRequisitionByCode", async () => ({
      requisition_code: "REQ-200",
      created_by: "EMP-OWN",
      req_status: "Pending Level-1 Approval",
      workflow_instance_id: "WF-RM-REQ-200",
      created_on: new Date().toISOString()
    }));

    const freshService = require("../services/workforcePlanningService");

    await assert.rejects(
      () =>
        freshService.getRequisitionInspectorDetail(
          createPoolWithActiveTask("EMP-APP"),
          "REQ-200",
          { user: { employee_code: "EMP-OTHER", role_name: "Recruiter" } }
        ),
      (error) => error.status === 403
    );
  });
});

describe("assertRequisitionApprovalParticipantAccess", () => {
  it("allows active assignee without requestor ownership", async () => {
    await assert.doesNotReject(() =>
      requisitionCapabilityAuth.assertRequisitionApprovalParticipantAccess(
        {},
        { user: { employee_code: "EMP-APP", role_name: "Recruiter" } },
        { created_by: "EMP-OWN" },
        { assigneeEmployeeCode: "EMP-APP" }
      )
    );
  });

  it("does not grant interviewers requisition creation via requireRequisitionRequestor", async () => {
    const pool = { query: async () => ({ rows: [] }) };

    await assert.rejects(
      () =>
        requisitionCapabilityAuth.assertCanCreateRequisition(pool, {
          user: { employee_code: "EMP-INT", role_name: "Interviewer" }
        }),
      (error) => error.status === 403
    );
  });
});
