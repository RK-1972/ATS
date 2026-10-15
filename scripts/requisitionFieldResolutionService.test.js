const assert = require("node:assert/strict");
const { describe, it, beforeEach, mock } = require("node:test");

const approvalRouteResolverService = require("../services/approvalRouteResolverService");
const approvalRouteRepository = require("../repositories/approvalRouteRepository");
const resolutionService = require("../services/requisitionFieldResolutionService");

function createMockQueryable(handlers = {}) {
  return {
    query: async (sql, params) => {
      const text = String(sql);
      if (handlers.onQuery) {
        return handlers.onQuery(text, params);
      }
      throw new Error(`Unexpected query: ${text.slice(0, 80)}`);
    }
  };
}

describe("requisitionFieldResolutionService", () => {
  /** @type {import('node:test').Mock<typeof approvalRouteResolverService.resolveApprovalRoute>} */
  let resolveRouteMock;
  /** @type {import('node:test').Mock<typeof approvalRouteRepository.getApprovalRoute>} */
  let getRouteMock;

  beforeEach(() => {
    resolveRouteMock = mock.method(
      approvalRouteResolverService,
      "resolveApprovalRoute",
      async () => 42
    );
    getRouteMock = mock.method(approvalRouteRepository, "getApprovalRoute", async () => ({
      route_id: 42,
      route_name: "Requisition Standard"
    }));
  });

  it("auto-selects the only eligible approved position when none is requested", async () => {
    const queryable = createMockQueryable({
      onQuery: (sql) => {
        if (sql.includes("FROM wp_approved_positions p") && sql.includes("NOT EXISTS")) {
          return {
            rows: [
              {
                position_id: "AP-ONLY",
                position_title: "Engineer",
                department: "Eng",
                grade: "G5",
                budget_approved: 800000
              }
            ]
          };
        }
        if (sql.includes("WHERE position_id = $1")) {
          return {
            rows: [
              {
                position_id: "AP-ONLY",
                position_title: "Engineer",
                department: "Eng",
                grade: "G5",
                budget_approved: 800000,
                status: "Active"
              }
            ]
          };
        }
        return { rows: [] };
      }
    });

    const id = await resolutionService.resolveApprovedPositionId(queryable, {});
    assert.equal(id, "AP-ONLY");
  });

  it("rejects auto-selection when multiple eligible positions exist", async () => {
    const queryable = createMockQueryable({
      onQuery: (sql) => {
        if (sql.includes("NOT EXISTS")) {
          return {
            rows: [
              { position_id: "AP-1" },
              { position_id: "AP-2" }
            ]
          };
        }
        return { rows: [] };
      }
    });

    await assert.rejects(
      () => resolutionService.resolveApprovedPositionId(queryable, {}),
      (error) => {
        assert.equal(error.status, 400);
        assert.match(error.message, /Multiple approved positions/);
        return true;
      }
    );
  });

  it("preserves a valid requested catalogue position linked to the same requisition", async () => {
    const queryable = createMockQueryable({
      onQuery: (sql, params) => {
        if (sql.includes("WHERE position_id = $1")) {
          return {
            rows: [
              {
                position_id: params[0],
                position_title: "Lead",
                department: "Eng",
                grade: "G6",
                status: "Active"
              }
            ]
          };
        }
        if (sql.includes("FROM rm_requisitions")) {
          return { rows: [{ requisition_code: "REQ-2026-0001" }] };
        }
        return { rows: [] };
      }
    });

    const id = await resolutionService.resolveApprovedPositionId(queryable, {
      requestedApprovedPositionId: "AP-CAT",
      existingRequisitionCode: "REQ-2026-0001"
    });
    assert.equal(id, "AP-CAT");
  });

  it("blocks duplicate requisition creation for a consumed position", async () => {
    const queryable = createMockQueryable({
      onQuery: (sql, params) => {
        if (sql.includes("WHERE position_id = $1")) {
          return {
            rows: [
              {
                position_id: params[0],
                status: "Active"
              }
            ]
          };
        }
        if (sql.includes("FROM rm_requisitions")) {
          return { rows: [{ requisition_code: "REQ-OTHER" }] };
        }
        return { rows: [] };
      }
    });

    await assert.rejects(
      () =>
        resolutionService.resolveApprovedPositionId(queryable, {
          requestedApprovedPositionId: "AP-TAKEN"
        }),
      (error) => {
        assert.equal(error.status, 409);
        return true;
      }
    );
  });

  it("resolves approval route via policy resolver using position criteria", async () => {
    const queryable = createMockQueryable({
      onQuery: (sql, params) => {
        if (sql.includes("WHERE position_id = $1")) {
          return {
            rows: [
              {
                position_id: "AP-1",
                position_title: "Architect",
                department: "Delivery",
                grade: "G7",
                budget_approved: 1200000
              }
            ]
          };
        }
        return { rows: [] };
      }
    });

    const routeId = await resolutionService.resolveRequisitionApprovalRouteId(
      queryable,
      "AP-1"
    );

    assert.equal(routeId, 42);
    assert.equal(resolveRouteMock.mock.calls.length, 1);
    assert.equal(resolveRouteMock.mock.calls[0].arguments[1], "REQUISITION");
    assert.deepEqual(resolveRouteMock.mock.calls[0].arguments[2], {
      department: "Delivery",
      designation: "Architect",
      grade: "G7",
      amount: 1200000
    });
  });

  it("fails route resolution when policy resolver reports ambiguity", async () => {
    resolveRouteMock.mock.mockImplementation(async () => {
      const error = new Error("Multiple active Approval Routes match");
      error.status = 400;
      throw error;
    });

    const queryable = createMockQueryable({
      onQuery: () => ({
        rows: [
          {
            position_id: "AP-1",
            position_title: "Role",
            department: "D",
            grade: "G1",
            budget_approved: 1
          }
        ]
      })
    });

    await assert.rejects(
      () => resolutionService.resolveRequisitionApprovalRouteId(queryable, "AP-1"),
      (error) => {
        assert.equal(error.status, 400);
        assert.match(error.message, /Multiple active Approval Routes/);
        return true;
      }
    );
  });

  it("rejects auto-selection when zero eligible positions exist", async () => {
    const queryable = createMockQueryable({
      onQuery: (sql) => {
        if (sql.includes("NOT EXISTS")) {
          return { rows: [] };
        }
        return { rows: [] };
      }
    });

    await assert.rejects(
      () => resolutionService.resolveApprovedPositionId(queryable, {}),
      (error) => {
        assert.equal(error.status, 400);
        assert.match(error.message, /No approved position is available/);
        return true;
      }
    );
  });

  it("rejects a requested Fully Utilized approved position", async () => {
    const queryable = createMockQueryable({
      onQuery: (sql, params) => {
        if (sql.includes("WHERE position_id = $1")) {
          return {
            rows: [
              {
                position_id: params[0],
                status: "Fully Utilized"
              }
            ]
          };
        }
        return { rows: [] };
      }
    });

    await assert.rejects(
      () =>
        resolutionService.resolveApprovedPositionId(queryable, {
          requestedApprovedPositionId: "AP-FU"
        }),
      (error) => {
        assert.equal(error.status, 400);
        assert.match(error.message, /fully utilized/i);
        return true;
      }
    );
  });

  it("returns 404 for a nonexistent requested approved position", async () => {
    const queryable = createMockQueryable({
      onQuery: () => ({ rows: [] })
    });

    await assert.rejects(
      () =>
        resolutionService.resolveApprovedPositionId(queryable, {
          requestedApprovedPositionId: "AP-MISSING"
        }),
      (error) => {
        assert.equal(error.status, 404);
        return true;
      }
    );
  });

  it("preview locks position from requisition_code and resolves route", async () => {
    const queryable = createMockQueryable({
      onQuery: (sql, params) => {
        if (sql.includes("WHERE requisition_code = $1")) {
          return { rows: [{ approved_position_id: "AP-LINKED" }] };
        }
        if (
          sql.includes("WHERE approved_position_id = $1") &&
          sql.includes("SELECT requisition_code")
        ) {
          return { rows: [{ requisition_code: "REQ-2026-0099" }] };
        }
        if (sql.includes("NOT EXISTS")) {
          return { rows: [] };
        }
        if (sql.includes("WHERE position_id = $1") && params[0] === "AP-LINKED") {
          return {
            rows: [
              {
                position_id: "AP-LINKED",
                position_title: "Linked Role",
                department: "Eng",
                grade: "G4",
                budget_approved: 900000,
                status: "Active"
              }
            ]
          };
        }
        return { rows: [] };
      }
    });

    const preview =
      await resolutionService.buildTalentDemandFieldResolutionPreview(queryable, {
        requisition_code: "REQ-2026-0099"
      });

    assert.equal(preview.approved_position_id, "AP-LINKED");
    assert.equal(preview.position_locked, true);
    assert.equal(preview.approval_route_id, 42);
    assert.equal(resolveRouteMock.mock.calls.length, 1);
  });

  it("fails route resolution when zero policies match", async () => {
    resolveRouteMock.mock.mockImplementation(async () => {
      const error = new Error(
        'No active Approval Route matches documentType "REQUISITION", Department (any), Designation (any), Grade (any), Amount (any).'
      );
      error.status = 400;
      throw error;
    });

    const queryable = createMockQueryable({
      onQuery: () => ({
        rows: [
          {
            position_id: "AP-1",
            position_title: "Role",
            department: "D",
            grade: "G1",
            budget_approved: 1
          }
        ]
      })
    });

    await assert.rejects(
      () => resolutionService.resolveRequisitionApprovalRouteId(queryable, "AP-1"),
      (error) => {
        assert.equal(error.status, 400);
        assert.match(error.message, /No active Approval Route matches/);
        return true;
      }
    );
  });

  it("preserves stored approval_route_id on existing requisition submit helper", async () => {
    const queryable = createMockQueryable({
      onQuery: () => {
        throw new Error("resolver should not query when route is stored");
      }
    });

    const routeId =
      await resolutionService.resolveApprovalRouteIdForRequisitionSubmit(
        queryable,
        {
          requisition_code: "REQ-2026-0001",
          approved_position_id: "AP-CAT",
          approval_route_id: 77
        }
      );

    assert.equal(routeId, 77);
    assert.equal(resolveRouteMock.mock.calls.length, 0);
  });

  it("resolves approval route when requisition has no stored route", async () => {
    const queryable = createMockQueryable({
      onQuery: (sql, params) => {
        if (sql.includes("WHERE position_id = $1")) {
          return {
            rows: [
              {
                position_id: params[0],
                position_title: "Dev",
                department: "IT",
                grade: "G2",
                budget_approved: 600000
              }
            ]
          };
        }
        return { rows: [] };
      }
    });

    const routeId =
      await resolutionService.resolveApprovalRouteIdForRequisitionSubmit(
        queryable,
        {
          requisition_code: "REQ-2026-0002",
          approved_position_id: "AP-NEW",
          approval_route_id: null
        }
      );

    assert.equal(routeId, 42);
    assert.equal(resolveRouteMock.mock.calls.length, 1);
  });

  it("buildRouteCriteriaFromPosition maps budget to policy amount", () => {
    const criteria = resolutionService.buildRouteCriteriaFromPosition({
      department: "Fin",
      position_title: "Analyst",
      grade: "G3",
      budget_approved: "500000.00"
    });
    assert.deepEqual(criteria, {
      department: "Fin",
      designation: "Analyst",
      grade: "G3",
      amount: 500000
    });
  });
});

describe("workflowService approval route expansion idempotency", () => {
  it("does not duplicate approval tasks when expansion runs twice on same instance", async () => {
    const workflowService = require("../services/workflowService");
    let stepsLoaded = 0;

    const stepsMock = mock.method(
      approvalRouteRepository,
      "getApprovalRouteSteps",
      async () => {
        stepsLoaded += 1;
        return [
          {
            step_id: 1,
            sequence_no: 1,
            approver_employee_code: "EMP-1",
            approval_type: "Approval Required"
          }
        ];
      }
    );

    const queryable = {
      query: async (sql) => {
        const text = String(sql);
        if (text.includes("Approval Step %")) {
          return {
            rows: [
              {
                task_id: "task-existing",
                task_status: "Pending",
                title: "Approval Step 1",
                assignee: "EMP-1",
                assignee_role: null,
                assignment_active: true
              }
            ]
          };
        }
        if (text.includes("INSERT INTO wf_tasks")) {
          throw new Error("should not insert when tasks already exist");
        }
        return { rows: [] };
      }
    };

    const second =
      await workflowService.createApprovalRouteWorkflowTasks(
        queryable,
        "WF-RM-REQ-1",
        99,
        { requisitionCode: "REQ-1" }
      );

    assert.equal(second.length, 1);
    assert.equal(second[0].reused, true);
    assert.equal(stepsLoaded, 0);
    stepsMock.mock.restore();
  });
});
