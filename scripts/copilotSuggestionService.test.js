const { describe, it, mock } = require("node:test");
const assert = require("node:assert/strict");

const workAssignmentService = require("../services/workAssignmentService");
const hiringManagerIdentityService = require("../services/hiringManagerIdentityService");
const requisitionCapabilityAuth = require("../services/requisitionCapabilityAuth");
const legacyOperationalAdapter = require("../services/legacyOperationalAdapter");
const workspaceResolverService = require("../services/workspaceResolverService");

const copilotSuggestionService = require("../services/copilotSuggestionService");

function activeUserRow(employeeCode, overrides = {}) {
  return {
    employee_code: employeeCode,
    email_id: `${employeeCode}@example.com`,
    role_name: "Recruiter",
    full_name: "Test User",
    is_active: true,
    ...overrides
  };
}

function mockPoolForUser(userRow) {
  return {
    query: async (sql, params) => {
      if (String(sql).includes("FROM user_mstr") && params?.[0]) {
        return { rows: [userRow] };
      }

      if (String(sql).includes("rm_recruiter_assignments")) {
        return { rows: [{ count: userRow.__assignmentCount ?? 0 }] };
      }

      if (String(sql).includes("interview_panel_mstr")) {
        if (userRow.__hasPanel) {
          return { rows: [{ panel_id: 1 }] };
        }
        return { rows: [] };
      }

      return { rows: [] };
    }
  };
}

describe("copilotSuggestionService", () => {
  it("defines inputText for every supported action id", () => {
    for (const id of copilotSuggestionService.COPILOT_ACTION_IDS) {
      assert.ok(
        copilotSuggestionService.ACTION_INPUT_TEXT[id],
        `missing inputText for ${id}`
      );
    }
  });

  it("returns different suggestions when recruiter assignment counts differ", async () => {
    const resolveWorkspace = mock.method(
      workspaceResolverService,
      "resolveWorkspace",
      async () => ({
        workspace: { showRecruitmentWorkspace: false }
      })
    );
    const getAssignments = mock.method(
      workAssignmentService,
      "getEmployeeWorkAssignments",
      async () => []
    );
    mock.method(
      hiringManagerIdentityService,
      "resolveBoundHiringManager",
      async () => {
        throw new Error("no hm");
      }
    );
    mock.method(requisitionCapabilityAuth, "assertCanAssignRecruiters", async () => {
      throw new Error("denied");
    });
    mock.method(legacyOperationalAdapter, "listMyInterviewsForLegacyApi", async () => []);

    const withAssignments = activeUserRow("REC-A", { __assignmentCount: 2 });
    const withoutAssignments = activeUserRow("REC-B", { __assignmentCount: 0 });

    const poolA = mockPoolForUser(withAssignments);
    const poolB = mockPoolForUser(withoutAssignments);

    const reqA = { user: { employee_code: "REC-A", role_name: "Recruiter" } };
    const reqB = { user: { employee_code: "REC-B", role_name: "Recruiter" } };

    const resultA = await copilotSuggestionService.buildPersonalizedSuggestions(
      poolA,
      reqA
    );
    const resultB = await copilotSuggestionService.buildPersonalizedSuggestions(
      poolB,
      reqB
    );

    assert.ok(resultA.suggestions.some((s) => s.id === "map-candidate"));
    assert.equal(
      resultB.suggestions.some((s) => s.id === "map-candidate"),
      false
    );
    assert.equal(
      resultB.suggestions.some((s) => s.id === "requisitions"),
      false
    );

    resolveWorkspace.mock.restore();
    getAssignments.mock.restore();
  });

  it("includes assign-recruiter only when capability auth passes", async () => {
    mock.method(workspaceResolverService, "resolveWorkspace", async () => ({
      workspace: { showRecruitmentWorkspace: true }
    }));
    mock.method(workAssignmentService, "getEmployeeWorkAssignments", async () => []);
    mock.method(
      hiringManagerIdentityService,
      "resolveBoundHiringManager",
      async () => {
        throw new Error("no hm");
      }
    );
    mock.method(requisitionCapabilityAuth, "assertCanAssignRecruiters", async () => {});
    mock.method(legacyOperationalAdapter, "listMyInterviewsForLegacyApi", async () => []);

    const userRow = activeUserRow("TA-1", {
      role_name: "TA Lead",
      __assignmentCount: 0
    });
    const pool = mockPoolForUser(userRow);
    const result = await copilotSuggestionService.buildPersonalizedSuggestions(pool, {
      user: { employee_code: "TA-1", role_name: "TA Lead" }
    });

    assert.ok(result.suggestions.some((s) => s.id === "assign-recruiter"));
    const ids = result.suggestions.map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it("excludes conduct-interview when only completed or cancelled interviews exist", async () => {
    mock.method(workspaceResolverService, "resolveWorkspace", async () => ({
      workspace: { showInterviewWorkspace: true }
    }));
    mock.method(workAssignmentService, "getEmployeeWorkAssignments", async () => []);
    mock.method(
      hiringManagerIdentityService,
      "resolveBoundHiringManager",
      async () => {
        throw new Error("no hm");
      }
    );
    mock.method(requisitionCapabilityAuth, "assertCanAssignRecruiters", async () => {
      throw new Error("denied");
    });
    mock.method(legacyOperationalAdapter, "listMyInterviewsForLegacyApi", async () => [
      { interview_status: "Completed", feedback_submitted: false },
      { interview_status: "Cancelled", feedback_submitted: false }
    ]);

    const userRow = activeUserRow("INT-1", {
      role_name: "Interviewer",
      __hasPanel: true,
      __assignmentCount: 0
    });
    const pool = mockPoolForUser(userRow);
    const result = await copilotSuggestionService.buildPersonalizedSuggestions(pool, {
      user: { employee_code: "INT-1", role_name: "Interviewer" }
    });

    assert.equal(
      result.suggestions.some((s) => s.id === "conduct-interview"),
      false
    );
  });

  it("rejects inactive employees", async () => {
    const pool = {
      query: async () => ({
        rows: [activeUserRow("INACTIVE-1", { is_active: false })]
      })
    };

    await assert.rejects(
      () =>
        copilotSuggestionService.buildPersonalizedSuggestions(pool, {
          user: { employee_code: "INACTIVE-1" }
        }),
      (error) => error.status === 403
    );
  });

  it("never uses a client-supplied employee code over JWT identity", async () => {
    let queriedCode = null;

    const pool = {
      query: async (sql, params) => {
        if (String(sql).includes("FROM user_mstr")) {
          queriedCode = params[0];
          return {
            rows: [
              activeUserRow("JWT-USER", {
                __assignmentCount: 1
              })
            ]
          };
        }

        if (String(sql).includes("rm_recruiter_assignments")) {
          return { rows: [{ count: 1 }] };
        }

        return { rows: [] };
      }
    };

    mock.method(workspaceResolverService, "resolveWorkspace", async () => ({
      workspace: { showRecruitmentWorkspace: true }
    }));
    mock.method(workAssignmentService, "getEmployeeWorkAssignments", async () => []);
    mock.method(
      hiringManagerIdentityService,
      "resolveBoundHiringManager",
      async () => {
        throw new Error("no hm");
      }
    );
    mock.method(requisitionCapabilityAuth, "assertCanAssignRecruiters", async () => {
      throw new Error("denied");
    });
    mock.method(legacyOperationalAdapter, "listMyInterviewsForLegacyApi", async () => []);

    await copilotSuggestionService.buildPersonalizedSuggestions(pool, {
      user: { employee_code: "JWT-USER", role_name: "Recruiter" },
      query: { employee_code: "OTHER-USER" }
    });

    assert.equal(queriedCode, "JWT-USER");
  });

  it("does not offer map-candidate for recruitment workspace without own assignments", async () => {
    mock.method(workspaceResolverService, "resolveWorkspace", async () => ({
      workspace: { showRecruitmentWorkspace: true }
    }));
    mock.method(workAssignmentService, "getEmployeeWorkAssignments", async () => []);
    mock.method(
      hiringManagerIdentityService,
      "resolveBoundHiringManager",
      async () => {
        throw new Error("no hm");
      }
    );
    mock.method(requisitionCapabilityAuth, "assertCanAssignRecruiters", async () => {
      throw new Error("denied");
    });
    mock.method(legacyOperationalAdapter, "listMyInterviewsForLegacyApi", async () => []);

    const userRow = activeUserRow("REC-EMPTY", { __assignmentCount: 0 });
    const pool = mockPoolForUser(userRow);
    const result = await copilotSuggestionService.buildPersonalizedSuggestions(pool, {
      user: { employee_code: "REC-EMPTY", role_name: "Recruiter" }
    });

    assert.equal(
      result.suggestions.some((s) => s.id === "map-candidate"),
      false
    );
    assert.ok(result.suggestions.some((s) => s.id === "requisitions"));
  });

  it("offers candidates only for bound hiring managers without recruitment scope", async () => {
    mock.method(workspaceResolverService, "resolveWorkspace", async () => ({
      workspace: {}
    }));
    mock.method(workAssignmentService, "getEmployeeWorkAssignments", async () => []);
    mock.method(
      hiringManagerIdentityService,
      "resolveBoundHiringManager",
      async () => ({ hiring_manager_id: 1 })
    );
    mock.method(requisitionCapabilityAuth, "assertCanAssignRecruiters", async () => {
      throw new Error("denied");
    });
    mock.method(legacyOperationalAdapter, "listMyInterviewsForLegacyApi", async () => []);

    const userRow = activeUserRow("HM-1", {
      role_name: "Hiring Manager",
      __assignmentCount: 0
    });
    const pool = mockPoolForUser(userRow);
    const result = await copilotSuggestionService.buildPersonalizedSuggestions(pool, {
      user: { employee_code: "HM-1", role_name: "Hiring Manager" }
    });

    assert.deepEqual(
      result.suggestions.map((s) => s.id),
      ["candidates"]
    );
  });

  it("narrows suggestions when workspace resolution fails", async () => {
    mock.method(workspaceResolverService, "resolveWorkspace", async () => {
      throw new Error("service unavailable");
    });
    mock.method(workAssignmentService, "getEmployeeWorkAssignments", async () => []);
    mock.method(
      hiringManagerIdentityService,
      "resolveBoundHiringManager",
      async () => {
        throw new Error("no hm");
      }
    );
    mock.method(requisitionCapabilityAuth, "assertCanAssignRecruiters", async () => {
      throw new Error("denied");
    });
    mock.method(legacyOperationalAdapter, "listMyInterviewsForLegacyApi", async () => []);

    const userRow = activeUserRow("REC-NO-WS", { __assignmentCount: 1 });
    const pool = mockPoolForUser(userRow);
    const result = await copilotSuggestionService.buildPersonalizedSuggestions(pool, {
      user: { employee_code: "REC-NO-WS", role_name: "Recruiter" }
    });

    const ids = result.suggestions.map((s) => s.id);
    assert.ok(ids.includes("requisitions"));
    assert.ok(ids.includes("map-candidate"));
    assert.equal(ids.includes("assign-recruiter"), false);
  });

  it("includes conduct-interview only for actionable interviewer assignments", async () => {
    mock.method(workspaceResolverService, "resolveWorkspace", async () => ({
      workspace: { showInterviewWorkspace: true }
    }));
    mock.method(workAssignmentService, "getEmployeeWorkAssignments", async () => []);
    mock.method(
      hiringManagerIdentityService,
      "resolveBoundHiringManager",
      async () => {
        throw new Error("no hm");
      }
    );
    mock.method(requisitionCapabilityAuth, "assertCanAssignRecruiters", async () => {
      throw new Error("denied");
    });
    mock.method(legacyOperationalAdapter, "listMyInterviewsForLegacyApi", async () => [
      { interview_status: "Scheduled", feedback_submitted: false }
    ]);

    const userRow = activeUserRow("INT-2", {
      role_name: "Interviewer",
      __hasPanel: true,
      __assignmentCount: 0
    });
    const pool = mockPoolForUser(userRow);
    const result = await copilotSuggestionService.buildPersonalizedSuggestions(pool, {
      user: { employee_code: "INT-2", role_name: "Interviewer" }
    });

    assert.deepEqual(
      result.suggestions.map((s) => s.id),
      ["conduct-interview"]
    );
  });
});
