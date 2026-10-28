const assert = require("node:assert/strict");
const { describe, it, mock } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const recruitmentRoutesSource = fs.readFileSync(
  path.join(__dirname, "../routes/recruitmentRoutes.js"),
  "utf8"
);

const recruitmentService = require("../services/recruitmentService");
const talentDemandDraftService = require("../services/talentDemandDraftService");
const {
  assertCanCreateRequisition,
  requireRequisitionRequestor
} = require("../services/requisitionCapabilityAuth");
const workAssignmentService = require("../services/workAssignmentService");

function buildApprovedPositionCatalogueReaderMiddleware(pool) {
  const requestorMiddleware = requireRequisitionRequestor(pool);
  return async (req, res, next) => {
    if (String(req.user?.role_name || "").trim().toLowerCase() === "admin") {
      return next();
    }
    return requestorMiddleware(req, res, next);
  };
}

async function runMiddleware(middleware, req) {
  const res = {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
    }
  };

  let nextCalled = false;
  await middleware(req, res, () => {
    nextCalled = true;
  });

  return { nextCalled, res };
}

describe("approved position catalogue requestor authorization", () => {
  it("GET /api/v1/recruitment/approved-positions uses route-local catalogue guard", () => {
    assert.match(
      recruitmentRoutesSource,
      /app\.get\(\s*"\/api\/v1\/recruitment\/approved-positions",\s*approvedPositionCatalogueGuard/m
    );
    assert.doesNotMatch(
      recruitmentRoutesSource,
      /app\.get\(\s*"\/api\/v1\/recruitment\/approved-positions",\s*requestorGuard/m
    );
    assert.match(
      recruitmentRoutesSource,
      /approvedPositionCatalogueGuard[\s\S]*role_name[\s\S]*admin/i
    );
  });

  it("listApprovedPositions returns open active positions (read model unchanged)", async () => {
    const pool = {
      query: async (sql) => {
        const text = String(sql);
        if (text.includes("FROM wp_approved_positions")) {
          return {
            rows: [
              {
                position_id: "AP-1",
                position_title: "Engineer",
                department: "Eng",
                grade: "G2",
                headcount: 1,
                status: "Active",
                remaining_budget: 100,
                expiry_date: null
              }
            ]
          };
        }
        throw new Error(`unexpected query: ${text}`);
      }
    };

    const data = await recruitmentService.listApprovedPositions(pool);
    assert.equal(data.length, 1);
    assert.equal(data[0].position_id, "AP-1");
  });

  it("requestor with REQUISITION_REQUESTOR passes assertCanCreateRequisition", async () => {
    const restore = mock.method(
      workAssignmentService,
      "getEmployeeWorkAssignments",
      async () => [
        {
          assignment_code: "REQUISITION_REQUESTOR",
          is_active: true,
          master_is_active: true
        }
      ]
    );

    try {
      await assertCanCreateRequisition(
        { query: async () => ({ rows: [] }) },
        { user: { employee_code: "EMP-REQ", role_name: "Recruiter" } }
      );
    } finally {
      restore.mock.restore();
    }
  });

  it("non-requestor receives the standard enterprise authorization error", async () => {
    const restore = mock.method(
      workAssignmentService,
      "getEmployeeWorkAssignments",
      async () => []
    );

    try {
      await assert.rejects(
        () =>
          assertCanCreateRequisition(
            { query: async () => ({ rows: [] }) },
            { user: { employee_code: "EMP-VIEW", role_name: "Recruiter" } }
          ),
        (error) => {
          assert.equal(error.status, 403);
          assert.match(
            error.message,
            /not authorized to create a Requisition/i
          );
          return true;
        }
      );
    } finally {
      restore.mock.restore();
    }
  });

  it("catalogue reader allows Admin without REQUISITION_REQUESTOR assignment", async () => {
    const restore = mock.method(
      workAssignmentService,
      "getEmployeeWorkAssignments",
      async () => {
        throw new Error("Admin catalogue read must not require work assignments");
      }
    );

    const pool = { query: async () => ({ rows: [] }) };
    const middleware = buildApprovedPositionCatalogueReaderMiddleware(pool);

    try {
      const { nextCalled } = await runMiddleware(middleware, {
        user: { employee_code: "EMP-ADMIN", role_name: "Admin" }
      });
      assert.equal(nextCalled, true);
    } finally {
      restore.mock.restore();
    }
  });

  it("catalogue reader denies non-requestor non-Admin with 403 envelope", async () => {
    const restore = mock.method(
      workAssignmentService,
      "getEmployeeWorkAssignments",
      async () => []
    );

    const pool = { query: async () => ({ rows: [] }) };
    const middleware = buildApprovedPositionCatalogueReaderMiddleware(pool);

    try {
      const { nextCalled, res } = await runMiddleware(middleware, {
        user: { employee_code: "EMP-VIEW", role_name: "Recruiter" }
      });

      assert.equal(nextCalled, false);
      assert.equal(res.statusCode, 403);
      assert.equal(res.body.success, false);
      assert.match(
        res.body.message,
        /not authorized to create a Requisition/i
      );
    } finally {
      restore.mock.restore();
    }
  });

  it("catalogue reader allows assigned requestor", async () => {
    const restore = mock.method(
      workAssignmentService,
      "getEmployeeWorkAssignments",
      async () => [
        {
          assignment_code: "REQUISITION_REQUESTOR",
          is_active: true,
          master_is_active: true
        }
      ]
    );

    const pool = { query: async () => ({ rows: [] }) };
    const middleware = buildApprovedPositionCatalogueReaderMiddleware(pool);

    try {
      const { nextCalled } = await runMiddleware(middleware, {
        user: { employee_code: "EMP-REQ", role_name: "Recruiter" }
      });
      assert.equal(nextCalled, true);
    } finally {
      restore.mock.restore();
    }
  });

  it("Admin without REQUISITION_REQUESTOR is denied assertCanCreateRequisition", async () => {
    const restore = mock.method(
      workAssignmentService,
      "getEmployeeWorkAssignments",
      async () => []
    );

    try {
      await assert.rejects(
        () =>
          assertCanCreateRequisition(
            { query: async () => ({ rows: [] }) },
            { user: { employee_code: "EMP-ADMIN", role_name: "Admin" } }
          ),
        (error) => {
          assert.equal(error.status, 403);
          assert.match(
            error.message,
            /not authorized to create a Requisition/i
          );
          return true;
        }
      );
    } finally {
      restore.mock.restore();
    }
  });

  it("Admin without assignment cannot createDraft via requestor write path", async () => {
    const restore = mock.method(
      workAssignmentService,
      "getEmployeeWorkAssignments",
      async () => []
    );

    try {
      await assert.rejects(
        () =>
          talentDemandDraftService.createDraft(
            { query: async () => ({ rows: [] }) },
            { approved_position_id: "AP-1", job_title: "Engineer" },
            { employee_code: "EMP-ADMIN", role_name: "Admin" }
          ),
        (error) => {
          assert.equal(error.status, 403);
          assert.match(
            error.message,
            /not authorized to create a Requisition/i
          );
          return true;
        }
      );
    } finally {
      restore.mock.restore();
    }
  });
});
