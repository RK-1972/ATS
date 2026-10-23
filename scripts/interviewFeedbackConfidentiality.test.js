const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  stripHrFromFeedbackSummaries,
  filterFeedbackSummariesForRecruiterScheduler,
  filterStageGroupsForCaller,
  filterProgressRoundsForCaller,
  isSessionScheduledByCaller,
  assertInterviewFeedbackConfidentiality,
  buildFeedbackSummariesFromRows,
  canReadHrInterviewFeedback,
  isTaLeaderUser,
  redactHrInterviewEnterpriseRow,
  redactHrInterviewBundleDto,
  sanitizeInterviewBundleForCaller,
  buildInterviewBundleSummaryFromDto,
  isHrInterviewRound
} = require("../services/interviewFeedbackConfidentialityService");

const { OFFER_WORKSPACE_FLAG, hasOfferWorkspaceAccess } = require("../services/offerCapabilityAuth");

const {
  mapInterviewRowsToFeedbackSummaries,
  resolveCurrentStageDecision
} = require("../services/interviewRepeatStageService");

function poolWithAssignments(rows = []) {
  return {
    query: async () => ({ rows: [] }),
    assignments: rows,
    async _getAssignments() {
      return this.assignments;
    }
  };
}

function mockPoolForEmployee(assignments) {
  const workAssignmentService = require("../services/workAssignmentService");
  const original = workAssignmentService.getEmployeeWorkAssignments;
  workAssignmentService.getEmployeeWorkAssignments = async () => assignments;
  return () => {
    workAssignmentService.getEmployeeWorkAssignments = original;
  };
}

function recruiterReq(employeeCode = "REC001", name = "Recruiter One") {
  return {
    user: {
      role_name: "Recruiter",
      employee_code: employeeCode,
      name
    }
  };
}

function interviewerReq() {
  return {
    user: {
      role_name: "Interviewer",
      employee_code: "INT001",
      name: "Interviewer One"
    }
  };
}

function adminReq() {
  return { user: { role_name: "Admin", employee_code: "ADM001", name: "Admin" } };
}

function taLeaderReq() {
  return { user: { role_name: "TA Leader", employee_code: "TLDR001", name: "TA Leader" } };
}

function taLeadReq() {
  return { user: { role_name: "TA Lead", employee_code: "TL001", name: "TA Lead" } };
}

const offerLetterWorkspaceAssignment = {
  is_active: true,
  master_is_active: true,
  assignment_code: "ANY_CODE",
  assignment_name: "Any Display Name",
  workspace_flag: OFFER_WORKSPACE_FLAG
};

const sampleRows = [
  {
    interview_id: "INT-L1-A",
    schedule_id: 101,
    round_type: "L1 Technical",
    feedback_submitted: true,
    final_outcome: "Selected",
    feedback_id: 1,
    feedback_outcome: "Selected",
    created_by: "REC001",
    created_on: "2026-01-01T10:00:00.000Z",
    modified_on: "2026-01-02T10:00:00.000Z",
    submitted_on: "2026-01-02T10:00:00.000Z"
  },
  {
    interview_id: "INT-L1-B",
    schedule_id: 102,
    round_type: "L1 Technical",
    feedback_submitted: true,
    final_outcome: "Rejected",
    feedback_id: 2,
    feedback_outcome: "Rejected",
    created_by: "REC002",
    created_on: "2026-02-01T10:00:00.000Z",
    modified_on: "2026-03-01T10:00:00.000Z",
    submitted_on: "2026-03-01T10:00:00.000Z"
  },
  {
    interview_id: "INT-HR",
    schedule_id: 103,
    round_type: "HR Round",
    feedback_submitted: true,
    final_outcome: "Selected",
    feedback_id: 3,
    feedback_outcome: "Selected",
    created_by: "REC001",
    created_on: "2026-03-01T10:00:00.000Z",
    modified_on: "2026-03-02T10:00:00.000Z",
    submitted_on: "2026-03-02T10:00:00.000Z"
  },
  {
    interview_id: "INT-L2",
    schedule_id: 104,
    round_type: "L2 Manager",
    feedback_submitted: true,
    final_outcome: "Selected",
    feedback_id: 4,
    feedback_outcome: "Selected",
    created_by: "REC001",
    created_on: "2026-04-01T10:00:00.000Z",
    modified_on: "2026-04-02T10:00:00.000Z",
    submitted_on: "2026-04-02T10:00:00.000Z"
  }
];

describe("HR feedback read roles and assignments", () => {
  it("distinguishes TA Leader from TA Lead for HR read", async () => {
    const pool = poolWithAssignments();
    assert.equal(isTaLeaderUser(taLeaderReq()), true);
    assert.equal(isTaLeaderUser(taLeadReq()), false);
    assert.equal(await canReadHrInterviewFeedback(pool, taLeaderReq()), true);
    assert.equal(await canReadHrInterviewFeedback(pool, taLeadReq()), false);
  });

  it("grants HR read when Offer Letter workspace privilege is active", async () => {
    const restore = mockPoolForEmployee([offerLetterWorkspaceAssignment]);
    const pool = poolWithAssignments();

    assert.equal(
      await canReadHrInterviewFeedback(pool, recruiterReq("REC-OFFER")),
      true
    );
    assert.equal(
      await hasOfferWorkspaceAccess(pool, recruiterReq("REC-OFFER")),
      true
    );

    restore();
  });

  it("denies HR read when Offer Letter workspace assignment is inactive", async () => {
    const restore = mockPoolForEmployee([
      { ...offerLetterWorkspaceAssignment, is_active: false }
    ]);
    const pool = poolWithAssignments();

    assert.equal(
      await canReadHrInterviewFeedback(pool, recruiterReq("REC-NO-OFFER")),
      false
    );

    restore();
  });

  it("does not grant HR read from assignment display name or code alone", async () => {
    const restore = mockPoolForEmployee([
      {
        is_active: true,
        master_is_active: true,
        assignment_name: "Raise Offer",
        assignment_code: "OFFER_RECRUITER",
        workspace_flag: null
      }
    ]);
    const pool = poolWithAssignments();

    assert.equal(
      await canReadHrInterviewFeedback(pool, recruiterReq("REC-NAME-ONLY")),
      false
    );

    restore();
  });

  it("denies Offer Letter workspace when master assignment is inactive", async () => {
    const restore = mockPoolForEmployee([
      {
        ...offerLetterWorkspaceAssignment,
        master_is_active: false
      }
    ]);
    const pool = poolWithAssignments();

    assert.equal(
      await hasOfferWorkspaceAccess(pool, recruiterReq("REC-INACTIVE-MASTER")),
      false
    );

    restore();
  });
});

describe("interview bundle HTTP response sanitization", () => {
  it("sanitizes unredacted HR bundle DTO rows (legacy HTTP leak shape)", async () => {
    const pool = poolWithAssignments();
    const restore = mockPoolForEmployee([]);

    const leakedBundle = {
      interviews: [
        {
          roundType: "HR Round",
          scheduleId: 42,
          finalOutcome: "Selected",
          feedbackSubmitted: true,
          remarks: "confidential",
          interviewStatus: "Completed"
        },
        {
          roundType: "L1 Technical",
          scheduleId: 41,
          finalOutcome: "Selected",
          feedbackSubmitted: true,
          interviewStatus: "Completed"
        }
      ],
      summary: { scheduled: 0, completed: 2, pendingFeedback: 0 }
    };

    const sanitized = await sanitizeInterviewBundleForCaller(
      pool,
      recruiterReq(),
      leakedBundle
    );

    assert.equal(sanitized.interviews[0].finalOutcome, null);
    assert.equal(sanitized.interviews[0].feedbackSubmitted, null);
    assert.equal(sanitized.interviews[0].feedback_submitted, null);
    assert.equal(sanitized.interviews[0].remarks, null);
    assert.equal(sanitized.interviews[1].finalOutcome, "Selected");
    assert.equal(sanitized.summary.pendingFeedback, 0);
    assert.equal(sanitized.summary.completed, 2);

    restore();
  });

  it("redacts legacy snake_case HR fields on bundle DTO rows", () => {
    const redacted = redactHrInterviewBundleDto(
      {
        round_type: "HR Round",
        final_outcome: "Rejected",
        feedback_submitted: true,
        remarks: "secret"
      },
      false
    );

    assert.equal(redacted.final_outcome, null);
    assert.equal(redacted.feedback_submitted, null);
    assert.equal(redacted.remarks, null);
  });

  it("does not count submitted HR as pending feedback for unauthorized readers", () => {
    const interviews = [
      {
        roundType: "HR Round",
        interviewStatus: "Completed",
        feedbackSubmitted: null,
        finalOutcome: null
      },
      {
        roundType: "L1 Technical",
        interviewStatus: "Scheduled",
        feedbackSubmitted: false
      }
    ];

    const summary = buildInterviewBundleSummaryFromDto(interviews, false);
    assert.equal(summary.pendingFeedback, 1);
    assert.equal(summary.scheduled, 1);
  });

  it("retains HR outcomes for authorized readers", async () => {
    const pool = poolWithAssignments();
    const bundle = {
      interviews: [
        {
          roundType: "HR Round",
          finalOutcome: "Selected",
          feedbackSubmitted: true,
          interviewStatus: "Completed"
        }
      ],
      summary: { scheduled: 0, completed: 1, pendingFeedback: 0 }
    };

    const sanitized = await sanitizeInterviewBundleForCaller(pool, adminReq(), bundle);
    assert.equal(sanitized.interviews[0].finalOutcome, "Selected");
    assert.equal(sanitized.interviews[0].feedbackSubmitted, true);
    assert.equal(sanitized.summary.pendingFeedback, 0);
    assert.equal(sanitized.summary.completed, 1);
    assert.equal(redactHrInterviewBundleDto(bundle.interviews[0], true).finalOutcome, "Selected");
  });
});

describe("interview bundle HR outcome redaction", () => {
  const hrRow = {
    interview_id: "INT-HR",
    round_type: "HR Round",
    feedback_submitted: true,
    final_outcome: "Selected",
    remarks: "confidential"
  };

  const l1Row = {
    interview_id: "INT-L1",
    round_type: "L1 Technical",
    feedback_submitted: true,
    final_outcome: "Selected",
    remarks: "ok"
  };

  it("redacts HR outcome metadata for unauthorized callers", () => {
    const redacted = redactHrInterviewEnterpriseRow(hrRow, false);
    assert.equal(redacted.feedback_submitted, false);
    assert.equal(redacted.final_outcome, null);
    assert.equal(redacted.remarks, null);
    assert.equal(redacted.round_type, "HR Round");
  });

  it("preserves HR outcome metadata for authorized HR readers", () => {
    const kept = redactHrInterviewEnterpriseRow(hrRow, true);
    assert.equal(kept.feedback_submitted, true);
    assert.equal(kept.final_outcome, "Selected");
    assert.equal(kept.remarks, "confidential");
  });

  it("does not alter L1/L2 rows for unauthorized callers", () => {
    const kept = redactHrInterviewEnterpriseRow(l1Row, false);
    assert.equal(kept.feedback_submitted, true);
    assert.equal(kept.final_outcome, "Selected");
    assert.equal(isHrInterviewRound(l1Row.round_type), false);
  });
});

describe("HR feedback confidentiality enforcement", () => {
  it("denies recruiter read when round is HR (direct API guard)", async () => {
    const pool = poolWithAssignments();
    const restore = mockPoolForEmployee([]);

    await assert.rejects(
      () =>
        assertInterviewFeedbackConfidentiality(pool, recruiterReq(), {
          roundType: "HR Round"
        }),
      (error) => {
        assert.equal(error.status, 403);
        return true;
      }
    );

    restore();
  });

  it("denies interviewer read when round is HR", async () => {
    const pool = poolWithAssignments();

    await assert.rejects(
      () =>
        assertInterviewFeedbackConfidentiality(pool, interviewerReq(), {
          roundType: "HR Interview"
        }),
      (error) => error.status === 403
    );
  });

  it("allows admin HR read", async () => {
    const pool = poolWithAssignments();

    await assertInterviewFeedbackConfidentiality(pool, adminReq(), {
      roundType: "HR Round"
    });
  });

  it("strips HR summaries for recruiter and interviewer", async () => {
    const pool = poolWithAssignments();
    const summaries = mapInterviewRowsToFeedbackSummaries(sampleRows);

    assert.equal(summaries.length, 4);

    const recruiterView = await stripHrFromFeedbackSummaries(
      summaries,
      recruiterReq(),
      pool
    );
    assert.equal(recruiterView.length, 3);
    assert.ok(recruiterView.every((row) => row.stageBucket !== "HR"));

    const interviewerView = await stripHrFromFeedbackSummaries(
      summaries,
      interviewerReq(),
      pool
    );
    assert.equal(interviewerView.length, 3);
  });

  it("admin retains HR summaries", async () => {
    const pool = poolWithAssignments();
    const summaries = mapInterviewRowsToFeedbackSummaries(sampleRows);
    const adminView = await stripHrFromFeedbackSummaries(summaries, adminReq(), pool);
    assert.equal(adminView.length, 4);
    assert.equal(await canReadHrInterviewFeedback(pool, adminReq()), true);
    assert.equal(await canReadHrInterviewFeedback(pool, recruiterReq()), false);
  });
});

describe("recruiter scheduled-session filter", () => {
  it("returns only sessions scheduled by the calling recruiter", async () => {
    const pool = poolWithAssignments();
    const summaries = mapInterviewRowsToFeedbackSummaries(sampleRows);
    const filtered = await filterFeedbackSummariesForRecruiterScheduler(
      summaries,
      recruiterReq("REC001"),
      sampleRows,
      pool
    );

    assert.equal(filtered.length, 2);
    assert.deepEqual(
      filtered.map((row) => row.scheduleId).sort(),
      [101, 104]
    );
  });

  it("keeps multiple L1 sessions as distinct entries when both are scheduler-owned", async () => {
    const pool = poolWithAssignments();
    const rows = [
      sampleRows[0],
      {
        ...sampleRows[0],
        interview_id: "INT-L1-C",
        schedule_id: 105,
        feedback_id: 5,
        feedback_outcome: "On Hold",
        final_outcome: "On Hold"
      }
    ];

    const summaries = await buildFeedbackSummariesFromRows(rows, recruiterReq("REC001"), {
      recruiterSchedulerOnly: true,
      pool
    });

    assert.equal(summaries.length, 2);
    assert.equal(summaries[0].viewFeedbackPath, "/view-feedback/101");
    assert.equal(summaries[1].viewFeedbackPath, "/view-feedback/105");
  });

  it("matches scheduler by employee code or legacy name", () => {
    assert.equal(
      isSessionScheduledByCaller(recruiterReq("REC001"), { created_by: "REC001" }),
      true
    );
    assert.equal(
      isSessionScheduledByCaller(
        {
          user: {
            role_name: "Recruiter",
            employee_code: "REC001",
            full_name: "Recruiter One"
          }
        },
        { created_by: "Recruiter One" }
      ),
      true
    );
    assert.equal(
      isSessionScheduledByCaller(recruiterReq("REC001"), { created_by: "OTHER" }),
      false
    );
  });
});

describe("interviewer permitted L1/L2 history", () => {
  it("exposes all non-HR submitted sessions for interviewer (multiple L1 interviewers)", async () => {
    const pool = poolWithAssignments();
    const summaries = await buildFeedbackSummariesFromRows(sampleRows, interviewerReq(), {
      recruiterSchedulerOnly: false,
      pool
    });

    assert.equal(summaries.length, 3);
    const l1Sessions = summaries.filter((row) => row.stageBucket === "L1");
    assert.equal(l1Sessions.length, 2);
    assert.ok(summaries.some((row) => row.stageBucket === "L2"));
    assert.ok(!summaries.some((row) => row.stageBucket === "HR"));
  });
});

describe("progress and stage group leakage guards", () => {
  it("removes HR stage groups and HR rounds from recruiter progress shapes", async () => {
    const pool = poolWithAssignments();
    const stageGroups = [
      {
        stageKey: "L1",
        sessions: [
          {
            interviewId: "INT-L1-A",
            roundType: "L1 Technical",
            sessionOutcome: "Selected",
            feedbackSubmitted: true,
            interviewStatus: "Completed",
            modifiedOn: "2026-01-02T10:00:00.000Z"
          }
        ],
        currentDecision: null
      },
      {
        stageKey: "HR",
        sessions: [
          {
            interviewId: "INT-HR",
            roundType: "HR Round",
            sessionOutcome: "Selected",
            feedbackSubmitted: true,
            interviewStatus: "Completed",
            modifiedOn: "2026-03-02T10:00:00.000Z"
          }
        ],
        currentDecision: null
      }
    ];

    const filtered = await filterStageGroupsForCaller(
      stageGroups,
      recruiterReq("REC001"),
      sampleRows,
      { recruiterSchedulerOnly: true, pool }
    );

    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].stageKey, "L1");
    assert.ok(!JSON.stringify(filtered).includes("INT-HR"));
  });

  it("preserves L1/L2 when HR exists on the same mapping", async () => {
    const pool = poolWithAssignments();
    const rounds = mapInterviewRowsToFeedbackSummaries(sampleRows).map((row) => ({
      interviewId: row.interviewId,
      roundType: row.roundType
    }));

    const filtered = await filterProgressRoundsForCaller(
      rounds,
      interviewerReq(),
      sampleRows,
      { recruiterSchedulerOnly: false, pool }
    );

    assert.equal(filtered.length, 3);
  });
});

describe("integrity — current stage decision vs history", () => {
  it("keeps older L1 feedback while newer L1 session owns current decision", () => {
    const sessions = sampleRows
      .filter((row) => row.round_type.startsWith("L1"))
      .map((row) => ({
        ...row,
        interview_status: "Completed"
      }));
    const decision = resolveCurrentStageDecision(sessions, "L1");

    assert.equal(decision.interviewId, "INT-L1-B");
    assert.equal(sessions.length, 2);
  });

  it("does not treat pending feedback as submitted history", () => {
    const pendingRow = {
      interview_id: "INT-PEND",
      schedule_id: 200,
      round_type: "L1 Technical",
      feedback_submitted: false,
      final_outcome: null,
      feedback_id: null,
      created_by: "REC001"
    };

    const summaries = mapInterviewRowsToFeedbackSummaries([pendingRow]);
    assert.equal(summaries[0].hasFeedbackRecord, false);
  });
});
