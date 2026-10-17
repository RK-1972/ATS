const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const recruitmentService = require("../services/recruitmentService");
const {
  assertCanAccessOfferWorkspace,
  requireOfferWorkspace
} = require("../services/offerCapabilityAuth");
const {
  interviewQualifiesForOfferRaise,
  assertMappingEligibleForOfferRaise,
  listOfferRaiseEligibleMappings,
  FINAL_HR_INTERVIEW_ROUND_TYPE,
  FINAL_HR_INTERVIEW_OUTCOME_SELECTED
} = require("../services/offerRaiseEligibilityService");

const mapping = {
  mapping_id: 101,
  map_id: 101,
  candidate_id: 5001,
  requisition_code: "REQ-100"
};

const offerWorkspaceAssignment = {
  is_active: true,
  master_is_active: true,
  workspace_flag: "showOfferWorkspace",
  assignment_code: "OFFER_RECRUITER"
};

function poolWithWorkAssignments(rows, onEligibilityQuery) {
  return {
    query: async (sql, params) => {
      if (String(sql).includes("employee_work_assignment")) {
        return { rows };
      }
      if (String(sql).includes("im_interviews")) {
        if (onEligibilityQuery) {
          return onEligibilityQuery(sql, params);
        }
        return { rows: [] };
      }
      if (String(sql).includes("rm_candidate_mappings")) {
        return {
          rows: [
            {
              mapping_id: 101,
              map_id: 101,
              candidate_id: 5001,
              requisition_code: "REQ-100",
              is_active: true
            }
          ]
        };
      }
      return { rows: [] };
    }
  };
}

describe("interviewQualifiesForOfferRaise", () => {
  it("accepts HR Round Selected with matching requisition and map_id", () => {
    const interview = {
      map_id: 101,
      candidate_id: 5001,
      requisition_code: "REQ-100",
      round_type: FINAL_HR_INTERVIEW_ROUND_TYPE,
      final_outcome: FINAL_HR_INTERVIEW_OUTCOME_SELECTED,
      feedback_submitted: true
    };
    assert.equal(interviewQualifiesForOfferRaise(mapping, interview), true);
  });

  it("rejects non-Selected outcome", () => {
    const interview = {
      map_id: 101,
      candidate_id: 5001,
      requisition_code: "REQ-100",
      round_type: FINAL_HR_INTERVIEW_ROUND_TYPE,
      final_outcome: "Rejected",
      feedback_submitted: true
    };
    assert.equal(interviewQualifiesForOfferRaise(mapping, interview), false);
  });

  it("rejects Selected outcome from a different interview round", () => {
    const interview = {
      map_id: 101,
      candidate_id: 5001,
      requisition_code: "REQ-100",
      round_type: "L1 Technical",
      final_outcome: FINAL_HR_INTERVIEW_OUTCOME_SELECTED,
      feedback_submitted: true
    };
    assert.equal(interviewQualifiesForOfferRaise(mapping, interview), false);
  });

  it("rejects Selected HR outcome for a different requisition", () => {
    const interview = {
      map_id: 101,
      candidate_id: 5001,
      requisition_code: "REQ-200",
      round_type: FINAL_HR_INTERVIEW_ROUND_TYPE,
      final_outcome: FINAL_HR_INTERVIEW_OUTCOME_SELECTED,
      feedback_submitted: true
    };
    assert.equal(interviewQualifiesForOfferRaise(mapping, interview), false);
  });

  it("rejects Selected HR outcome for a different candidate on same requisition", () => {
    const interview = {
      map_id: 101,
      candidate_id: 9999,
      requisition_code: "REQ-100",
      round_type: FINAL_HR_INTERVIEW_ROUND_TYPE,
      final_outcome: FINAL_HR_INTERVIEW_OUTCOME_SELECTED,
      feedback_submitted: true
    };
    assert.equal(interviewQualifiesForOfferRaise(mapping, interview), false);
  });

  it("rejects when interview map_id does not match mapping", () => {
    const interview = {
      map_id: 202,
      candidate_id: 5001,
      requisition_code: "REQ-100",
      round_type: FINAL_HR_INTERVIEW_ROUND_TYPE,
      final_outcome: FINAL_HR_INTERVIEW_OUTCOME_SELECTED,
      feedback_submitted: true
    };
    assert.equal(interviewQualifiesForOfferRaise(mapping, interview), false);
  });
});

describe("assertMappingEligibleForOfferRaise", () => {
  it("rejects direct offer creation when no qualifying interview exists", async () => {
    const pool = {
      query: async () => ({ rows: [] })
    };

    await assert.rejects(
      () => assertMappingEligibleForOfferRaise(pool, mapping, null),
      (error) => {
        assert.equal(error.status, 400);
        assert.match(error.message, /Final HR Interview outcome is Selected/);
        return true;
      }
    );
  });

  it("accepts when a qualifying HR Selected interview exists for the mapping", async () => {
    const pool = {
      query: async () => ({
        rows: [
          {
            map_id: 101,
            candidate_id: 5001,
            requisition_code: "REQ-100",
            round_type: FINAL_HR_INTERVIEW_ROUND_TYPE,
            final_outcome: FINAL_HR_INTERVIEW_OUTCOME_SELECTED,
            feedback_submitted: true
          }
        ]
      })
    };

    await assertMappingEligibleForOfferRaise(pool, mapping, null);
  });
});

describe("listOfferRaiseEligibleMappings", () => {
  it("does not filter by rm_recruiter_assignments or employee_code", async () => {
    let capturedSql = "";
    let capturedParams = [];

    const pool = {
      query: async (sql, params) => {
        capturedSql = sql;
        capturedParams = params;
        return { rows: [] };
      }
    };

    await listOfferRaiseEligibleMappings(pool);

    assert.ok(!/rm_recruiter_assignments/i.test(capturedSql));
    assert.deepEqual(capturedParams, [
      FINAL_HR_INTERVIEW_ROUND_TYPE,
      FINAL_HR_INTERVIEW_OUTCOME_SELECTED
    ]);
  });

  it("returns eligible rows without regard to recruiter ownership", async () => {
    const pool = {
      query: async () => ({
        rows: [
          {
            mapping_id: 900,
            map_id: 900,
            candidate_id: 5001,
            requisition_code: "REQ-OTHER-OWNER",
            candidate_code: "C900",
            candidate_name: "Eligible Candidate"
          }
        ]
      })
    };

    const rows = await listOfferRaiseEligibleMappings(pool);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].requisition_code, "REQ-OTHER-OWNER");
  });
});

describe("recruitmentService.listOfferRaiseEligibleMappings authorization", () => {
  it("denies when user lacks showOfferWorkspace work assignment", async () => {
    const pool = poolWithWorkAssignments([]);

    await assert.rejects(
      () =>
        recruitmentService.listOfferRaiseEligibleMappings(pool, {
          user: { employee_code: "REC-NO-OFFER", role_name: "Recruiter" }
        }),
      (error) => {
        assert.equal(error.status, 403);
        assert.match(error.message, /Offer Workspace/);
        return true;
      }
    );
  });

  it("allows listing when user has OFFER_RECRUITER / showOfferWorkspace", async () => {
    let eligibilityCalled = false;
    const pool = poolWithWorkAssignments([offerWorkspaceAssignment], () => {
      eligibilityCalled = true;
      return { rows: [{ mapping_id: 1, candidate_code: "X" }] };
    });

    const rows = await recruitmentService.listOfferRaiseEligibleMappings(pool, {
      user: { employee_code: "OFFER-RAISER-1", role_name: "Recruiter" }
    });

    assert.equal(eligibilityCalled, true);
    assert.equal(rows.length, 1);
  });
});

describe("assertCanAccessOfferWorkspace", () => {
  it("does not grant access from Recruiter role alone", async () => {
    const pool = poolWithWorkAssignments([]);

    await assert.rejects(
      () =>
        assertCanAccessOfferWorkspace(pool, {
          user: { employee_code: "PLAIN-REC", role_name: "Recruiter" }
        }),
      (error) => error.status === 403
    );
  });
});

describe("requireOfferWorkspace middleware (POST /api/v1/offers gate)", () => {
  it("calls next when employee has showOfferWorkspace", async () => {
    const pool = poolWithWorkAssignments([offerWorkspaceAssignment]);
    const middleware = requireOfferWorkspace(pool);
    let nextCalled = false;

    const req = { user: { employee_code: "OFFER-RAISER-1", role_name: "Recruiter" } };
    const res = {
      statusCode: null,
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

    await middleware(req, res, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, null);
  });

  it("returns 403 JSON without calling next when workspace permission is missing", async () => {
    const pool = poolWithWorkAssignments([]);
    const middleware = requireOfferWorkspace(pool);
    let nextCalled = false;

    const req = { user: { employee_code: "PLAIN-REC", role_name: "Recruiter" } };
    const res = {
      statusCode: null,
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

    await middleware(req, res, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body?.success, false);
    assert.match(String(res.body?.message || ""), /Offer Workspace/);
  });
});

describe("resolveMappingContextForOfferRaise", () => {
  it("resolves mapping without querying recruiter assignments", async () => {
    const queries = [];
    const pool = {
      query: async (sql) => {
        queries.push(sql);
        if (String(sql).includes("rm_candidate_mappings") && String(sql).includes("map_id")) {
          return {
            rows: [
              {
                mapping_id: 101,
                map_id: 101,
                candidate_id: 5001,
                requisition_code: "REQ-100",
                is_active: true
              }
            ]
          };
        }
        if (String(sql).includes("candidate_req_map")) {
          return { rows: [] };
        }
        if (String(sql).includes("information_schema")) {
          return { rows: [{ exists: false }] };
        }
        return { rows: [] };
      }
    };

    const context = await recruitmentService.resolveMappingContextForOfferRaise(pool, 101);
    assert.equal(context.mapping.candidate_id, 5001);
    assert.ok(!queries.some((q) => /rm_recruiter_assignments/i.test(q)));
  });
});
