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
  findBlockingOfferActivityForMapping,
  assertNoBlockingOfferActivityForMapping,
  acquireOfferRaiseCreationLock,
  mappingOfferScope,
  DUPLICATE_OFFER_MESSAGE,
  GENERATED_LETTER_STATUS,
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

const qualifyingInterview = {
  map_id: 101,
  candidate_id: 5001,
  requisition_code: "REQ-100",
  round_type: FINAL_HR_INTERVIEW_ROUND_TYPE,
  final_outcome: FINAL_HR_INTERVIEW_OUTCOME_SELECTED,
  feedback_submitted: true
};

function matchesBlockingOfferSql(offerRow, params) {
  const [candidateId, requisitionCode, mappingKey] = params;
  if (Number(offerRow.candidate_id) !== Number(candidateId)) {
    return false;
  }
  const offerReq = String(offerRow.requisition_code ?? "").trim();
  const requisitionMatch =
    offerReq !== "" && offerReq === String(requisitionCode).trim();
  const legacyMappingMatch =
    mappingKey != null &&
    Number(offerRow.mapping_id) === Number(mappingKey) &&
    offerReq === "";
  return requisitionMatch || legacyMappingMatch;
}

function createEligibilityQueryable({ offerRow = null, letterRow = null, ambientOffers = [] } = {}) {
  const configuredOffers = [offerRow, ...ambientOffers].filter(Boolean);
  return {
    query: async (sql, params) => {
      const text = String(sql);
      if (text.includes("im_interviews")) {
        return { rows: [qualifyingInterview] };
      }
      if (text.includes("om_offer_letters")) {
        if (letterRow && matchesBlockingOfferSql(letterRow, params)) {
          return { rows: [letterRow] };
        }
        return { rows: [] };
      }
      if (text.includes("FROM om_offers o") && !text.includes("om_offer_letters")) {
        const matched = configuredOffers.find((row) => matchesBlockingOfferSql(row, params));
        return { rows: matched ? [matched] : [] };
      }
      if (text.includes("rm_candidate_mappings") && text.includes("FOR UPDATE")) {
        return { rows: [mapping] };
      }
      if (text.includes("pg_advisory_xact_lock")) {
        return { rows: [{ locked: true }] };
      }
      return { rows: [] };
    }
  };
}

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
    await assertMappingEligibleForOfferRaise(
      createEligibilityQueryable(),
      mapping,
      null
    );
  });

  it("rejects when an existing offer blocks the same candidate and requisition", async () => {
    await assert.rejects(
      () =>
        assertMappingEligibleForOfferRaise(
          createEligibilityQueryable({
            offerRow: {
              offer_id: "OFF-1",
              offer_status: "Draft",
              candidate_id: 5001,
              requisition_code: "REQ-100",
              mapping_id: 101
            }
          }),
          mapping,
          null
        ),
      (error) => {
        assert.equal(error.status, 400);
        assert.equal(error.message, DUPLICATE_OFFER_MESSAGE);
        return true;
      }
    );
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
    assert.match(capturedSql, /NOT EXISTS/i);
    assert.match(capturedSql, /om_offers o/);
    assert.match(capturedSql, /om_offer_letters ol/);
    assert.match(capturedSql, /COALESCE\(m\.mapping_id, m\.map_id\)/);
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

describe("existing offer and letter blocking (Rule B)", () => {
  const blockingStatuses = [
    "Draft",
    "Pending Approval",
    "Approved",
    "Released",
    "Accepted",
    "Declined",
    "Withdrawn",
    "Expired"
  ];

  for (const offerStatus of blockingStatuses) {
    it(`blocks eligibility when om_offers.offer_status is ${offerStatus}`, async () => {
      const offerRow = {
        offer_id: "OFF-BLOCK",
        offer_status: offerStatus,
        candidate_id: 5001,
        requisition_code: "REQ-100",
        mapping_id: 101
      };
      const blocking = await findBlockingOfferActivityForMapping(
        createEligibilityQueryable({ offerRow }),
        mapping
      );
      assert.equal(blocking?.kind, "offer");
      assert.equal(blocking?.offer_status, offerStatus);

      await assert.rejects(
        () =>
          assertNoBlockingOfferActivityForMapping(
            createEligibilityQueryable({ offerRow }),
            mapping
          ),
        (error) => error.message === DUPLICATE_OFFER_MESSAGE
      );
    });
  }

  it("blocks when a generated offer letter exists for the same candidate and requisition", async () => {
    const blocking = await findBlockingOfferActivityForMapping(
      createEligibilityQueryable({
        letterRow: {
          letter_id: "OL-1",
          letter_status: GENERATED_LETTER_STATUS,
          offer_id: "OFF-LETTER",
          candidate_id: 5001,
          requisition_code: "REQ-100",
          mapping_id: 101
        }
      }),
      mapping
    );
    assert.equal(blocking?.kind, "offer_letter");
    assert.equal(blocking?.letter_status, GENERATED_LETTER_STATUS);
  });

  it("blocks legacy offer rows with matching mapping_id and NULL requisition_code", async () => {
    const blocking = await findBlockingOfferActivityForMapping(
      createEligibilityQueryable({
        offerRow: {
          offer_id: "OFF-LEGACY",
          offer_status: "Withdrawn",
          candidate_id: 5001,
          requisition_code: null,
          mapping_id: 101
        }
      }),
      mapping
    );
    assert.equal(blocking?.kind, "offer");
    assert.equal(blocking?.offer_status, "Withdrawn");

    await assert.rejects(
      () =>
        assertMappingEligibleForOfferRaise(
          createEligibilityQueryable({
            offerRow: {
              offer_id: "OFF-LEGACY",
              offer_status: "Withdrawn",
              candidate_id: 5001,
              requisition_code: null,
              mapping_id: 101
            }
          }),
          mapping,
          null
        ),
      (error) => error.message === DUPLICATE_OFFER_MESSAGE
    );
  });

  it("does not block eligibility for REQ-100 when an offer exists only on REQ-200", async () => {
    const offerOnReq200 = {
      offer_id: "OFF-REQ-200",
      offer_status: "Approved",
      candidate_id: 5001,
      requisition_code: "REQ-200",
      mapping_id: 202
    };

    const queryable = createEligibilityQueryable({ ambientOffers: [offerOnReq200] });

    const blocking = await findBlockingOfferActivityForMapping(queryable, mapping);
    assert.equal(blocking, null);

    await assertMappingEligibleForOfferRaise(
      createEligibilityQueryable({ ambientOffers: [offerOnReq200] }),
      mapping,
      null
    );
  });

  it("allows HR-selected mapping with no existing offer activity", async () => {
    const blocking = await findBlockingOfferActivityForMapping(
      createEligibilityQueryable(),
      mapping
    );
    assert.equal(blocking, null);
  });
});

describe("acquireOfferRaiseCreationLock (concurrency guard)", () => {
  it("locks mapping row and acquires transaction-scoped advisory lock", async () => {
    const calls = [];
    const client = {
      query: async (sql, params) => {
        calls.push({ sql: String(sql), params });
        if (String(sql).includes("FOR UPDATE")) {
          return { rows: [mapping] };
        }
        return { rows: [] };
      }
    };

    await acquireOfferRaiseCreationLock(client, 101, mapping);

    assert.ok(calls.some((call) => /FOR UPDATE/i.test(call.sql)));
    assert.ok(calls.some((call) => /pg_advisory_xact_lock/i.test(call.sql)));
    const advisory = calls.find((call) => /pg_advisory_xact_lock/i.test(call.sql));
    assert.equal(advisory.params[0], 5001);
    assert.equal(advisory.params[1], "REQ-100");
  });
});

describe("mappingOfferScope", () => {
  it("scopes blocking to candidate_id and requisition_code pair", () => {
    assert.deepEqual(mappingOfferScope(mapping), {
      candidateId: 5001,
      requisitionCode: "REQ-100",
      mappingKey: 101
    });
  });
});
