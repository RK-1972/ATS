const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { buildApplicationVisibilityClause } = require("../services/candidateControlTowerScope");
const {
  getApplicationDetail,
  getSummaryMetrics,
  searchApplications
} = require("../services/candidateControlTowerService");

describe("candidateControlTowerScope recruiter visibility", () => {
  it("does not grant access from talent pool container alone", async () => {
    const { clause } = await buildApplicationVisibilityClause(
      {},
      { user: { role_name: "Recruiter", employee_code: "REC-1" } },
      1
    );

    assert.doesNotMatch(clause, /TALENT_POOL/);
  });

  it("requires pipeline ownership or active requisition assignment", async () => {
    const { clause, params } = await buildApplicationVisibilityClause(
      {},
      { user: { role_name: "Recruiter", employee_code: "REC-1" } },
      1
    );

    assert.match(clause, /owner_employee_code/);
    assert.match(clause, /rm_recruiter_assignments/);
    assert.deepEqual(params, ["REC-1"]);
  });
});

describe("candidateControlTowerService search filter", () => {
  it("applies q across candidate code, name, email and candidate_id", async () => {
    let countSql = "";
    let countParams = [];

    const pool = {
      query: async (sql, params) => {
        if (sql.includes("SELECT COUNT(*)::int AS total")) {
          countSql = sql;
          countParams = params;
          return { rows: [{ total: 0 }] };
        }

        if (sql.includes("AS last_activity_sort")) {
          return { rows: [] };
        }

        return { rows: [] };
      }
    };

    await searchApplications(
      pool,
      { user: { role_name: "Admin", employee_code: "ADM-1" } },
      { q: "alex@example.com", page: 1, pageSize: 10 }
    );

    assert.match(countSql, /cm\.email_id ILIKE/);
    assert.match(countSql, /cm\.candidate_code ILIKE/);
    assert.match(countSql, /CAST\(cm\.candidate_id AS text\) ILIKE/);
    assert.match(countSql, /cm\.preferred_name ILIKE/);
    assert.ok(countParams.includes("alex@example.com"));
  });
});

describe("candidateControlTowerService detail and KPI", () => {
  it("returns scoped applications for recruiter without talent pool shortcut", async () => {
    let countSql = "";

    const pool = {
      query: async (sql) => {
        if (sql.includes("SELECT COUNT(*)::int AS total")) {
          countSql = sql;
          return { rows: [{ total: 1 }] };
        }

        if (sql.includes("AS last_activity_sort")) {
          return {
            rows: [
              {
                mapping_id: 11,
                map_id: null,
                candidate_id: 300,
                requisition_code: "REQ-ASSIGNED",
                stage_name: "Applied",
                source_type: "Portal",
                recruiter_id: "REC-1",
                applied_on: new Date(),
                candidate_code: "CND-300",
                first_name: "Alex",
                last_name: "Kim",
                preferred_name: null,
                email_id: "alex@example.com",
                mobile_number: "8888888888",
                owner_employee_code: null,
                position_title: "Analyst",
                owner_name: "Alex Recruiter",
                interview_status: "Not Scheduled",
                offer_status: "Not Initiated",
                last_activity_sort: new Date(),
                time_in_stage_days: 2,
                candidate_sort: "alex kim",
                owner_sort: "rec-1",
                requisition_sort: "req-assigned",
                interview_status_sort: "not scheduled",
                offer_status_sort: "not initiated"
              }
            ]
          };
        }

        return { rows: [] };
      }
    };

    const result = await searchApplications(
      pool,
      { user: { role_name: "Recruiter", employee_code: "REC-1" } },
      { page: 1, pageSize: 10 }
    );

    assert.doesNotMatch(countSql, /TALENT_POOL/);
    assert.equal(result.total, 1);
    assert.equal(result.items[0].mapping_id, 11);
  });

  it("denies detail when mapping exists but is outside scoped grid rules", async () => {
    const pool = {
      query: async (sql) => {
        if (
          sql.includes("FROM rm_candidate_mappings m") &&
          sql.includes("WHERE m.mapping_id = $1") &&
          sql.includes("LIMIT 1")
        ) {
          return {
            rows: [
              {
                mapping_id: 42,
                candidate_id: 100,
                requisition_code: "REQ-OTHER"
              }
            ]
          };
        }

        if (sql.includes("SELECT COUNT(*)::int AS total")) {
          return { rows: [{ total: 0 }] };
        }

        if (sql.includes("AS last_activity_sort")) {
          return { rows: [] };
        }

        return { rows: [] };
      }
    };

    await assert.rejects(
      () =>
        getApplicationDetail(
          pool,
          {
            user: { role_name: "Recruiter", employee_code: "REC-A" }
          },
          "42"
        ),
      (error) => error.status === 403
    );
  });

  it("returns detail for mapping visible under the same scoped search rules", async () => {
    const pool = {
      query: async (sql) => {
        if (
          sql.includes("WHERE m.mapping_id = $1") &&
          sql.includes("LIMIT 1")
        ) {
          return {
            rows: [
              {
                mapping_id: 7,
                candidate_id: 200,
                requisition_code: "REQ-MINE"
              }
            ]
          };
        }

        if (sql.includes("SELECT COUNT(*)::int AS total")) {
          return { rows: [{ total: 1 }] };
        }

        if (sql.includes("AS last_activity_sort")) {
          return {
            rows: [
              {
                mapping_id: 7,
                map_id: null,
                candidate_id: 200,
                requisition_code: "REQ-MINE",
                stage_name: "Applied",
                source_type: "Referral",
                recruiter_id: "REC-B",
                applied_on: new Date(),
                candidate_code: "CND-200",
                first_name: "Sam",
                last_name: "Lee",
                preferred_name: null,
                email_id: "sam@example.com",
                mobile_number: "9999999999",
                owner_employee_code: "REC-B",
                position_title: "Engineer",
                owner_name: "Sam Recruiter",
                interview_status: "Not Scheduled",
                offer_status: "Not Initiated",
                last_activity_sort: new Date(),
                time_in_stage_days: 1,
                candidate_sort: "sam lee",
                owner_sort: "sam recruiter",
                requisition_sort: "req-mine",
                interview_status_sort: "not scheduled",
                offer_status_sort: "not initiated"
              }
            ]
          };
        }

        return { rows: [] };
      }
    };

    const detail = await getApplicationDetail(
      pool,
      {
        user: { role_name: "Admin", employee_code: "ADM-1" }
      },
      "7"
    );

    assert.equal(detail.mapping_id, 7);
    assert.equal(detail.candidate_id, 200);
  });

  it("counts unassigned applications using mapping recruiter_id only", async () => {
    let metricsSql = "";

    const pool = {
      query: async (sql) => {
        if (sql.includes("COUNT(*)::int AS active_applications")) {
          metricsSql = sql;
          return {
            rows: [
              {
                active_applications: 2,
                unique_candidates: 2,
                unassigned_applications: 1,
                upcoming_interviews: 0,
                active_offers: 0
              }
            ]
          };
        }

        return { rows: [] };
      }
    };

    const summary = await getSummaryMetrics(pool, {
      user: { role_name: "Admin", employee_code: "ADM-1" }
    });

    assert.equal(summary.unassigned_applications, 1);
    const unassignedFilter =
      metricsSql.match(/COUNT\(\*\) FILTER \(\s*WHERE[^)]+\)/)?.[0] || "";
    assert.match(unassignedFilter, /m\.recruiter_id/);
    assert.doesNotMatch(unassignedFilter, /owner_employee_code/);
  });
});
