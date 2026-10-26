const assert = require("node:assert/strict");
const { describe, it, beforeEach, afterEach } = require("node:test");

const notificationService = require("../services/notificationService");
const offerClarificationNotificationService = require("../services/offerClarificationNotificationService");
const {
  assertCanSubmitOfferClarification
} = require("../services/offerCapabilityAuth");
const { buildOfferClarificationRounds } = require("../services/offerManagementService");

const OFFER_ID = "OFF-2026-100";
const REQUESTOR_CODE = "EMP-REQ-01";
const APPROVER_CODE = "EMP-APP-01";
const OTHER_CODE = "EMP-OTHER";

describe("offerClarificationNotificationService", () => {
  let sendCalls;
  let originalSend;

  beforeEach(() => {
    sendCalls = [];
    originalSend = notificationService.send;
    notificationService.send = async (pool, payload) => {
      sendCalls.push(payload);
      return { success: true, delivery_id: 1 };
    };
  });

  afterEach(() => {
    notificationService.send = originalSend;
  });

  it("notifies the original requester with idempotent correlation on clarification request", async () => {
    const pool = {};

    await offerClarificationNotificationService.notifyOfferClarificationRequested(pool, {
      offerId: OFFER_ID,
      requestorEmployeeCode: REQUESTOR_CODE,
      approverTaskId: 42,
      comments: "Please confirm CTC breakdown",
      candidateName: "Jane Doe",
      requisitionCode: "REQ-2026-01",
      positionTitle: "Engineer"
    });

    assert.equal(sendCalls.length, 1);
    assert.equal(sendCalls[0].recipient, REQUESTOR_CODE);
    assert.equal(sendCalls[0].event, "offer_clarification_requested");
    assert.equal(
      sendCalls[0].correlationId,
      offerClarificationNotificationService.buildRequestCorrelationId(OFFER_ID, 42)
    );
    assert.match(sendCalls[0].payload.message, /Jane Doe/);
    assert.match(sendCalls[0].payload.message, /clarification/i);
    assert.notEqual(sendCalls[0].payload.bell, true);
  });

  it("skips notification when requester or task id is missing", async () => {
    await offerClarificationNotificationService.notifyOfferClarificationRequested({}, {
      offerId: OFFER_ID,
      requestorEmployeeCode: "",
      approverTaskId: 1,
      comments: "x"
    });
    assert.equal(sendCalls.length, 0);
  });

  it("notifies approver when clarification is submitted", async () => {
    await offerClarificationNotificationService.notifyOfferClarificationSubmitted(
      {},
      {
        offerId: OFFER_ID,
        approverEmployeeCode: APPROVER_CODE,
        approverTaskId: 99,
        requestorName: "Requester User",
        candidateName: "Jane Doe",
        requisitionCode: "REQ-1"
      }
    );

    assert.equal(sendCalls.length, 1);
    assert.equal(sendCalls[0].recipient, APPROVER_CODE);
    assert.equal(sendCalls[0].event, "offer_clarification_submitted");
    assert.equal(sendCalls[0].channel, "in_app");
    assert.equal(sendCalls[0].payload.bell, true);
    assert.equal(sendCalls[0].payload.title, "Offer Clarification Received");
    assert.equal(sendCalls[0].payload.route, "/offers/pending-approvals");
    assert.match(sendCalls[0].correlationId, /^offer-clarification-submitted-/);
  });
});

describe("assertCanSubmitOfferClarification", () => {
  function poolForOffer(requestorResolvedCode) {
    return {
      query: async (sql, params) => {
        if (String(sql).includes("FROM om_offers")) {
          return {
            rows: [
              {
                offer_id: params[0],
                recruiter_id: "recruiter@example.com",
                created_by: "creator@example.com"
              }
            ]
          };
        }
        if (String(sql).includes("FROM user_mstr")) {
          return { rows: [{ employee_code: requestorResolvedCode }] };
        }
        return { rows: [] };
      }
    };
  }

  it("allows the resolved original requester", async () => {
    const pool = poolForOffer(REQUESTOR_CODE);
    const req = { user: { employee_code: REQUESTOR_CODE, role_name: "Recruiter" } };
    await assertCanSubmitOfferClarification(pool, req, OFFER_ID);
  });

  it("denies a user who is not the requester", async () => {
    const pool = poolForOffer(REQUESTOR_CODE);
    const req = { user: { employee_code: OTHER_CODE, role_name: "Recruiter" } };

    await assert.rejects(
      () => assertCanSubmitOfferClarification(pool, req, OFFER_ID),
      (error) => error.status === 403
    );
  });

  it("allows Admin without matching requester code", async () => {
    const pool = poolForOffer(REQUESTOR_CODE);
    const req = { user: { employee_code: OTHER_CODE, role_name: "Admin" } };
    await assertCanSubmitOfferClarification(pool, req, OFFER_ID);
  });
});

describe("buildOfferClarificationRounds", () => {
  it("builds multiple completed rounds plus one pending round", () => {
    const executionContext = {
      clarification_history: [
        {
          requested_by: "Approver 1",
          requested_on: "2026-01-01T00:00:00.000Z",
          comments: "Round 1 question",
          submitted_by: "Requester",
          submitted_on: "2026-01-02T00:00:00.000Z",
          response_comments: "Round 1 answer"
        },
        {
          requested_by: "Approver 1",
          requested_on: "2026-01-03T00:00:00.000Z",
          comments: "Round 2 question",
          submitted_by: "Requester",
          submitted_on: "2026-01-04T00:00:00.000Z",
          response_comments: "Round 2 answer"
        }
      ],
      clarification: {
        status: "requested",
        requested_by: "Approver 2",
        requested_on: "2026-01-05T00:00:00.000Z",
        comments: "Round 3 question"
      }
    };

    const rounds = buildOfferClarificationRounds(executionContext);
    assert.equal(rounds.length, 3);
    assert.equal(rounds[0].pending, false);
    assert.equal(rounds[1].pending, false);
    assert.equal(rounds[2].pending, true);
    assert.equal(rounds[2].request_comments, "Round 3 question");
  });

  it("ends clarification loop when no pending clarification exists", () => {
    const executionContext = {
      clarification_history: [
        {
          comments: "Q",
          response_comments: "A",
          submitted_on: "2026-01-01T00:00:00.000Z"
        }
      ],
      clarification: null
    };

    const rounds = buildOfferClarificationRounds(executionContext);
    assert.equal(rounds.length, 1);
    assert.equal(rounds.every((round) => !round.pending), true);
  });
});
