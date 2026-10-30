const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  assertCanAccessCandidateControlTowerWorkspace
} = require("../services/candidateControlTowerCapabilityAuth");

describe("candidateControlTowerCapabilityAuth", () => {
  it("denies without showCandidateControlTowerWorkspace assignment", async () => {
    const pool = {
      query: async () => ({ rows: [] })
    };

    await assert.rejects(
      () =>
        assertCanAccessCandidateControlTowerWorkspace(pool, {
          user: { employee_code: "EMP-X", role_name: "Recruiter" }
        }),
      (error) => error.status === 403
    );
  });

  it("allows active CANDIDATE_CONTROL_TOWER assignment via workspace flag", async () => {
    const pool = {
      query: async (sql) => {
        if (String(sql).includes("employee_work_assignment ewa")) {
          return {
            rows: [
              {
                assignment_code: "CANDIDATE_CONTROL_TOWER",
                is_active: true,
                master_is_active: true,
                workspace_flag: "showCandidateControlTowerWorkspace"
              }
            ]
          };
        }
        return { rows: [] };
      }
    };

    await assertCanAccessCandidateControlTowerWorkspace(pool, {
      user: { employee_code: "CCT-1", role_name: "Recruiter" }
    });
  });
});
