const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const {
  hasReleaseOfferAssignment,
  assertCanReleaseOfferToCandidatePortal,
  RELEASE_OFFER_CODE
} = require("../services/offerCandidatePortalReleaseAuth");
const {
  searchPortalReleaseEligibleOffers,
  releaseOfferToCandidatePortal
} = require("../services/offerCandidatePortalReleaseService");
const {
  listReleasedOffersForCandidate,
  getReleasedOfferForCandidate
} = require("../services/candidatePortalOfferService");
const { GENERATED_LETTER_STATUS } = require("../repositories/offerLetterRepository");

const releaseAssignment = {
  is_active: true,
  master_is_active: true,
  assignment_code: RELEASE_OFFER_CODE
};

function poolWithAssignments(rows, queryHandler) {
  return {
    query: async (sql, params) => {
      if (String(sql).includes("employee_work_assignment")) {
        return { rows };
      }
      if (queryHandler) {
        return queryHandler(sql, params);
      }
      return { rows: [] };
    },
    connect: async () => ({
      query: async (sql, params) => {
        if (queryHandler) {
          return queryHandler(sql, params);
        }
        return { rows: [] };
      },
      release: () => {}
    })
  };
}

describe("offerCandidatePortalReleaseAuth", () => {
  it("denies users without RELEASE_OFFER assignment", async () => {
    const pool = poolWithAssignments([]);
    const allowed = await hasReleaseOfferAssignment(pool, {
      user: { employee_code: "EMP1", role_name: "Admin" }
    });
    assert.equal(allowed, false);
  });

  it("allows users with active RELEASE_OFFER assignment", async () => {
    const pool = poolWithAssignments([releaseAssignment]);
    const allowed = await hasReleaseOfferAssignment(pool, {
      user: { employee_code: "EMP1", role_name: "Recruiter" }
    });
    assert.equal(allowed, true);
  });

  it("assertCanReleaseOfferToCandidatePortal throws 403 when unauthorized", async () => {
    const pool = poolWithAssignments([]);
    await assert.rejects(
      () =>
        assertCanReleaseOfferToCandidatePortal(pool, {
          user: { employee_code: "EMP1" }
        }),
      (error) => error.status === 403
    );
  });
});

describe("searchPortalReleaseEligibleOffers", () => {
  it("returns one row per offer with letter generated", async () => {
    const pool = poolWithAssignments([], (sql) => {
      if (String(sql).includes("FROM om_offers o")) {
        return {
          rows: [
            {
              offer_id: "OFF-1",
              requisition_code: "REQ-A",
              candidate_id: 1,
              candidate_name: "Alex",
              candidate_code: "C001",
              position_title: "Engineer",
              offer_status: "Approved",
              offered_ctc: 1200000,
              currency: "INR",
              letter_status: GENERATED_LETTER_STATUS,
              generated_on: "2026-10-01"
            },
            {
              offer_id: "OFF-2",
              requisition_code: "REQ-B",
              candidate_id: 1,
              candidate_name: "Alex",
              candidate_code: "C001",
              position_title: "Lead",
              offer_status: "Released",
              offered_ctc: 1500000,
              currency: "INR",
              letter_status: GENERATED_LETTER_STATUS,
              generated_on: "2026-10-02"
            }
          ]
        };
      }
      return { rows: [] };
    });

    const rows = await searchPortalReleaseEligibleOffers(pool, {}, { search: "Alex" });
    assert.equal(rows.length, 2);
    assert.equal(rows[0].offer_id, "OFF-1");
    assert.equal(rows[1].portal_released, true);
  });
});

describe("candidatePortalOfferService visibility", () => {
  it("lists only Released offers for owning candidate", async () => {
    const pool = poolWithAssignments([], (sql, params) => {
      if (String(sql).includes("FROM om_offers o") && String(sql).includes("Released")) {
        assert.equal(Number(params[0]), 5001);
        return {
          rows: [
            {
              offer_id: "OFF-1",
              requisition_code: "REQ-A",
              position_title: "Engineer",
              offered_ctc: 1000000,
              currency: "INR",
              offer_date: "2026-10-05"
            }
          ]
        };
      }
      return { rows: [] };
    });

    const rows = await listReleasedOffersForCandidate(pool, 5001);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].position_title, "Engineer");
    assert.equal(rows[0].offer_date, "2026-10-05");
  });

  it("returns 404 when candidate does not own offer", async () => {
    const pool = poolWithAssignments([], () => ({ rows: [] }));

    await assert.rejects(
      () => getReleasedOfferForCandidate(pool, 5001, "OFF-OTHER"),
      (error) => error.status === 404
    );
  });
});

describe("releaseOfferToCandidatePortal", () => {
  it("rejects when letter is not generated", async () => {
    const pool = {
      connect: async () => ({
        query: async (sql) => {
          if (String(sql).includes("FOR UPDATE")) {
            return {
              rows: [{ offer_id: "OFF-1", offer_status: "Approved", candidate_id: 1 }]
            };
          }
          if (String(sql).includes("om_offer_letters")) {
            return { rows: [{ status: "Awaiting Letter" }] };
          }
          if (String(sql).startsWith("BEGIN") || String(sql).startsWith("COMMIT")) {
            return { rows: [] };
          }
          return { rows: [] };
        },
        release: () => {}
      })
    };

    await assert.rejects(
      () =>
        releaseOfferToCandidatePortal(pool, "OFF-1", {
          user: { employee_code: "EMP1" },
          body: {}
        }),
      (error) => /generated before release/i.test(error.message)
    );
  });

  it("returns idempotent success when already Released", async () => {
    const pool = {
      connect: async () => ({
        query: async (sql) => {
          if (String(sql).includes("FOR UPDATE")) {
            return {
              rows: [{ offer_id: "OFF-1", offer_status: "Released", candidate_id: 1 }]
            };
          }
          if (String(sql).includes("om_offer_letters")) {
            return { rows: [{ status: GENERATED_LETTER_STATUS }] };
          }
          if (String(sql).startsWith("BEGIN") || String(sql).startsWith("COMMIT")) {
            return { rows: [] };
          }
          return { rows: [] };
        },
        release: () => {}
      }),
      query: async () => ({
        rows: [
          {
            offer_id: "OFF-1",
            offer_status: "Released",
            requisition_code: "REQ-A",
            candidate_id: 1
          }
        ]
      })
    };

    const result = await releaseOfferToCandidatePortal(pool, "OFF-1", {
      user: { employee_code: "EMP1" },
      body: {}
    });

    assert.equal(result.alreadyReleased, true);
  });
});
