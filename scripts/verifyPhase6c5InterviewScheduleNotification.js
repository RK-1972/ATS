/**
 * Phase 6C-5 — interview schedule notification verification.
 * Run: node scripts/verifyPhase6c5InterviewScheduleNotification.js
 */
require("dotenv").config();

const { Pool } = require("pg");
const interviewService = require("../services/interviewService");
const interviewNotificationService = require("../services/interviewNotificationService");
const interviewLegacyHandlers = require("../handlers/interviewLegacyHandlers");
const { DELIVERY_STATUS } = require("../repositories/notificationDeliveryRepository");

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

function pass(label) {
  console.log(`PASS: ${label}`);
}

function fail(label, detail) {
  console.error(`FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
  process.exitCode = 1;
}

function skip(label, detail) {
  console.log(`SKIP: ${label}${detail ? ` — ${detail}` : ""}`);
}

function mockReq(user) {
  return { user };
}

function mockRes() {
  const res = {
    statusCode: 200,
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

  return res;
}

async function tableExists(tableName) {
  const result = await pool.query(
    `SELECT EXISTS (
       SELECT 1
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = $1
     ) AS exists`,
    [tableName]
  );

  return Boolean(result.rows[0]?.exists);
}

async function resolveRecruiterUser() {
  const result = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name, full_name
     FROM user_mstr
     WHERE role_name IN ('Recruiter', 'Admin')
       AND COALESCE(is_active, TRUE) = TRUE
     ORDER BY CASE WHEN role_name = 'Recruiter' THEN 0 ELSE 1 END, user_id
     LIMIT 1`
  );

  return result.rows[0] || null;
}

async function resolvePanelMember() {
  const result = await pool.query(
    `SELECT panel_id, interviewer_name, email_id
     FROM interview_panel_mstr
     WHERE COALESCE(is_active, TRUE) = TRUE
     ORDER BY panel_id
     LIMIT 1`
  );

  return result.rows[0] || null;
}

async function resolveInterviewRoundType() {
  const fromMaster = await pool.query(
    `SELECT name
     FROM md_records
     WHERE entity_type = 'interview_types'
       AND COALESCE(is_deleted, FALSE) = FALSE
     ORDER BY name ASC
     LIMIT 1`
  );

  if (fromMaster.rows[0]?.name) {
    return fromMaster.rows[0].name;
  }

  const fromExisting = await pool.query(
    `SELECT round_type
     FROM im_interviews
     WHERE round_type IS NOT NULL
     ORDER BY interview_id DESC
     LIMIT 1`
  );

  return fromExisting.rows[0]?.round_type || null;
}

async function resolveScheduleFixture(recruiterCode) {
  const params = [];
  let assignmentJoin = "";

  if (recruiterCode) {
    assignmentJoin = `
     INNER JOIN rm_recruiter_assignments a
       ON a.requisition_code = m.requisition_code
      AND a.is_active = TRUE
      AND a.recruiter_code = $1`;
    params.push(recruiterCode);
  }

  const result = await pool.query(
    `SELECT
       m.map_id,
       m.mapping_id,
       m.req_id,
       m.candidate_id,
       cm.email_id AS candidate_email,
       CONCAT(cm.first_name, ' ', cm.last_name) AS candidate_name
     FROM rm_candidate_mappings m
     INNER JOIN cand_mstr cm ON cm.candidate_id = m.candidate_id
     ${assignmentJoin}
     WHERE m.is_active = TRUE
       AND m.map_id IS NOT NULL
       AND COALESCE(cm.email_id, '') <> ''
       AND COALESCE(m.stage_name, '') NOT LIKE '%Interview Scheduled%'
     ORDER BY m.modified_on DESC NULLS LAST
     LIMIT 1`,
    params
  );

  return result.rows[0] || null;
}

async function countDeliveries(correlationId) {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS count
     FROM notification_deliveries
     WHERE correlation_id = $1`,
    [correlationId]
  );

  return result.rows[0]?.count || 0;
}

async function getDelivery(correlationId) {
  const result = await pool.query(
    `SELECT event_key, recipient, status, template_key, correlation_id, metadata, error_code
     FROM notification_deliveries
     WHERE correlation_id = $1
     LIMIT 1`,
    [correlationId]
  );

  return result.rows[0] || null;
}

async function readEmailChannelEnabled() {
  const result = await pool.query(
    `SELECT enabled
     FROM pc_notification_channels
     WHERE channel_key = 'email'
     LIMIT 1`
  );

  return result.rows[0]?.enabled;
}

async function setEmailChannelEnabled(enabled) {
  await pool.query(
    `UPDATE pc_notification_channels
     SET enabled = $1
     WHERE channel_key = 'email'`,
    [enabled]
  );
}

async function cleanupInterviewArtifacts(interviewId, correlationId) {
  if (correlationId) {
    await pool.query(
      `DELETE FROM notification_deliveries WHERE correlation_id = $1`,
      [correlationId]
    );
  }

  if (!interviewId) {
    return;
  }

  await pool.query(`DELETE FROM im_panel_assignments WHERE interview_id = $1`, [
    interviewId
  ]);
  await pool.query(`DELETE FROM im_interview_history WHERE interview_id = $1`, [
    interviewId
  ]).catch(() => undefined);
  await pool.query(`DELETE FROM et_tasks WHERE business_object_id = $1`, [
    interviewId
  ]).catch(() => undefined);

  const interviewRow = await pool.query(
    `SELECT schedule_id, workflow_instance_id
     FROM im_interviews
     WHERE interview_id = $1`,
    [interviewId]
  );
  const scheduleId = interviewRow.rows[0]?.schedule_id;
  const workflowInstanceId = interviewRow.rows[0]?.workflow_instance_id;

  if (scheduleId && (await tableExists("interview_schedule_trn"))) {
    await pool.query(`DELETE FROM interview_schedule_trn WHERE schedule_id = $1`, [
      scheduleId
    ]);
  }

  await pool.query(`DELETE FROM im_interviews WHERE interview_id = $1`, [
    interviewId
  ]);

  if (workflowInstanceId) {
    await pool.query(`DELETE FROM wf_stage_history WHERE instance_id = $1`, [
      workflowInstanceId
    ]).catch(() => undefined);
    await pool.query(`DELETE FROM wf_instances WHERE instance_id = $1`, [
      workflowInstanceId
    ]).catch(() => undefined);
  }
}

async function scheduleInterviewFixture(fixture, panel, roundType, recruiter, remarks) {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 3);
  const interviewDate = tomorrow.toISOString().slice(0, 10);

  const result = await interviewService.scheduleInterview(
    pool,
    {
      map_id: fixture.map_id,
      req_id: fixture.req_id,
      interviewer_id: panel.panel_id,
      round_type: roundType,
      interview_date: interviewDate,
      interview_time: "11:00",
      interviewer_name: panel.interviewer_name,
      interviewer_email: panel.email_id,
      remarks
    },
    mockReq(recruiter)
  );

  return {
    ...result,
    interviewDate,
    interviewTime: "11:00"
  };
}

async function main() {
  if (!(await tableExists("notification_deliveries"))) {
    skip("schema checks", "notification_deliveries missing — run migrate:notification-deliveries");
    await pool.end();
    return;
  }

  let recruiter = await resolveRecruiterUser();
  const panel = await resolvePanelMember();
  const roundType = await resolveInterviewRoundType();
  let fixture = recruiter?.role_name === "Recruiter"
    ? await resolveScheduleFixture(recruiter.employee_code)
    : await resolveScheduleFixture();

  if (!fixture && recruiter?.role_name === "Recruiter") {
    const adminResult = await pool.query(
      `SELECT user_id, employee_code, email_id, role_name, full_name
       FROM user_mstr
       WHERE role_name = 'Admin'
         AND COALESCE(is_active, TRUE) = TRUE
       ORDER BY user_id ASC
       LIMIT 1`
    );
    if (adminResult.rows[0]) {
      recruiter = adminResult.rows[0];
      fixture = await resolveScheduleFixture();
    }
  }

  if (!recruiter) {
    skip("interview schedule notification", "no recruiter/admin user fixture");
    await pool.end();
    return;
  }

  if (!panel) {
    skip("interview schedule notification", "no interview_panel_mstr fixture");
    await pool.end();
    return;
  }

  if (!roundType) {
    skip("interview schedule notification", "no interview_types fixture");
    await pool.end();
    return;
  }

  if (!fixture) {
    skip("interview schedule notification", "no suitable mapping fixture");
    await pool.end();
    return;
  }

  let primaryInterviewId = null;
  let failureInterviewId = null;
  let handlerInterviewId = null;
  let handlerInterviewIdFromResponse = null;
  let handlerResponseCorrelation = null;
  let handlerCorrelation = null;
  let originalEmailEnabled = null;
  let deliverCalls = [];
  const mockSendInterviewEmail = async (...args) => {
    deliverCalls.push(args);
  };

  try {
    const scheduled = await scheduleInterviewFixture(
      fixture,
      panel,
      roundType,
      recruiter,
      "Phase 6C-5 notification verify"
    );
    primaryInterviewId = scheduled.interviewId;

    const correlationId =
      interviewNotificationService.buildInterviewScheduledCorrelationId(
        primaryInterviewId
      );

    interviewNotificationService.setInterviewEmailDeliverer(async (...args) => {
      deliverCalls.push(args);
    });

    const notifyResult = await interviewNotificationService.notifyInterviewScheduled(
      pool,
      {
        interviewId: primaryInterviewId,
        candidateEmail: fixture.candidate_email,
        candidateName: fixture.candidate_name,
        roundType,
        interviewDate: scheduled.interviewDate,
        interviewTime: scheduled.interviewTime,
        teamsLink: "https://teams.example.test/join/interview",
        recruiterEmail: recruiter.email_id,
        mapId: fixture.map_id,
        reqId: fixture.req_id
      },
      { deliverInterviewEmail: mockSendInterviewEmail }
    );

    if ((await countDeliveries(correlationId)) !== 1) {
      fail(
        "interview schedule creates one notification audit row",
        String(await countDeliveries(correlationId))
      );
    } else {
      pass("interview schedule creates one notification audit row");
    }

    const delivery = await getDelivery(correlationId);

    if (delivery?.recipient !== fixture.candidate_email) {
      fail("notification recipient is candidate email", delivery?.recipient);
    } else {
      pass("notification recipient is candidate email");
    }

    if (delivery?.event_key !== "interview_scheduled") {
      fail("notification event_key", delivery?.event_key);
    } else {
      pass("notification event_key");
    }

    if (delivery?.template_key !== "INTERVIEW-SCHEDULED") {
      fail("notification template_key", delivery?.template_key);
    } else {
      pass("notification template_key");
    }

    if (delivery?.correlation_id !== correlationId) {
      fail("notification correlation_id", delivery?.correlation_id);
    } else {
      pass("notification correlation_id");
    }

    if (deliverCalls.length !== 1) {
      fail("mock deliver invoked once", String(deliverCalls.length));
    } else {
      pass("mock deliver invoked once");
    }

    const deliverArgs = deliverCalls[0] || [];

    const expectedCandidateEmail = String(fixture.candidate_email || "").trim();
    const expectedCandidateName = String(fixture.candidate_name || "").trim();

    if (
      deliverArgs[0] !== expectedCandidateEmail
      || deliverArgs[1] !== expectedCandidateName
      || deliverArgs[2] !== roundType
      || deliverArgs[3] !== scheduled.interviewDate
      || deliverArgs[4] !== scheduled.interviewTime
      || deliverArgs[5] !== "https://teams.example.test/join/interview"
      || deliverArgs[6] !== recruiter.email_id
    ) {
      fail(
        "mock deliver receives existing sendInterviewEmail arguments",
        JSON.stringify(deliverArgs)
      );
    } else {
      pass("mock deliver receives existing sendInterviewEmail arguments");
    }

    const replay = await interviewNotificationService.notifyInterviewScheduled(
      pool,
      {
        interviewId: primaryInterviewId,
        candidateEmail: fixture.candidate_email,
        candidateName: fixture.candidate_name,
        roundType,
        interviewDate: scheduled.interviewDate,
        interviewTime: scheduled.interviewTime,
        teamsLink: "https://teams.example.test/join/interview",
        recruiterEmail: recruiter.email_id,
        mapId: fixture.map_id,
        reqId: fixture.req_id
      },
      { deliverInterviewEmail: mockSendInterviewEmail }
    );

    if (!replay.idempotentReplay) {
      fail("repeated correlation is idempotent replay");
    } else {
      pass("repeated correlation is idempotent replay");
    }

    if (deliverCalls.length !== 1) {
      fail("idempotent replay does not re-run deliver", String(deliverCalls.length));
    } else {
      pass("idempotent replay does not re-run deliver");
    }

    if (!(await tableExists("pc_notification_channels"))) {
      skip("email disabled scenario", "pc_notification_channels missing");
    } else {
      originalEmailEnabled = await readEmailChannelEnabled();
      await setEmailChannelEnabled(false);

      deliverCalls = [];
      const disabledInterview = await scheduleInterviewFixture(
        fixture,
        panel,
        roundType,
        recruiter,
        "Phase 6C-5 email disabled verify"
      );
      failureInterviewId = disabledInterview.interviewId;

      const disabledCorrelation =
        interviewNotificationService.buildInterviewScheduledCorrelationId(
          disabledInterview.interviewId
        );

      const disabledResult =
        await interviewNotificationService.notifyInterviewScheduled(
          pool,
          {
            interviewId: disabledInterview.interviewId,
            candidateEmail: fixture.candidate_email,
            candidateName: fixture.candidate_name,
            roundType,
            interviewDate: disabledInterview.interviewDate,
            interviewTime: disabledInterview.interviewTime,
            teamsLink: null,
            recruiterEmail: recruiter.email_id,
            mapId: fixture.map_id,
            reqId: fixture.req_id
          },
          { deliverInterviewEmail: mockSendInterviewEmail }
        );

      if (disabledResult?.skipped !== true) {
        fail("email disabled skips notification orchestration");
      } else {
        pass("email disabled skips notification orchestration");
      }

      if ((await countDeliveries(disabledCorrelation)) !== 0) {
        fail(
          "email disabled creates no notification audit row",
          String(await countDeliveries(disabledCorrelation))
        );
      } else {
        pass("email disabled creates no notification audit row");
      }

      if (deliverCalls.length !== 0) {
        fail("email disabled does not invoke deliver", String(deliverCalls.length));
      } else {
        pass("email disabled does not invoke deliver");
      }

      await setEmailChannelEnabled(originalEmailEnabled);
      originalEmailEnabled = null;
    }

    interviewNotificationService.setInterviewEmailDeliverer(async () => {
      const error = new Error("Simulated interview email failure");
      error.code = "GRAPH_SEND_FAILED";
      throw error;
    });

    const failureScheduled = await scheduleInterviewFixture(
      fixture,
      panel,
      roundType,
      recruiter,
      "Phase 6C-5 forced failure verify"
    );
    const failureCorrelation =
      interviewNotificationService.buildInterviewScheduledCorrelationId(
        failureScheduled.interviewId
      );

    const failureResult = await interviewNotificationService.notifyInterviewScheduled(
      pool,
      {
        interviewId: failureScheduled.interviewId,
        candidateEmail: fixture.candidate_email,
        candidateName: fixture.candidate_name,
        roundType,
        interviewDate: failureScheduled.interviewDate,
        interviewTime: failureScheduled.interviewTime,
        teamsLink: "https://teams.example.test/join/failure",
        recruiterEmail: recruiter.email_id,
        mapId: fixture.map_id,
        reqId: fixture.req_id
      },
      { deliverInterviewEmail: mockSendInterviewEmail }
    );

    if (!failureResult.error) {
      fail("forced delivery failure returns error envelope");
    } else {
      pass("forced delivery failure returns error envelope");
    }

    const failureDelivery = await getDelivery(failureCorrelation);

    if (failureDelivery?.status !== DELIVERY_STATUS.FAILED) {
      fail("forced delivery failure records Failed audit", failureDelivery?.status);
    } else {
      pass("forced delivery failure records Failed audit");
    }

    interviewNotificationService.clearInterviewEmailDeliverer();
    deliverCalls = [];

    const handlerFixture = await scheduleInterviewFixture(
      fixture,
      panel,
      roundType,
      recruiter,
      "Phase 6C-5 handler verify"
    );
    handlerInterviewId = handlerFixture.interviewId;

    handlerCorrelation =
      interviewNotificationService.buildInterviewScheduledCorrelationId(
        handlerInterviewId
      );

    await pool.query(
      `DELETE FROM notification_deliveries WHERE correlation_id = $1`,
      [handlerCorrelation]
    );

    interviewNotificationService.setInterviewEmailDeliverer(async (...args) => {
      deliverCalls.push(args);
    });

    const handlerReq = mockReq(recruiter);
    handlerReq.body = {
      req_id: fixture.req_id,
      map_id: fixture.map_id,
      interviewer_id: panel.panel_id,
      round_type: roundType,
      interview_date: handlerFixture.interviewDate,
      interview_time: handlerFixture.interviewTime,
      remarks: "Phase 6C-5 handler notification verify"
    };

    const handlerRes = mockRes();

    await interviewLegacyHandlers.handleScheduleInterview(pool, handlerReq, handlerRes, {
      createInterviewMeeting: async () => ({
        joinUrl: "https://teams.example.test/join/handler"
      }),
      sendInterviewEmail: mockSendInterviewEmail
    });

    if (handlerRes.statusCode !== 201 || handlerRes.body?.success !== true) {
      fail(
        "handler schedule remains successful with orchestrated notification",
        `status=${handlerRes.statusCode}, success=${handlerRes.body?.success}`
      );
    } else {
      pass("handler schedule remains successful with orchestrated notification");
    }

    handlerInterviewIdFromResponse = handlerRes.body?.data?.interview_id;
    handlerResponseCorrelation =
      interviewNotificationService.buildInterviewScheduledCorrelationId(
        handlerInterviewIdFromResponse
      );
    const handlerDelivery = await getDelivery(handlerResponseCorrelation);

    if (!handlerDelivery) {
      fail("handler path writes notification audit row");
    } else {
      pass("handler path writes notification audit row");
    }

    if (deliverCalls.length < 1) {
      fail("handler path invokes deliver callback");
    } else {
      pass("handler path invokes deliver callback");
    }

    interviewNotificationService.setInterviewEmailDeliverer(async () => {
      const error = new Error("Simulated handler notification failure");
      error.code = "GRAPH_SEND_FAILED";
      throw error;
    });

    const handlerFailureReq = mockReq(recruiter);
    handlerFailureReq.body = {
      req_id: fixture.req_id,
      map_id: fixture.map_id,
      interviewer_id: panel.panel_id,
      round_type: roundType,
      interview_date: handlerFixture.interviewDate,
      interview_time: "12:30",
      remarks: "Phase 6C-5 handler failure verify"
    };

    const handlerFailureRes = mockRes();

    await interviewLegacyHandlers.handleScheduleInterview(
      pool,
      handlerFailureReq,
      handlerFailureRes,
      {
        createInterviewMeeting: async () => ({
          joinUrl: "https://teams.example.test/join/handler-failure"
        }),
        sendInterviewEmail: mockSendInterviewEmail
      }
    );

    if (handlerFailureRes.statusCode !== 201 || handlerFailureRes.body?.success !== true) {
      fail(
        "handler remains successful when notification delivery fails",
        `status=${handlerFailureRes.statusCode}`
      );
    } else {
      pass("handler remains successful when notification delivery fails");
    }

    const handlerFailureInterviewId = handlerFailureRes.body?.data?.interview_id;

    if (handlerFailureInterviewId) {
      const handlerFailureCorrelation =
        interviewNotificationService.buildInterviewScheduledCorrelationId(
          handlerFailureInterviewId
        );
      const handlerFailureDelivery = await getDelivery(handlerFailureCorrelation);

      if (handlerFailureDelivery?.status !== DELIVERY_STATUS.FAILED) {
        fail(
          "handler failure path records Failed audit",
          handlerFailureDelivery?.status
        );
      } else {
        pass("handler failure path records Failed audit");
      }

      await cleanupInterviewArtifacts(
        handlerFailureInterviewId,
        handlerFailureCorrelation
      );
    }
  } finally {
    interviewNotificationService.clearInterviewEmailDeliverer();

    if (originalEmailEnabled !== null) {
      await setEmailChannelEnabled(originalEmailEnabled).catch(() => undefined);
    }

    if (primaryInterviewId) {
      await cleanupInterviewArtifacts(
        primaryInterviewId,
        interviewNotificationService.buildInterviewScheduledCorrelationId(
          primaryInterviewId
        )
      );
    }

    if (failureInterviewId) {
      await cleanupInterviewArtifacts(failureInterviewId, null);
    }

    if (handlerInterviewId) {
      await cleanupInterviewArtifacts(handlerInterviewId, handlerCorrelation);
    }

    if (handlerInterviewIdFromResponse) {
      await cleanupInterviewArtifacts(
        handlerInterviewIdFromResponse,
        handlerResponseCorrelation
      );
    }

    await pool.end();
  }

  if (process.exitCode) {
    console.error("\nPhase 6C-5 interview schedule notification verification failed.");
    process.exit(process.exitCode);
  }

  console.log("\nPhase 6C-5 interview schedule notification verification passed.");
}

main().catch((error) => {
  interviewNotificationService.clearInterviewEmailDeliverer();
  console.error("Verification crashed:", error.message);
  process.exit(1);
});
