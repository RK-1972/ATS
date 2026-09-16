/**
 * Phase 6C-4 — candidate portal transactional email verification.
 * Run: node scripts/verifyPhase6c4CandidatePortalNotifications.js
 */
require("dotenv").config();

const { Pool } = require("pg");
const { REQUISITION_STATUS } = require("../constants/requisitionStatus");
const {
  createCandidatePortalService
} = require("../services/candidatePortalService");
const recruitmentService = require("../services/recruitmentService");
const candidatePortalNotificationService = require("../services/candidatePortalNotificationService");
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

async function registerPortalCandidate(emailId, fullName) {
  const password = "TestPass1!";
  const portalService = createCandidatePortalService(pool);

  const registerResult = await portalService.registerCandidateAccount({
    full_name: fullName,
    mobile_number: "9876504444",
    email_id: emailId,
    password,
    confirm_password: password
  });

  if (!registerResult.ok) {
    throw new Error(registerResult.message || "registration failed");
  }

  return {
    candidateId: registerResult.data.account.candidate_id,
    candidateContext: {
      candidate_id: registerResult.data.account.candidate_id,
      email_id: registerResult.data.account.email_id,
      full_name: registerResult.data.account.full_name
    }
  };
}

async function findOpenRequisitionWithoutActiveMapping(candidateId) {
  const result = await pool.query(
    `SELECT r.requisition_code
     FROM rm_requisitions r
     WHERE r.req_status = $1
       AND r.candidate_portal_published_at IS NOT NULL
       AND NOT EXISTS (
         SELECT 1
         FROM rm_candidate_mappings m
         WHERE m.candidate_id = $2
           AND m.requisition_code = r.requisition_code
       )
     ORDER BY r.created_on DESC
     LIMIT 1`,
    [REQUISITION_STATUS.APPROVED, candidateId]
  );

  return result.rows[0]?.requisition_code || null;
}

async function resolveAdminUser() {
  const result = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name, secondary_role, full_name
     FROM user_mstr
     WHERE role_name = 'Admin'
       AND COALESCE(is_active, TRUE) = TRUE
     ORDER BY user_id
     LIMIT 1`
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
    `SELECT event_key, recipient, status, metadata, error_code
     FROM notification_deliveries
     WHERE correlation_id = $1
     LIMIT 1`,
    [correlationId]
  );

  return result.rows[0] || null;
}

async function cleanupCandidate(candidateId) {
  const mappingRows = await pool.query(
    `SELECT map_id, mapping_id
     FROM rm_candidate_mappings
     WHERE candidate_id = $1`,
    [candidateId]
  );

  for (const row of mappingRows.rows) {
    await pool.query(
      `DELETE FROM notification_deliveries
       WHERE correlation_id = $1
          OR correlation_id LIKE $2`,
      [
        candidatePortalNotificationService.buildApplicationSubmittedCorrelationId(
          row.mapping_id
        ),
        `portal-stage-${row.mapping_id}-%`
      ]
    );
  }

  const mapIds = mappingRows.rows
    .map((row) => row.map_id)
    .filter((value) => value != null);

  await pool.query(
    `DELETE FROM rm_pipeline_history WHERE candidate_id = $1`,
    [candidateId]
  );

  if (mapIds.length > 0) {
    await pool.query(
      `DELETE FROM candidate_req_map WHERE map_id = ANY($1::int[])`,
      [mapIds]
    );
  }

  await pool.query(`DELETE FROM candidate_req_map WHERE candidate_id = $1`, [
    candidateId
  ]);
  await pool.query(`DELETE FROM rm_candidate_mappings WHERE candidate_id = $1`, [
    candidateId
  ]);
  await pool.query(
    `DELETE FROM candidate_portal_account WHERE candidate_id = $1`,
    [candidateId]
  );
  await pool.query(`DELETE FROM cand_mstr WHERE candidate_id = $1`, [candidateId]);
}

async function main() {
  const uniqueSuffix = Date.now();
  const emailId = `portal.notify.${uniqueSuffix}@example.com`;
  let candidateId = null;
  let mappingId = null;
  let mapId = null;
  let requisitionCode = null;
  let graphCalls = 0;

  candidatePortalNotificationService.setGraphEmailDeliverer(async (message) => {
    graphCalls += 1;

    if (!message?.to || !message?.subject || !message?.html) {
      throw new Error("mock graph deliverer missing message fields");
    }
  });

  try {
    const registration = await registerPortalCandidate(
      emailId,
      "Portal Notify Candidate"
    );
    candidateId = registration.candidateId;
    const candidateContext = registration.candidateContext;

    requisitionCode = await findOpenRequisitionWithoutActiveMapping(candidateId);

    if (!requisitionCode) {
      skip("notification scenarios", "no open published requisition available");
      return;
    }

    const application = await recruitmentService.applyCandidateFromPortal(
      pool,
      candidateContext,
      { requisition_code: requisitionCode }
    );

    const mappingRow = await pool.query(
      `SELECT mapping_id, map_id, stage_name
       FROM rm_candidate_mappings
       WHERE candidate_id = $1
         AND requisition_code = $2
       LIMIT 1`,
      [candidateId, requisitionCode]
    );

    mappingId = mappingRow.rows[0]?.mapping_id;
    mapId = mappingRow.rows[0]?.map_id;

    if (!mappingId) {
      fail("mapping created for portal application");
      return;
    }

    pass("portal application created");

    const applicationCorrelation =
      candidatePortalNotificationService.buildApplicationSubmittedCorrelationId(
        mappingId
      );
    const applicationDelivery = await getDelivery(applicationCorrelation);

    if ((await countDeliveries(applicationCorrelation)) !== 1) {
      fail(
        "successful application creates one notification audit row",
        String(await countDeliveries(applicationCorrelation))
      );
    } else {
      pass("successful application creates one notification audit row");
    }

    if (applicationDelivery?.event_key !== "application_submitted") {
      fail("application notification event_key", applicationDelivery?.event_key);
    } else {
      pass("application notification event_key");
    }

    if (applicationDelivery?.recipient !== emailId) {
      fail(
        "application notification recipient",
        `${applicationDelivery?.recipient} vs ${emailId}`
      );
    } else {
      pass("application notification recipient");
    }

    if (applicationDelivery?.status !== DELIVERY_STATUS.SUCCESS) {
      fail("application notification status", applicationDelivery?.status);
    } else {
      pass("application notification status Success");
    }

    if (applicationDelivery?.metadata?.requisition_code !== requisitionCode) {
      fail("application notification metadata requisition_code");
    } else {
      pass("application notification metadata requisition_code");
    }

    let duplicateRejected = false;

    try {
      await recruitmentService.applyCandidateFromPortal(pool, candidateContext, {
        requisition_code: requisitionCode
      });
    } catch (error) {
      duplicateRejected = true;
    }

    if (!duplicateRejected) {
      fail("duplicate application rejected");
    } else {
      pass("duplicate application rejected");
    }

    if ((await countDeliveries(applicationCorrelation)) !== 1) {
      fail(
        "duplicate application does not create duplicate notification",
        String(await countDeliveries(applicationCorrelation))
      );
    } else {
      pass("duplicate application does not create duplicate notification");
    }

    const replay = await candidatePortalNotificationService.notifyApplicationSubmitted(
      pool,
      {
        candidateContext,
        application,
        mappingId
      }
    );

    if (!replay.idempotentReplay) {
      fail("repeated application correlation is idempotent replay");
    } else {
      pass("repeated application correlation is idempotent replay");
    }

    const adminUser = await resolveAdminUser();

    if (!adminUser || !mapId) {
      skip("stage_changed scenarios", "missing admin user or map_id");
      return;
    }

    await recruitmentService.updateCandidateStage(
      pool,
      mapId,
      "Screening",
      "Phase 6C-4 verify",
      mockReq(adminUser)
    );

    const stageAfterUpdate = await pool.query(
      `SELECT stage_name
       FROM rm_candidate_mappings
       WHERE mapping_id = $1`,
      [mappingId]
    );

    if (stageAfterUpdate.rows[0]?.stage_name !== "Screening") {
      fail(
        "stage update persisted before notification check",
        stageAfterUpdate.rows[0]?.stage_name
      );
    } else {
      pass("stage update persisted before notification check");
    }

    const stageCorrelation =
      candidatePortalNotificationService.buildStageChangedCorrelationId(
        mappingId,
        "SCREENING"
      );
    const stageDelivery = await getDelivery(stageCorrelation);

    if ((await countDeliveries(stageCorrelation)) !== 1) {
      const stageRows = await pool.query(
        `SELECT event_key, status, correlation_id, metadata
         FROM notification_deliveries
         WHERE metadata->>'mapping_id' = $1
           AND event_key = 'stage_changed'`,
        [String(mappingId)]
      );
      fail(
        "stage change creates one notification audit row",
        `count=${await countDeliveries(stageCorrelation)}, rows=${JSON.stringify(stageRows.rows)}`
      );
    } else {
      pass("stage change creates one notification audit row");
    }

    if (stageDelivery?.event_key !== "stage_changed") {
      fail("stage notification event_key", stageDelivery?.event_key);
    } else {
      pass("stage notification event_key");
    }

    if (stageDelivery?.metadata?.stage_name !== "Screening") {
      fail(
        "stage notification candidate-facing stage",
        stageDelivery?.metadata?.stage_name
      );
    } else {
      pass("stage notification candidate-facing stage");
    }

    candidatePortalNotificationService.setGraphEmailDeliverer(async () => {
      const error = new Error("Simulated Graph failure");
      error.code = "GRAPH_SEND_FAILED";
      throw error;
    });

    await recruitmentService.updateCandidateStage(
      pool,
      mapId,
      "Applied",
      "Phase 6C-4 forced failure",
      mockReq(adminUser)
    );

    const stageAfterFailure = await pool.query(
      `SELECT stage_name
       FROM rm_candidate_mappings
       WHERE mapping_id = $1`,
      [mappingId]
    );

    if (stageAfterFailure.rows[0]?.stage_name !== "Applied") {
      fail(
        "forced email failure still commits stage transition",
        stageAfterFailure.rows[0]?.stage_name
      );
    } else {
      pass("forced email failure still commits stage transition");
    }

    const failureCorrelation =
      candidatePortalNotificationService.buildStageChangedCorrelationId(
        mappingId,
        "APPLIED"
      );
    const failureDelivery = await getDelivery(failureCorrelation);

    if (failureDelivery?.status !== DELIVERY_STATUS.FAILED) {
      fail("forced email failure records Failed audit", failureDelivery?.status);
    } else {
      pass("forced email failure records Failed audit");
    }

    const stageReplay =
      await candidatePortalNotificationService.notifyStageChanged(pool, {
        mappingId,
        candidateId,
        requisitionCode,
        stageName: "Applied",
        positionTitle: application.title
      });

    if (!stageReplay.idempotentReplay) {
      fail("repeated stage correlation is idempotent replay");
    } else {
      pass("repeated stage correlation is idempotent replay");
    }

    if (graphCalls < 1) {
      fail("mock graph deliverer captured application email attempt");
    } else {
      pass("mock graph deliverer captured email attempts without external send");
    }
  } finally {
    candidatePortalNotificationService.clearGraphEmailDeliverer();

    if (candidateId) {
      await cleanupCandidate(candidateId);
    }

    await pool.end();
  }

  if (process.exitCode) {
    console.error("\nPhase 6C-4 candidate portal notification verification failed.");
    process.exit(process.exitCode);
  }

  console.log("\nPhase 6C-4 candidate portal notification verification passed.");
}

main().catch((error) => {
  candidatePortalNotificationService.clearGraphEmailDeliverer();
  console.error("Verification crashed:", error.message);
  process.exit(1);
});
