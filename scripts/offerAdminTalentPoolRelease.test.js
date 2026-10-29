const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const {
  assertMappingEligibleForOfferRaise,
  findBlockingOfferActivityForMapping,
  DUPLICATE_OFFER_MESSAGE
} = require("../services/offerRaiseEligibilityService");
const {
  OFFER_HISTORY_EVENT,
  PERMITTED_TERMINAL_OFFER_STATUSES,
  PROHIBITED_OFFER_STATUSES,
  UNRELATED_ACTIVE_MAPPING_MESSAGE,
  normalizeReleaseReason,
  normalizeOfferMappingContext,
  enterpriseMappingMatchesOfferContext,
  legacyMappingMatchesOfferContext,
  assertEligibleOfferStatus,
  canAdminReleaseOfferToTalentPool,
  assertAdminUser,
  adminReleaseOfferToTalentPool
} = require("../services/offerAdminTalentPoolReleaseService");

const mapping = {
  mapping_id: 101,
  map_id: 101,
  candidate_id: 5001,
  requisition_code: "REQ-100"
};

function adminReq(roleName = "Admin") {
  return {
    user: {
      role_name: roleName,
      full_name: "Admin User",
      email_id: "admin@example.com",
      employee_code: "EMP-ADMIN"
    }
  };
}

function verifyAdmin(req, res, next) {
  if (req.user?.role_name !== "Admin") {
    return res.status(403).json({
      success: false,
      message: "Access Denied - Admin Only"
    });
  }
  next();
}

describe("normalizeReleaseReason", () => {
  it("rejects empty and whitespace-only reasons", () => {
    assert.equal(normalizeReleaseReason(""), "");
    assert.equal(normalizeReleaseReason("   "), "");
    assert.equal(normalizeReleaseReason("\n\t"), "");
  });

  it("accepts meaningful trimmed text", () => {
    assert.equal(normalizeReleaseReason("  Candidate declined elsewhere  "), "Candidate declined elsewhere");
  });
});

describe("assertEligibleOfferStatus", () => {
  for (const status of PERMITTED_TERMINAL_OFFER_STATUSES) {
    it(`permits terminal status ${status}`, () => {
      assert.equal(assertEligibleOfferStatus(status), status);
    });
  }

  for (const status of PROHIBITED_OFFER_STATUSES) {
    it(`rejects prohibited status ${status}`, () => {
      assert.throws(() => assertEligibleOfferStatus(status), (error) => error.status === 400);
    });
  }

  it("rejects unknown statuses", () => {
    assert.throws(() => assertEligibleOfferStatus("Expired"), (error) => error.status === 400);
  });

  it("rejects Accepted status", () => {
    assert.throws(() => assertEligibleOfferStatus("Accepted"), (error) => {
      return error.status === 400 && /Accepted offers cannot be released/i.test(error.message);
    });
  });
});

describe("canAdminReleaseOfferToTalentPool", () => {
  it("returns false when release was already recorded", () => {
    assert.equal(canAdminReleaseOfferToTalentPool("Declined", true), false);
  });

  it("returns false for Accepted status", () => {
    assert.equal(canAdminReleaseOfferToTalentPool("Accepted", false), false);
  });
});

describe("assertAdminUser", () => {
  it("allows Admin role", () => {
    assert.doesNotThrow(() => assertAdminUser(adminReq("Admin")));
  });

  it("rejects non-Admin roles", () => {
    assert.throws(() => assertAdminUser(adminReq("Recruiter")), (error) => {
      return error.status === 403 && /Admin Only/i.test(error.message);
    });
  });
});

describe("verifyAdmin middleware", () => {
  it("rejects unauthenticated-style missing Admin role", async () => {
    let nextCalled = false;
    const req = { user: { role_name: "Recruiter" } };
    const res = {
      statusCode: 200,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.body = payload;
        return this;
      }
    };

    await verifyAdmin(req, res, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body?.success, false);
  });
});

describe("offer mapping context helpers", () => {
  it("matches enterprise mapping by requisition_code and mapping_id", () => {
    const context = normalizeOfferMappingContext({
      candidate_id: 5001,
      requisition_code: "REQ-100",
      mapping_id: 101
    });

    assert.equal(
      enterpriseMappingMatchesOfferContext(
        {
          mapping_id: 101,
          requisition_code: "REQ-200"
        },
        context
      ),
      true
    );

    assert.equal(
      enterpriseMappingMatchesOfferContext(
        {
          mapping_id: 999,
          requisition_code: "REQ-100"
        },
        context
      ),
      true
    );

    assert.equal(
      enterpriseMappingMatchesOfferContext(
        {
          mapping_id: 999,
          requisition_code: "REQ-200"
        },
        context
      ),
      false
    );
  });

  it("matches legacy mapping by map_id and req_id", () => {
    const context = normalizeOfferMappingContext({
      candidate_id: 5001,
      requisition_code: "REQ-100",
      mapping_id: 101
    });

    assert.equal(legacyMappingMatchesOfferContext({ map_id: 101, req_id: 55 }, context, 55), true);
    assert.equal(legacyMappingMatchesOfferContext({ map_id: 999, req_id: 55 }, context, 55), true);
    assert.equal(legacyMappingMatchesOfferContext({ map_id: 999, req_id: 77 }, context, 55), false);
  });
});

describe("frontend eligibility contract parity", () => {
  it("offerApprovalUtils permits only Declined and Withdrawn", () => {
    const utilsPath = path.join(
      __dirname,
      "..",
      "..",
      "ats-frontend",
      "src",
      "utils",
      "offerApprovalUtils.js"
    );
    const source = fs.readFileSync(utilsPath, "utf8");
    assert.doesNotMatch(source, /ADMIN_TALENT_POOL_RELEASE_TERMINAL_STATUSES[\s\S]*"Accepted"/);
    assert.match(source, /"Declined"/);
    assert.match(source, /"Withdrawn"/);
    assert.deepEqual(
      [...PERMITTED_TERMINAL_OFFER_STATUSES].sort(),
      ["Declined", "Withdrawn"]
    );
  });
});

describe("adminReleaseOfferToTalentPool integration (mocked client)", () => {
  function createTransactionalPool(state) {
    const client = {
      queries: [],
      released: false,
      query: async (sql, params) => {
        client.queries.push({ sql: String(sql), params });
        const text = String(sql);

        if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") {
          return { rows: [] };
        }

        if (text.includes("FROM om_offers") && text.includes("FOR UPDATE")) {
          return { rows: [state.offer] };
        }

        if (text.includes("FROM om_offer_history") && text.includes("event_type")) {
          return { rows: state.priorRelease ? [{ history_id: 1 }] : [] };
        }

        if (text.includes("FROM cand_mstr") && text.includes("FOR UPDATE")) {
          return { rows: [state.candidate] };
        }

        if (text.includes("FROM rm_candidate_mappings") && text.includes("is_active = true")) {
          return { rows: state.activeMappings || [] };
        }

        if (text.includes("UPDATE rm_candidate_mappings")) {
          state.mappingDeactivated = true;
          state.lastEnterpriseUpdateSql = text;
          return { rows: [] };
        }

        if (text.includes("FROM candidate_req_map") && text.includes("is_active = true")) {
          return { rows: state.legacyActiveMappings || [] };
        }

        if (text.includes("UPDATE candidate_req_map")) {
          state.legacyMappingDeactivated = true;
          state.lastLegacyUpdateSql = text;
          return { rows: [] };
        }

        if (text.includes("FROM rm_requisitions")) {
          return { rows: state.requisitionRow ? [state.requisitionRow] : [] };
        }

        if (text.includes("UPDATE cand_mstr")) {
          state.candidateReleased = true;
          return { rows: [] };
        }

        if (text.includes("INSERT INTO rm_pipeline_history")) {
          state.pipelineHistoryInserted = true;
          return { rows: [] };
        }

        if (text.includes("INSERT INTO om_offer_history")) {
          state.offerHistoryInserted = true;
          return { rows: [] };
        }

        if (text.includes("information_schema.tables")) {
          return { rows: [{ exists: Boolean(state.legacyTableExists) }] };
        }

        if (text.includes("rm_candidate_offer_hold")) {
          state.offerHoldTouched = true;
          return { rows: [] };
        }

        if (text.includes("md_enterprise_audit")) {
          state.auditInserted = true;
          return { rows: [] };
        }

        return { rows: [] };
      },
      release() {
        client.released = true;
      }
    };

    return {
      client,
      connect: async () => client,
      query: async (sql) => {
        if (String(sql).includes("md_enterprise_audit")) {
          state.auditInserted = true;
          return { rows: [] };
        }
        return { rows: [] };
      }
    };
  }

  it("releases eligible Declined offer for Admin with audit and history", async () => {
    const state = {
      offer: {
        offer_id: "OFF-1",
        offer_status: "Declined",
        candidate_id: 5001,
        mapping_id: 101,
        requisition_code: "REQ-100"
      },
      candidate: {
        candidate_id: 5001,
        candidate_container: "PIPELINE",
        owner_employee_code: "EMP-R1"
      },
      activeMappings: [
        {
          mapping_id: 101,
          candidate_id: 5001,
          requisition_code: "REQ-100",
          map_id: 101
        }
      ],
      priorRelease: false
    };

    const pool = createTransactionalPool(state);
    const result = await adminReleaseOfferToTalentPool(
      pool,
      "OFF-1",
      "Declined after counter-offer",
      adminReq()
    );

    assert.equal(result.idempotent, false);
    assert.equal(state.mappingDeactivated, true);
    assert.equal(state.candidateReleased, true);
    assert.equal(state.pipelineHistoryInserted, true);
    assert.equal(state.offerHistoryInserted, true);
    assert.equal(state.auditInserted, true);
    assert.ok(pool.client.queries.some((call) => call.sql === "COMMIT"));
  });

  it("rejects missing release reason", async () => {
    const pool = createTransactionalPool({
      offer: { offer_id: "OFF-1", offer_status: "Withdrawn", candidate_id: 5001 },
      candidate: { candidate_id: 5001, candidate_container: "PIPELINE" },
      activeMappings: [],
      priorRelease: false
    });

    await assert.rejects(
      () => adminReleaseOfferToTalentPool(pool, "OFF-1", "  ", adminReq()),
      (error) => error.message === "Release reason is required."
    );
  });

  it("rejects non-Admin caller", async () => {
    const pool = createTransactionalPool({});
    await assert.rejects(
      () =>
        adminReleaseOfferToTalentPool(pool, "OFF-1", "Reason", adminReq("Recruiter")),
      (error) => error.status === 403
    );
  });

  it("rejects Pending Approval status", async () => {
    const pool = createTransactionalPool({
      offer: {
        offer_id: "OFF-1",
        offer_status: "Pending Approval",
        candidate_id: 5001
      },
      candidate: { candidate_id: 5001 },
      activeMappings: [],
      priorRelease: false
    });

    await assert.rejects(
      () => adminReleaseOfferToTalentPool(pool, "OFF-1", "Reason", adminReq()),
      (error) => /approval is pending/i.test(error.message)
    );
  });

  it("rejects Released status awaiting candidate response", async () => {
    const pool = createTransactionalPool({
      offer: { offer_id: "OFF-1", offer_status: "Released", candidate_id: 5001 },
      candidate: { candidate_id: 5001 },
      activeMappings: [],
      priorRelease: false
    });

    await assert.rejects(
      () => adminReleaseOfferToTalentPool(pool, "OFF-1", "Reason", adminReq()),
      (error) => /awaiting candidate response/i.test(error.message)
    );
  });

  it("rejects Accepted status before onboarding rules exist", async () => {
    const pool = createTransactionalPool({
      offer: { offer_id: "OFF-1", offer_status: "Accepted", candidate_id: 5001 },
      candidate: { candidate_id: 5001 },
      activeMappings: [],
      priorRelease: false
    });

    await assert.rejects(
      () => adminReleaseOfferToTalentPool(pool, "OFF-1", "Reason", adminReq()),
      (error) => /Accepted offers cannot be released/i.test(error.message)
    );
  });

  it("returns 409 when an active mapping exists on another requisition", async () => {
    const state = {
      offer: {
        offer_id: "OFF-1",
        offer_status: "Declined",
        candidate_id: 5001,
        mapping_id: 101,
        requisition_code: "REQ-100"
      },
      candidate: {
        candidate_id: 5001,
        candidate_container: "PIPELINE",
        owner_employee_code: "EMP-R1"
      },
      activeMappings: [
        {
          mapping_id: 202,
          candidate_id: 5001,
          requisition_code: "REQ-200",
          map_id: 202
        }
      ],
      priorRelease: false
    };

    const pool = createTransactionalPool(state);

    await assert.rejects(
      () => adminReleaseOfferToTalentPool(pool, "OFF-1", "Reason", adminReq()),
      (error) => {
        return error.status === 409 && error.message === UNRELATED_ACTIVE_MAPPING_MESSAGE;
      }
    );

    assert.equal(state.mappingDeactivated, undefined);
    assert.equal(state.candidateReleased, undefined);
    assert.equal(state.offerHistoryInserted, undefined);
    assert.ok(pool.client.queries.some((call) => call.sql === "ROLLBACK"));
  });

  it("does not deactivate REQ-B legacy mapping when releasing offer for REQ-A", async () => {
    const state = {
      offer: {
        offer_id: "OFF-1",
        offer_status: "Withdrawn",
        candidate_id: 5001,
        mapping_id: 101,
        requisition_code: "REQ-100"
      },
      candidate: { candidate_id: 5001, candidate_container: "PIPELINE" },
      activeMappings: [
        {
          mapping_id: 202,
          candidate_id: 5001,
          requisition_code: "REQ-200",
          map_id: 202
        }
      ],
      legacyTableExists: true,
      legacyActiveMappings: [{ map_id: 303, candidate_id: 5001, req_id: 88 }],
      requisitionRow: { req_id: 55 },
      priorRelease: false
    };

    const pool = createTransactionalPool(state);

    await assert.rejects(
      () => adminReleaseOfferToTalentPool(pool, "OFF-1", "Reason", adminReq()),
      (error) => error.status === 409
    );

    assert.equal(state.legacyMappingDeactivated, undefined);
  });

  it("deactivates only offer-scoped enterprise mapping on successful release", async () => {
    const state = {
      offer: {
        offer_id: "OFF-1",
        offer_status: "Declined",
        candidate_id: 5001,
        mapping_id: 101,
        requisition_code: "REQ-100"
      },
      candidate: { candidate_id: 5001, candidate_container: "PIPELINE" },
      activeMappings: [
        {
          mapping_id: 101,
          candidate_id: 5001,
          requisition_code: "REQ-100",
          map_id: 101
        }
      ],
      priorRelease: false
    };

    const pool = createTransactionalPool(state);
    await adminReleaseOfferToTalentPool(pool, "OFF-1", "Reason", adminReq());

    assert.match(String(state.lastEnterpriseUpdateSql || ""), /requisition_code = \$3/);
    assert.doesNotMatch(String(state.lastEnterpriseUpdateSql || ""), /AND is_active = true'\s*,\s*\[\s*5001\s*\]/);
  });

  it("does not modify offer hold records during release", async () => {
    const state = {
      offer: {
        offer_id: "OFF-1",
        offer_status: "Withdrawn",
        candidate_id: 5001,
        mapping_id: 101,
        requisition_code: "REQ-100"
      },
      candidate: { candidate_id: 5001, candidate_container: "PIPELINE" },
      activeMappings: [],
      priorRelease: false
    };

    const pool = createTransactionalPool(state);
    await adminReleaseOfferToTalentPool(pool, "OFF-1", "Reason", adminReq());

    assert.notEqual(state.offerHoldTouched, true);
  });

  it("is idempotent and does not insert duplicate history", async () => {
    const state = {
      offer: {
        offer_id: "OFF-1",
        offer_status: "Withdrawn",
        candidate_id: 5001,
        mapping_id: 101,
        requisition_code: "REQ-100"
      },
      candidate: { candidate_id: 5001, candidate_container: "TALENT_POOL" },
      activeMappings: [],
      priorRelease: true
    };

    const pool = createTransactionalPool(state);
    const result = await adminReleaseOfferToTalentPool(pool, "OFF-1", "Reason", adminReq());

    assert.equal(result.idempotent, true);
    assert.equal(state.offerHistoryInserted, undefined);
    assert.equal(state.pipelineHistoryInserted, undefined);
  });

  it("rolls back when candidate update fails", async () => {
    const state = {
      offer: {
        offer_id: "OFF-1",
        offer_status: "Withdrawn",
        candidate_id: 5001,
        mapping_id: 101,
        requisition_code: "REQ-100"
      },
      candidate: { candidate_id: 5001, candidate_container: "PIPELINE" },
      activeMappings: [],
      priorRelease: false
    };

    const pool = createTransactionalPool(state);
    const originalQuery = pool.client.query.bind(pool.client);
    pool.client.query = async (sql, params) => {
      if (String(sql).includes("UPDATE cand_mstr")) {
        throw new Error("Simulated database failure");
      }
      return originalQuery(sql, params);
    };

    await assert.rejects(
      () => adminReleaseOfferToTalentPool(pool, "OFF-1", "Rollback case", adminReq()),
      (error) => /Simulated database failure/.test(error.message)
    );

    assert.ok(pool.client.queries.some((call) => call.sql === "ROLLBACK"));
    assert.equal(state.auditInserted, undefined);
  });

  it("does not mutate offer status during release", async () => {
    const state = {
      offer: {
        offer_id: "OFF-1",
        offer_status: "Withdrawn",
        candidate_id: 5001,
        mapping_id: 101,
        requisition_code: "REQ-100"
      },
      candidate: { candidate_id: 5001, candidate_container: "PIPELINE" },
      activeMappings: [],
      priorRelease: false
    };

    const pool = createTransactionalPool(state);
    await adminReleaseOfferToTalentPool(pool, "OFF-1", "Return to pool", adminReq());

    assert.ok(
      !pool.client.queries.some(
        (call) => /UPDATE om_offers/i.test(call.sql) && /offer_status/i.test(call.sql)
      )
    );
  });
});

describe("duplicate-offer protection after admin release", () => {
  it("still blocks re-raise on same candidate and requisition when offer row remains", async () => {
    const offerRow = {
      offer_id: "OFF-1",
      offer_status: "Withdrawn",
      candidate_id: 5001,
      requisition_code: "REQ-100",
      mapping_id: 101
    };

    const queryable = {
      query: async (sql, params) => {
        const text = String(sql);
        if (text.includes("im_interviews")) {
          return {
            rows: [
              {
                map_id: 101,
                candidate_id: 5001,
                requisition_code: "REQ-100",
                round_type: "HR Round",
                final_outcome: "Selected",
                feedback_submitted: true
              }
            ]
          };
        }
        if (text.includes("FROM om_offers o")) {
          const [candidateId, requisitionCode] = params;
          if (
            Number(offerRow.candidate_id) === Number(candidateId)
            && offerRow.requisition_code === requisitionCode
          ) {
            return { rows: [offerRow] };
          }
        }
        return { rows: [] };
      }
    };

    const blocking = await findBlockingOfferActivityForMapping(queryable, mapping);
    assert.equal(blocking?.kind, "offer");

    await assert.rejects(
      () => assertMappingEligibleForOfferRaise(queryable, mapping, null),
      (error) => error.message === DUPLICATE_OFFER_MESSAGE
    );
  });

  it("does not block a different requisition after release", async () => {
    const offerRow = {
      offer_id: "OFF-1",
      offer_status: "Declined",
      candidate_id: 5001,
      requisition_code: "REQ-100",
      mapping_id: 101
    };

    const queryable = {
      query: async (sql, params) => {
        const text = String(sql);
        if (text.includes("im_interviews")) {
          return {
            rows: [
              {
                map_id: 202,
                candidate_id: 5001,
                requisition_code: "REQ-200",
                round_type: "HR Round",
                final_outcome: "Selected",
                feedback_submitted: true
              }
            ]
          };
        }
        if (text.includes("FROM om_offers o")) {
          const [, requisitionCode] = params;
          if (requisitionCode === "REQ-200") {
            return { rows: [] };
          }
          if (requisitionCode === "REQ-100") {
            return { rows: [offerRow] };
          }
        }
        return { rows: [] };
      }
    };

    const otherMapping = {
      mapping_id: 202,
      map_id: 202,
      candidate_id: 5001,
      requisition_code: "REQ-200"
    };

    const blocking = await findBlockingOfferActivityForMapping(queryable, otherMapping);
    assert.equal(blocking, null);
  });
});

describe("OFFER_HISTORY_EVENT constant", () => {
  it("uses stable event type for idempotency checks", () => {
    assert.equal(OFFER_HISTORY_EVENT, "AdminOfferTalentPoolRelease");
  });
});
