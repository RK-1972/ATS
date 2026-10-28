const assert = require("node:assert/strict");
const { describe, it, beforeEach, afterEach } = require("node:test");

const notificationService = require("../services/notificationService");
const bellNotificationService = require("../services/bellNotificationService");
const interviewNotificationService = require("../services/interviewNotificationService");

function executorFrom(query) {
  return { query };
}

describe("bellNotificationService", () => {
  let sendCalls;
  let originalSend;

  beforeEach(() => {
    sendCalls = [];
    originalSend = notificationService.send;
    notificationService.send = async (_executor, payload) => {
      sendCalls.push(payload);
      return { delivery: { deliveryId: 1 }, idempotentReplay: false };
    };
  });

  afterEach(() => {
    notificationService.send = originalSend;
  });

  it("stores outcome notifications for the resolved employee, not a second client id", async () => {
    const executor = executorFrom(async (sql, params) => {
      if (String(sql).includes("SAVEPOINT") || String(sql).includes("RELEASE")) {
        return { rows: [] };
      }
      if (String(sql).includes("FROM user_mstr")) {
        assert.equal(params[0], "Requester Name");
        return { rows: [{ employee_code: "EMP-REQ" }] };
      }
      return { rows: [] };
    });

    const result = await bellNotificationService.notifyOutcome(executor, "offer_approved", {
      recipientKey: "Requester Name",
      correlationId: "offer-approved-OFF-1-WF-1",
      message: "Offer OFF-1 was approved.",
      routeState: { offerId: "OFF-1" },
      context: { document_number: "OFF-1" }
    });

    assert.equal(result.skipped, false);
    assert.equal(sendCalls.length, 1);
    assert.equal(sendCalls[0].recipient, "EMP-REQ");
    assert.equal(sendCalls[0].channel, "in_app");
    assert.equal(sendCalls[0].event, "offer_approved");
    assert.equal(sendCalls[0].correlationId, "offer-approved-OFF-1-WF-1");
    assert.equal(sendCalls[0].payload.bell, true);
    assert.equal(sendCalls[0].payload.title, "Offer Approved");
    assert.equal(sendCalls[0].payload.route, "/offers/my-requests");
    assert.notEqual(sendCalls[0].payload.title, "Offer Approval Required");
  });

  it("does not send when the recipient cannot be resolved", async () => {
    const executor = executorFrom(async (sql) => {
      if (String(sql).includes("FROM user_mstr")) {
        return { rows: [] };
      }
      return { rows: [] };
    });

    const result = await bellNotificationService.notifyOutcome(executor, "budget_rejected", {
      recipientKey: "missing@example.com",
      correlationId: "budget-rejected-BR-1-WF-1",
      message: "Budget request BR-1 was rejected."
    });

    assert.equal(result.skipped, true);
    assert.equal(result.reason, "recipient_unresolved");
    assert.equal(sendCalls.length, 0);
  });

  it("rolls back only the notification savepoint when delivery fails", async () => {
    const statements = [];
    notificationService.send = async () => {
      throw new Error("delivery insert failed");
    };

    const executor = executorFrom(async (sql) => {
      statements.push(String(sql));
      if (String(sql).includes("FROM user_mstr")) {
        return { rows: [{ employee_code: "EMP-1" }] };
      }
      return { rows: [] };
    });

    const result = await bellNotificationService.notifyOutcome(
      executor,
      "requisition_approved",
      {
        recipientKey: "EMP-1",
        correlationId: "requisition-approved-REQ-1-WF-1",
        message: "Requisition REQ-1 was approved."
      }
    );

    assert.equal(result.skipped, true);
    assert.equal(result.reason, "delivery_failed");
    assert.equal(statements.some((sql) => sql.includes("ROLLBACK TO SAVEPOINT bell_notify")), true);
    assert.equal(statements.some((sql) => sql.includes("RELEASE SAVEPOINT")), false);
  });

  it("lists only in-app bell rows for the authenticated employee", async () => {
    const queries = [];
    const executor = executorFrom(async (sql, params) => {
      queries.push({ sql: String(sql), params });
      return {
        rows: [
          {
            delivery_id: 7,
            event_key: "offer_rejected",
            metadata: {
              bell: true,
              title: "Offer Rejected",
              message: "Offer OFF-2 was rejected.",
              category: "offer",
              route: "/offers/my-requests",
              route_state: { offerId: "OFF-2" },
              document_number: "OFF-2"
            },
            attempted_on: "2026-10-26T00:00:00.000Z"
          },
          {
            delivery_id: 8,
            event_key: "ignored",
            metadata: { bell: true },
            attempted_on: "2026-10-26T00:00:00.000Z"
          }
        ]
      };
    });

    const rows = await bellNotificationService.listBellNotifications(executor, "EMP-REQ");
    assert.equal(queries.length, 1);
    assert.match(queries[0].sql, /recipient = \$1/);
    assert.match(queries[0].sql, /channel = 'in_app'/);
    assert.match(queries[0].sql, /metadata->>'bell'/);
    assert.deepEqual(queries[0].params, ["EMP-REQ", 50]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, "Offer Rejected");
    assert.equal(rows[0].category, "offer");
  });

  it("hides clarification bell rows when the linked approval task is no longer active", async () => {
    const executor = executorFrom(async (sql, params) => {
      const text = String(sql);
      if (text.includes("FROM notification_deliveries")) {
        return {
          rows: [
            {
              delivery_id: 11,
              event_key: "offer_clarification_submitted",
              metadata: {
                bell: true,
                title: "Offer Clarification Received",
                message: "Clarification submitted.",
                category: "offer",
                route: "/offers/pending-approvals",
                route_state: { offerId: "OFF-9", taskId: 9001 },
                task_id: 9001,
                document_number: "OFF-9"
              },
              attempted_on: "2026-10-26T00:00:00.000Z"
            },
            {
              delivery_id: 12,
              event_key: "offer_approved",
              metadata: {
                bell: true,
                title: "Offer Approved",
                message: "Offer OFF-8 approved.",
                category: "offer",
                route: "/offers/my-requests",
                document_number: "OFF-8"
              },
              attempted_on: "2026-10-25T00:00:00.000Z"
            }
          ]
        };
      }
      if (text.includes("FROM wf_tasks t")) {
        assert.deepEqual(params, ["EMP-REQ", [9001]]);
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${text}`);
    });

    const rows = await bellNotificationService.listBellNotifications(executor, "EMP-REQ");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].event_key, "offer_approved");
  });

  it("keeps clarification bell rows while the linked task remains pending for the assignee", async () => {
    const executor = executorFrom(async (sql, params) => {
      const text = String(sql);
      if (text.includes("FROM notification_deliveries")) {
        return {
          rows: [
            {
              delivery_id: 21,
              event_key: "budget_clarification_submitted",
              metadata: {
                bell: true,
                title: "Budget Clarification Received",
                message: "Budget clarification submitted.",
                category: "budget",
                route: "/my-approvals",
                route_state: { budgetRequestId: "BR-1", taskId: 7001 },
                task_id: 7001,
                document_number: "BR-1"
              },
              attempted_on: "2026-10-26T00:00:00.000Z"
            }
          ]
        };
      }
      if (text.includes("FROM wf_tasks t")) {
        return { rows: [{ task_id: 7001 }] };
      }
      throw new Error(`unexpected query: ${text}`);
    });

    const rows = await bellNotificationService.listBellNotifications(executor, "EMP-REQ");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].event_key, "budget_clarification_submitted");
    assert.equal(rows[0].task_id, 7001);
  });

  it("hides interview schedule bell rows after the interview is no longer scheduled", async () => {
    const executor = executorFrom(async (sql) => {
      const text = String(sql);
      if (text.includes("FROM notification_deliveries")) {
        return {
          rows: [
            {
              delivery_id: 31,
              event_key: "interview_scheduled",
              metadata: {
                bell: true,
                title: "Interview Scheduled",
                message: "Technical interview scheduled.",
                category: "interviewScheduled",
                route: "/interviewer",
                document_number: "INT-55",
                interview_id: "INT-55"
              },
              attempted_on: "2026-10-26T00:00:00.000Z"
            }
          ]
        };
      }
      if (text.includes("FROM im_interviews")) {
        return {
          rows: [{ interview_id: "INT-55", interview_status: "Completed" }]
        };
      }
      throw new Error(`unexpected query: ${text}`);
    });

    const rows = await bellNotificationService.listBellNotifications(executor, "EMP-PANEL");
    assert.equal(rows.length, 0);
  });

  it("keeps interview schedule bell rows when the interview record is missing", async () => {
    const executor = executorFrom(async (sql) => {
      const text = String(sql);
      if (text.includes("FROM notification_deliveries")) {
        return {
          rows: [
            {
              delivery_id: 32,
              event_key: "interview_scheduled",
              metadata: {
                bell: true,
                title: "Interview Scheduled",
                message: "Technical interview scheduled.",
                category: "interviewScheduled",
                route: "/interviewer",
                document_number: "INT-MISSING",
                interview_id: "INT-MISSING"
              },
              attempted_on: "2026-10-26T00:00:00.000Z"
            }
          ]
        };
      }
      if (text.includes("FROM im_interviews")) {
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${text}`);
    });

    const rows = await bellNotificationService.listBellNotifications(executor, "EMP-PANEL");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].event_key, "interview_scheduled");
  });

  it("keeps schedule and clarification rows when eligibility lookups fail", async () => {
    const executor = executorFrom(async (sql) => {
      const text = String(sql);
      if (text.includes("FROM notification_deliveries")) {
        return {
          rows: [
            {
              delivery_id: 41,
              event_key: "offer_clarification_submitted",
              metadata: {
                bell: true,
                title: "Offer Clarification Received",
                message: "Clarification submitted.",
                category: "offer",
                route: "/offers/pending-approvals",
                task_id: 9100,
                document_number: "OFF-10"
              },
              attempted_on: "2026-10-26T00:00:00.000Z"
            },
            {
              delivery_id: 42,
              event_key: "interview_rescheduled",
              metadata: {
                bell: true,
                title: "Interview Rescheduled",
                message: "Interview moved.",
                category: "interviewScheduled",
                route: "/interviewer",
                document_number: "INT-77",
                interview_id: "INT-77"
              },
              attempted_on: "2026-10-26T00:00:00.000Z"
            },
            {
              delivery_id: 43,
              event_key: "interview_cancelled",
              metadata: {
                bell: true,
                title: "Interview Cancelled",
                message: "Interview cancelled.",
                category: "interviewScheduled",
                route: "/interviewer",
                document_number: "INT-77"
              },
              attempted_on: "2026-10-26T00:00:00.000Z"
            }
          ]
        };
      }
      if (text.includes("FROM wf_tasks t")) {
        throw new Error("task lookup unavailable");
      }
      if (text.includes("FROM im_interviews")) {
        throw new Error("interview lookup unavailable");
      }
      throw new Error(`unexpected query: ${text}`);
    });

    const rows = await bellNotificationService.listBellNotifications(executor, "EMP-REQ");
    assert.equal(rows.length, 3);
    assert.deepEqual(
      rows.map((row) => row.event_key).sort(),
      [
        "interview_cancelled",
        "interview_rescheduled",
        "offer_clarification_submitted"
      ]
    );
  });

  it("hides scheduled bell rows for cancelled interviews but keeps cancellation notices", async () => {
    const executor = executorFrom(async (sql) => {
      const text = String(sql);
      if (text.includes("FROM notification_deliveries")) {
        return {
          rows: [
            {
              delivery_id: 51,
              event_key: "interview_scheduled",
              metadata: {
                bell: true,
                title: "Interview Scheduled",
                message: "Technical interview scheduled.",
                category: "interviewScheduled",
                route: "/interviewer",
                document_number: "INT-88",
                interview_id: "INT-88"
              },
              attempted_on: "2026-10-26T00:00:00.000Z"
            },
            {
              delivery_id: 52,
              event_key: "interview_cancelled",
              metadata: {
                bell: true,
                title: "Interview Cancelled",
                message: "Interview cancelled.",
                category: "interviewScheduled",
                route: "/interviewer",
                document_number: "INT-88"
              },
              attempted_on: "2026-10-26T00:00:00.000Z"
            }
          ]
        };
      }
      if (text.includes("FROM im_interviews")) {
        return {
          rows: [{ interview_id: "INT-88", interview_status: "Cancelled" }]
        };
      }
      throw new Error(`unexpected query: ${text}`);
    });

    const rows = await bellNotificationService.listBellNotifications(executor, "EMP-PANEL");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].event_key, "interview_cancelled");
  });

  it("rejects a bell list without an employee code before querying", async () => {
    await assert.rejects(
      () => bellNotificationService.listBellNotifications({
        query: async () => {
          throw new Error("should not query");
        }
      }, " "),
      (error) => error.status === 401
    );
  });

  it("uses distinct outcome titles for approval, rejection, and clarification", () => {
    const outcomes = bellNotificationService.BELL_OUTCOMES;
    assert.equal(outcomes.offer_approved.title, "Offer Approved");
    assert.equal(outcomes.offer_rejected.title, "Offer Rejected");
    assert.equal(outcomes.offer_clarification_submitted.title, "Offer Clarification Received");
    assert.equal(outcomes.budget_approved.title, "Budget Approved");
    assert.equal(outcomes.budget_clarification_submitted.title, "Budget Clarification Received");
    assert.equal(outcomes.requisition_approved.title, "Requisition Approved");
    assert.equal(outcomes.requisition_clarification_submitted.title, "Requisition Clarification Received");
    assert.equal(outcomes.interview_scheduled.title, "Interview Scheduled");
    assert.equal(outcomes.interview_rescheduled.title, "Interview Rescheduled");
    assert.equal(outcomes.interview_cancelled.title, "Interview Cancelled");
    assert.equal(outcomes.ownership_approved.title, "Ownership Request Approved");
    assert.equal(outcomes.ownership_rejected.title, "Ownership Request Rejected");
    assert.equal(outcomes.requisition_assigned.title, "Requisition Assigned");
    assert.equal(outcomes.feedback_submitted.title, "Interview Feedback Submitted");
  });
});

describe("interview bell recipients", () => {
  let sendCalls;
  let originalSend;

  beforeEach(() => {
    sendCalls = [];
    originalSend = notificationService.send;
    notificationService.send = async (_executor, payload) => {
      sendCalls.push(payload);
      return { delivery: { deliveryId: 2 }, idempotentReplay: false };
    };
  });

  afterEach(() => {
    notificationService.send = originalSend;
  });

  function interviewExecutor() {
    return executorFrom(async (sql) => {
      const text = String(sql);
      if (text.includes("SAVEPOINT") || text.includes("RELEASE") || text.includes("ROLLBACK")) {
        return { rows: [] };
      }
      if (text.includes("FROM im_interviews")) {
        return {
          rows: [{
            interview_id: "INT-1",
            round_type: "Technical",
            interview_date: "2026-10-27",
            interview_time: "10:00",
            schedule_id: 15,
            created_by: "EMP-REC",
            first_name: "Ada",
            last_name: "Lovelace"
          }]
        };
      }
      if (text.includes("FROM im_panel_assignments") && text.includes("user_mstr")) {
        return {
          rows: [
            { employee_code: "EMP-PANEL" },
            { employee_code: "EMP-ACTOR" }
          ]
        };
      }
      if (text.includes("interview_panel_mstr")) {
        return { rows: [] };
      }
      if (text.includes("FROM user_mstr")) {
        return { rows: [{ employee_code: "EMP-REC" }] };
      }
      return { rows: [] };
    });
  }

  it("notifies panel employees except the actor and does not send email", async () => {
    const result = await interviewNotificationService.notifyInterviewParticipants(
      interviewExecutor(),
      {
        interviewId: "INT-1",
        outcomeKey: "interview_scheduled",
        actorEmployeeCode: "EMP-ACTOR"
      }
    );

    assert.equal(result.skipped, false);
    assert.equal(sendCalls.length, 1);
    assert.equal(sendCalls[0].recipient, "EMP-PANEL");
    assert.equal(sendCalls[0].channel, "in_app");
    assert.equal(sendCalls[0].event, "interview_scheduled");
    assert.equal(sendCalls[0].correlationId, "interview_scheduled-bell-INT-1-EMP-PANEL");
    assert.equal(sendCalls[0].payload.title, "Interview Scheduled");
    assert.match(sendCalls[0].payload.message, /Ada Lovelace/);
    assert.equal(sendCalls[0].payload.route, "/interviewer");
  });

  it("notifies the interview creator when a different person submits feedback", async () => {
    const result = await interviewNotificationService.notifyFeedbackSubmitted(
      interviewExecutor(),
      {
        interviewId: "INT-1",
        scheduleId: 15,
        actorEmployeeCode: "EMP-PANEL"
      }
    );

    assert.equal(result.skipped, false);
    assert.equal(sendCalls.length, 1);
    assert.equal(sendCalls[0].recipient, "EMP-REC");
    assert.equal(sendCalls[0].event, "feedback_submitted");
    assert.equal(sendCalls[0].correlationId, "feedback-submitted-INT-1");
    assert.equal(sendCalls[0].payload.route, "/view-feedback/15");
    assert.equal(sendCalls[0].payload.title, "Interview Feedback Submitted");
  });

  it("does not notify the submitter about their own feedback", async () => {
    const result = await interviewNotificationService.notifyFeedbackSubmitted(
      interviewExecutor(),
      {
        interviewId: "INT-1",
        scheduleId: 15,
        actorEmployeeCode: "EMP-REC"
      }
    );

    assert.equal(result.skipped, true);
    assert.equal(result.reason, "no_distinct_recipient");
    assert.equal(sendCalls.length, 0);
  });
});
