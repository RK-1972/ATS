const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  ENTERPRISE_TALENT_ADMIN_ROLE_NAME,
  isEnterpriseTalentAdministratorUser
} = require("../constants/employeeRoles");
const { buildApplicationVisibilityClause } = require("../services/candidateControlTowerScope");
const {
  assertCanAccessCandidateControlTowerWorkspace
} = require("../services/candidateControlTowerCapabilityAuth");
const {
  canReadCandidateRow,
  isAdminUser
} = require("../services/candidateAccessService");
const {
  getApplicationDetail,
  getSummaryMetrics,
  searchApplications
} = require("../services/candidateControlTowerService");

const ETA_USER = {
  role_name: ENTERPRISE_TALENT_ADMIN_ROLE_NAME,
  employee_code: "ETA-ORG-1"
};

function sharedVisibleMappingPool() {
  return {
    query: async (sql) => {
      if (
        sql.includes("WHERE m.mapping_id = $1") &&
        sql.includes("LIMIT 1")
      ) {
        return {
          rows: [
            {
              mapping_id: 901,
              candidate_id: 501,
              requisition_code: "REQ-OTHER-TEAM"
            }
          ]
        };
      }

      if (sql.includes("SELECT COUNT(*)::int AS total")) {
        return { rows: [{ total: 1 }] };
      }

      if (sql.includes("COUNT(*)::int AS active_applications")) {
        return {
          rows: [
            {
              active_applications: 1,
              unique_candidates: 1,
              unassigned_applications: 0,
              upcoming_interviews: 0,
              active_offers: 0
            }
          ]
        };
      }

      if (sql.includes("AS last_activity_sort")) {
        return {
          rows: [
            {
              mapping_id: 901,
              map_id: null,
              candidate_id: 501,
              requisition_code: "REQ-OTHER-TEAM",
              stage_name: "Applied",
              source_type: "Portal",
              recruiter_id: "REC-OTHER",
              applied_on: new Date(),
              candidate_code: "CND-501",
              first_name: "Jordan",
              last_name: "Other",
              preferred_name: null,
              email_id: "jordan@example.com",
              mobile_number: "7777777777",
              owner_employee_code: "REC-OTHER",
              position_title: "Consultant",
              owner_name: "Other Recruiter",
              interview_status: "Not Scheduled",
              offer_status: "Not Initiated",
              last_activity_sort: new Date(),
              time_in_stage_days: 3,
              candidate_sort: "jordan other",
              owner_sort: "other recruiter",
              requisition_sort: "req-other-team",
              interview_status_sort: "not scheduled",
              offer_status_sort: "not initiated"
            }
          ]
        };
      }

      return { rows: [] };
    }
  };
}

describe("Enterprise Talent Administrator role resolution", () => {
  it("recognizes primary role_name only", () => {
    assert.equal(isEnterpriseTalentAdministratorUser({ user: ETA_USER }), true);
    assert.equal(
      isEnterpriseTalentAdministratorUser({
        user: {
          role_name: "Recruiter",
          secondary_role: ENTERPRISE_TALENT_ADMIN_ROLE_NAME,
          employee_code: "REC-1"
        }
      }),
      false
    );
  });
});

describe("Enterprise Talent Administrator CCT scope", () => {
  it("returns organization-wide visibility for active mappings", async () => {
    const { clause, params } = await buildApplicationVisibilityClause(
      {},
      { user: ETA_USER },
      1
    );

    assert.equal(clause, "TRUE");
    assert.deepEqual(params, []);
  });

  it("does not use platform Admin bypass", () => {
    assert.equal(isAdminUser({ user: ETA_USER }), false);
  });

  it("preserves Admin scope branch", async () => {
    const { clause } = await buildApplicationVisibilityClause(
      {},
      { user: { role_name: "Admin", employee_code: "ADM-1" } },
      1
    );

    assert.equal(clause, "TRUE");
  });

  it("preserves Recruiter ownership/assignment scope", async () => {
    const { clause, params } = await buildApplicationVisibilityClause(
      {},
      { user: { role_name: "Recruiter", employee_code: "REC-1" } },
      1
    );

    assert.match(clause, /owner_employee_code/);
    assert.deepEqual(params, ["REC-1"]);
  });

  it("preserves TA Lead approved-requisition scope", async () => {
    const { clause } = await buildApplicationVisibilityClause(
      {},
      { user: { role_name: "TA Lead", employee_code: "TAL-1" } },
      1
    );

    assert.match(clause, /APPROVED/);
    assert.doesNotMatch(clause, /^TRUE$/);
  });

  it("preserves TA Leader approved-requisition scope", async () => {
    const { clause } = await buildApplicationVisibilityClause(
      {},
      { user: { role_name: "TA Leader", employee_code: "TL-1" } },
      1
    );

    assert.match(clause, /APPROVED/);
  });

  it("preserves Hiring Manager bound requisition scope", async () => {
    const pool = {
      query: async () => ({
        rows: [{ hiring_manager_name: "Pat HM" }]
      })
    };

    const { clause, params } = await buildApplicationVisibilityClause(
      pool,
      { user: { role_name: "Hiring Manager", employee_code: "HM-1" } },
      2
    );

    assert.match(clause, /r_hm\.hiring_manager/);
    assert.deepEqual(params, ["Pat HM"]);
  });
});

describe("Enterprise Talent Administrator CCT data access", () => {
  it("views another recruiter application in list and detail", async () => {
    const pool = sharedVisibleMappingPool();

    const list = await searchApplications(pool, { user: ETA_USER }, { page: 1, pageSize: 10 });

    assert.equal(list.total, 1);
    assert.equal(list.items[0].mapping_id, 901);
    assert.equal(list.items[0].owner_employee_code, "REC-OTHER");

    const detail = await getApplicationDetail(pool, { user: ETA_USER }, "901");

    assert.equal(detail.mapping_id, 901);
  });

  it("views applications across different requisitions in one list", async () => {
    const pool = {
      query: async (sql) => {
        if (sql.includes("SELECT COUNT(*)::int AS total")) {
          return { rows: [{ total: 2 }] };
        }

        if (sql.includes("AS last_activity_sort")) {
          return {
            rows: [
              {
                mapping_id: 801,
                map_id: null,
                candidate_id: 401,
                requisition_code: "REQ-A",
                stage_name: "Applied",
                source_type: "Portal",
                recruiter_id: "REC-X",
                applied_on: new Date(),
                candidate_code: "CND-401",
                first_name: "A",
                last_name: "One",
                preferred_name: null,
                email_id: "a@example.com",
                mobile_number: "1111111111",
                owner_employee_code: "REC-X",
                position_title: "Role A",
                owner_name: "Rec X",
                interview_status: "Not Scheduled",
                offer_status: "Not Initiated",
                last_activity_sort: new Date(),
                time_in_stage_days: 1,
                candidate_sort: "a one",
                owner_sort: "rec x",
                requisition_sort: "req-a",
                interview_status_sort: "not scheduled",
                offer_status_sort: "not initiated"
              },
              {
                mapping_id: 802,
                map_id: null,
                candidate_id: 402,
                requisition_code: "REQ-B",
                stage_name: "Screening",
                source_type: "Referral",
                recruiter_id: "REC-Y",
                applied_on: new Date(),
                candidate_code: "CND-402",
                first_name: "B",
                last_name: "Two",
                preferred_name: null,
                email_id: "b@example.com",
                mobile_number: "2222222222",
                owner_employee_code: "REC-Y",
                position_title: "Role B",
                owner_name: "Rec Y",
                interview_status: "Not Scheduled",
                offer_status: "Not Initiated",
                last_activity_sort: new Date(),
                time_in_stage_days: 2,
                candidate_sort: "b two",
                owner_sort: "rec y",
                requisition_sort: "req-b",
                interview_status_sort: "not scheduled",
                offer_status_sort: "not initiated"
              }
            ]
          };
        }

        return { rows: [] };
      }
    };

    const list = await searchApplications(pool, { user: ETA_USER }, { page: 1, pageSize: 10 });

    assert.equal(list.total, 2);
    const codes = list.items.map((row) => row.requisition_code).sort();
    assert.deepEqual(codes, ["REQ-A", "REQ-B"]);
  });

  it("returns consistent summary counts for the same scoped rows", async () => {
    const pool = sharedVisibleMappingPool();

    const list = await searchApplications(pool, { user: ETA_USER }, { page: 1, pageSize: 10 });
    const summary = await getSummaryMetrics(pool, { user: ETA_USER });

    assert.equal(summary.active_applications, list.total);
    assert.equal(summary.unique_candidates, 1);
  });
});

describe("Enterprise Talent Administrator workspace gate", () => {
  it("denies CCT without CANDIDATE_CONTROL_TOWER assignment", async () => {
    const pool = {
      query: async () => ({ rows: [] })
    };

    await assert.rejects(
      () => assertCanAccessCandidateControlTowerWorkspace(pool, { user: ETA_USER }),
      (error) => error.status === 403
    );
  });
});

describe("Enterprise Talent Administrator unrelated candidate APIs", () => {
  it("does not gain generic candidate profile read via canReadCandidateRow", () => {
    const allowed = canReadCandidateRow(
      {
        candidate_container: "PIPELINE",
        owner_employee_code: "REC-OTHER"
      },
      { user: ETA_USER }
    );

    assert.equal(allowed, false);
  });
});
