const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const {
  validateMaxApprovalDays,
  createApprovalRoute,
  updateApprovalRoute
} = require("../repositories/approvalRouteRepository");

describe("validateMaxApprovalDays", () => {
  it("accepts valid positive integers", () => {
    assert.equal(validateMaxApprovalDays(1), 1);
    assert.equal(validateMaxApprovalDays(3), 3);
    assert.equal(validateMaxApprovalDays("7"), 7);
  });

  it("rejects negative values", () => {
    assert.throws(
      () => validateMaxApprovalDays(-1),
      (error) => {
        assert.equal(error.status, 400);
        assert.match(error.message, /whole number of at least 1/i);
        return true;
      }
    );
  });

  it("rejects zero", () => {
    assert.throws(
      () => validateMaxApprovalDays(0),
      (error) => {
        assert.equal(error.status, 400);
        return true;
      }
    );
  });

  it("rejects fractional values", () => {
    assert.throws(() => validateMaxApprovalDays(2.5), (error) => {
      assert.equal(error.status, 400);
      return true;
    });
  });

  it("rejects non-numeric and malformed values", () => {
    assert.throws(() => validateMaxApprovalDays("abc"), (error) => {
      assert.equal(error.status, 400);
      return true;
    });
    assert.throws(() => validateMaxApprovalDays(NaN), (error) => {
      assert.equal(error.status, 400);
      return true;
    });
  });

  it("allows blank optional values when configured", () => {
    assert.equal(validateMaxApprovalDays(null, { allowBlank: true }), null);
    assert.equal(validateMaxApprovalDays("", { allowBlank: true }), null);
    assert.equal(validateMaxApprovalDays(undefined, { allowBlank: true }), null);
  });
});

describe("approval route create/update max_approval_days", () => {
  it("create uses default 3 when max_approval_days is omitted", async () => {
    const queries = [];
    const pool = {
      query: async (sql, params) => {
        queries.push({ sql, params });
        return { rows: [{ route_id: 99 }] };
      }
    };

    const routeId = await createApprovalRoute(pool, {
      route_name: "Test Route",
      applies_to: "Requisition"
    });

    assert.equal(routeId, 99);
    assert.equal(queries[0].params[5], 3);
  });

  it("create persists a validated max_approval_days value", async () => {
    let capturedParams;
    const pool = {
      query: async (_sql, params) => {
        capturedParams = params;
        return { rows: [{ route_id: 100 }] };
      }
    };

    await createApprovalRoute(pool, {
      route_name: "SLA Route",
      max_approval_days: 5
    });

    assert.equal(capturedParams[5], 5);
  });

  it("update skips validation when max_approval_days is not provided", async () => {
    let capturedParams;
    const pool = {
      query: async (_sql, params) => {
        capturedParams = params;
        return { rows: [{ route_id: 1, max_approval_days: 3 }] };
      }
    };

    await updateApprovalRoute(pool, 1, {
      route_name: "Renamed only"
    });

    assert.equal(capturedParams[6], null);
  });

  it("update persists a validated max_approval_days value", async () => {
    let capturedParams;
    const pool = {
      query: async (_sql, params) => {
        capturedParams = params;
        return { rows: [{ route_id: 1, max_approval_days: 10 }] };
      }
    };

    await updateApprovalRoute(pool, 1, {
      max_approval_days: 10
    });

    assert.equal(capturedParams[6], 10);
  });

  it("update rejects invalid max_approval_days before query", async () => {
    const pool = {
      query: async () => {
        throw new Error("query should not run");
      }
    };

    await assert.rejects(
      () =>
        updateApprovalRoute(pool, 1, {
          max_approval_days: -2
        }),
      (error) => {
        assert.equal(error.status, 400);
        return true;
      }
    );
  });
});
