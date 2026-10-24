const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const recruitmentService = require("../../services/recruitmentService");
const offerManagementService = require("../../services/offerManagementService");
const candidateOfferHoldService = require("../../services/candidateOfferHoldService");
const { REQUISITION_STATUS } = require("../../constants/requisitionStatus");
const {
  mockReq,
  resolveOfferWorkspaceRecruiter,
  resolveOtherOfferWorkspaceRecruiter,
  resolveUserByEmployeeCode,
  resolveOfferRouteTestContext,
  createDisposableSubmittedOffer,
  cleanupOffer
} = require("./offerApprovalTestFixtures");
const {
  resolveIntegrationTestConfig,
  getRequiredTestDatabaseUrl,
  assertSafeTestTarget,
  parsePostgresUrl
} = require("./migrationIntegrationGuards");

const RUN_ID = `OHINT${Date.now()}`;

async function tableExists(pool, tableName) {
  const result = await pool.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = $1
     ) AS exists`,
    [tableName]
  );
  return Boolean(result.rows[0]?.exists);
}

async function assertCoreSchemaReady(pool) {
  const required = [
    "cand_mstr",
    "rm_requisitions",
    "rm_candidate_mappings",
    "rm_recruiter_assignments",
    "om_offers",
    "user_mstr",
    "pc_config_state"
  ];

  for (const table of required) {
    if (!(await tableExists(pool, table))) {
      return {
        ok: false,
        reason: `Missing required table "${table}". Run migrations through 064+ on disposable DB before offer-hold integration tests.`
      };
    }
  }

  return { ok: true };
}

async function assertOfferHoldSchemaReady(pool) {
  if (!(await tableExists(pool, "rm_candidate_offer_hold"))) {
    return {
      ok: false,
      reason:
        "rm_candidate_offer_hold is missing. Migration 065 must be applied on the disposable database."
    };
  }

  const columnCheck = await pool.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'rm_candidate_offer_hold'
       AND column_name IN ('activated_by_employee_code', 'release_recruiter_employee_code')`
  );
  const names = new Set(columnCheck.rows.map((row) => row.column_name));

  if (names.has("release_recruiter_employee_code") && !names.has("activated_by_employee_code")) {
    return {
      ok: false,
      reason:
        "rm_candidate_offer_hold has legacy column release_recruiter_employee_code without activated_by_employee_code. Use current migration 065 on a disposable database."
    };
  }

  if (!names.has("activated_by_employee_code")) {
    return {
      ok: false,
      reason:
        'rm_candidate_offer_hold is missing required column "activated_by_employee_code".'
    };
  }

  if (!(await tableExists(pool, "rm_candidate_offer_hold_event"))) {
    return {
      ok: false,
      reason: "rm_candidate_offer_hold_event is missing (migration 065 incomplete)."
    };
  }

  return { ok: true };
}

function assertDisposableTargetFromPool(pool) {
  const connectionString = String(pool?.options?.connectionString || "").trim();
  if (!connectionString) {
    throw new Error(
      "Offer Hold integration requires a Pool created with TEST_DATABASE_URL connectionString."
    );
  }

  const config = parsePostgresUrl(connectionString);
  assertSafeTestTarget(config);
  return config;
}

async function applyMigration065IfMissing(pool) {
  assertDisposableTargetFromPool(pool);

  if (await tableExists(pool, "rm_candidate_offer_hold")) {
    const schema = await assertOfferHoldSchemaReady(pool);
    if (!schema.ok) {
      throw new Error(schema.reason);
    }
    return { applied: false, reason: "already_present" };
  }

  const migrationPath = path.join(
    __dirname,
    "..",
    "..",
    "migrations",
    "065_candidate_offer_hold.sql"
  );
  const sql = fs.readFileSync(migrationPath, "utf8");
  await pool.query(sql);

  const schema = await assertOfferHoldSchemaReady(pool);
  if (!schema.ok) {
    throw new Error(schema.reason);
  }

  return { applied: true };
}

async function resolveAdminReq(pool) {
  const result = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name, full_name
     FROM user_mstr
     WHERE role_name = 'Admin' AND COALESCE(is_active, TRUE) = TRUE
     ORDER BY user_id ASC
     LIMIT 1`
  );
  const user = result.rows[0];
  if (!user) {
    throw new Error("No Admin user in disposable database for recruiter assignment.");
  }
  return mockReq(user);
}

async function approveOfferThroughChain(pool, offerId, instanceId, defaultReq) {
  for (let guard = 0; guard < 12; guard += 1) {
    const offer = await offerManagementService.getOffer(pool, offerId, defaultReq);
    if (offer.offerStatus === "Approved") {
      return offer;
    }

    const pendingTask = await pool.query(
      `SELECT t.task_id, t.title, a.assignee
       FROM wf_tasks t
       INNER JOIN wf_assignments a ON a.task_id = t.task_id AND a.active = TRUE
       WHERE t.instance_id = $1 AND LOWER(t.status) = 'pending'
       ORDER BY t.task_id ASC
       LIMIT 1`,
      [instanceId]
    );

    const row = pendingTask.rows[0];
    if (!row?.task_id) {
      throw new Error(`No pending approval task for offer ${offerId}`);
    }

    const assigneeUser = await resolveUserByEmployeeCode(pool, row.assignee);
    const assigneeReq = assigneeUser ? mockReq(assigneeUser) : defaultReq;
    await offerManagementService.approveOffer(
      pool,
      offerId,
      row.title,
      "Offer hold integration approval",
      assigneeReq
    );
  }

  throw new Error(`Offer ${offerId} did not reach Approved status`);
}

async function allocateReqId(pool) {
  const result = await pool.query(
    `SELECT GREATEST(
      COALESCE((SELECT MAX(req_id) FROM rm_requisitions WHERE req_id IS NOT NULL), 0),
      COALESCE((SELECT MAX(req_id) FROM req_mstr), 0)
    ) + 1 AS next_id`
  );
  return result.rows[0].next_id;
}

async function createSecondaryRequisition(pool, adminReq, recruiterCode, suffix) {
  const routeContext = await resolveOfferRouteTestContext(pool);
  if (!routeContext) {
    throw new Error("No OFFER approval route policy in disposable database.");
  }

  const requisitionCode = `REQ-OH-${suffix}-${RUN_ID}`;
  const reqId = await allocateReqId(pool);

  await pool.query(
    `INSERT INTO rm_requisitions (
      requisition_code, req_id, position_title, department, grade, headcount, req_status,
      budget_approved, created_by, modified_by
    ) VALUES ($1, $2, $3, $4, $5, 1, $6, 1500000, 'OH Integration', 'OH Integration')`,
    [
      requisitionCode,
      reqId,
      `OH Secondary ${suffix}`,
      routeContext.department,
      routeContext.grade,
      REQUISITION_STATUS.APPROVED
    ]
  );

  await recruitmentService.assignRecruiter(
    pool,
    requisitionCode,
    recruiterCode,
    adminReq
  );

  return { requisitionCode, reqId, routeContext };
}

/**
 * Approved offer ready for release + hold activation on source requisition.
 */
async function createOfferHoldFixture(pool, options = {}) {
  const recruiter = await resolveOfferWorkspaceRecruiter(pool);
  if (!recruiter) {
    throw new Error("No offer-workspace recruiter in disposable database.");
  }

  const adminReq = await resolveAdminReq(pool);
  const recruiterReq = mockReq(recruiter);
  const routeContext = await resolveOfferRouteTestContext(pool);
  if (!routeContext) {
    throw new Error("No OFFER approval route policy in disposable database.");
  }

  const suffix = options.suffix || "A";
  const submitted = await createDisposableSubmittedOffer(
    pool,
    recruiter,
    recruiterReq,
    adminReq,
    suffix,
    { routeContext }
  );

  await approveOfferThroughChain(
    pool,
    submitted.offerId,
    submitted.instanceId,
    recruiterReq
  );

  const offerRow = await pool.query(
    `SELECT candidate_id, requisition_code, map_id
     FROM om_offers WHERE offer_id = $1`,
    [submitted.offerId]
  );
  const candidateId = offerRow.rows[0].candidate_id;
  const sourceRequisitionCode = offerRow.rows[0].requisition_code;
  const mapId = offerRow.rows[0].map_id;

  let otherRequisition = null;
  if (options.withOtherRequisition) {
    const otherRecruiter =
      options.otherRecruiter
      || (await resolveOtherOfferWorkspaceRecruiter(pool, recruiter.employee_code));
    if (!otherRecruiter) {
      throw new Error("Second recruiter required for cross-requisition tests.");
    }
    otherRequisition = await createSecondaryRequisition(
      pool,
      adminReq,
      otherRecruiter.employee_code,
      `B-${suffix}`
    );
    otherRequisition.otherRecruiterReq = mockReq(otherRecruiter);
  }

  return {
    runId: RUN_ID,
    offerId: submitted.offerId,
    instanceId: submitted.instanceId,
    candidateId,
    sourceRequisitionCode,
    mapId,
    recruiter,
    recruiterReq,
    adminReq,
    otherRequisition
  };
}

async function countActiveHolds(pool, candidateId) {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS count
     FROM rm_candidate_offer_hold
     WHERE candidate_id = $1 AND hold_status = 'Active'`,
    [candidateId]
  );
  return result.rows[0].count;
}

async function releaseOfferAndActivateHold(pool, fixture) {
  return offerManagementService.releaseOffer(
    pool,
    fixture.offerId,
    { comment: "Integration release" },
    fixture.recruiterReq
  );
}

async function cleanupOfferHoldFixture(pool, fixture) {
  if (!fixture) {
    return;
  }

  if (fixture.candidateId) {
    await pool.query(
      `DELETE FROM rm_candidate_offer_hold_event
       WHERE hold_id IN (
         SELECT hold_id FROM rm_candidate_offer_hold WHERE candidate_id = $1
       )`,
      [fixture.candidateId]
    );
    await pool.query(
      `DELETE FROM rm_candidate_offer_hold WHERE candidate_id = $1`,
      [fixture.candidateId]
    );
  }

  if (fixture.offerId) {
    await cleanupOffer(pool, fixture.offerId);
  }

  if (fixture.otherRequisition?.requisitionCode) {
    await pool.query(
      `DELETE FROM rm_recruiter_assignments WHERE requisition_code = $1`,
      [fixture.otherRequisition.requisitionCode]
    );
    await pool.query(
      `DELETE FROM rm_requisitions WHERE requisition_code = $1`,
      [fixture.otherRequisition.requisitionCode]
    );
  }

  if (fixture.candidateId) {
    const requisitionCodes = [fixture.sourceRequisitionCode].filter(Boolean);
    if (fixture.otherRequisition?.requisitionCode) {
      requisitionCodes.push(fixture.otherRequisition.requisitionCode);
    }

    await pool.query(`DELETE FROM im_interviews WHERE candidate_id = $1`, [
      fixture.candidateId
    ]).catch(() => undefined);

    if (requisitionCodes.length) {
      await pool.query(
        `DELETE FROM rm_candidate_mappings
         WHERE candidate_id = $1
           AND requisition_code = ANY($2::varchar[])`,
        [fixture.candidateId, requisitionCodes]
      );
      await pool.query(
        `DELETE FROM candidate_req_map
         WHERE candidate_id = $1
           AND req_id IN (
             SELECT req_id FROM rm_requisitions WHERE requisition_code = ANY($2::varchar[])
           )`,
        [fixture.candidateId, requisitionCodes]
      ).catch(() => undefined);
    }

    const mappingCount = await pool.query(
      `SELECT COUNT(*)::int AS count
       FROM rm_candidate_mappings
       WHERE candidate_id = $1`,
      [fixture.candidateId]
    );
    const legacyCount = await pool.query(
      `SELECT COUNT(*)::int AS count
       FROM candidate_req_map
       WHERE candidate_id = $1`,
      [fixture.candidateId]
    ).catch(() => ({ rows: [{ count: 0 }] }));

    if (mappingCount.rows[0].count === 0 && legacyCount.rows[0].count === 0) {
      await pool.query(`DELETE FROM cand_mstr WHERE candidate_id = $1`, [
        fixture.candidateId
      ]);
    }
  }
}

function createDisposablePool() {
  resolveIntegrationTestConfig();
  return new Pool({ connectionString: getRequiredTestDatabaseUrl() });
}

module.exports = {
  RUN_ID,
  tableExists,
  assertCoreSchemaReady,
  assertOfferHoldSchemaReady,
  applyMigration065IfMissing,
  createDisposablePool,
  createOfferHoldFixture,
  releaseOfferAndActivateHold,
  countActiveHolds,
  cleanupOfferHoldFixture,
  approveOfferThroughChain,
  mockReq,
  resolveOfferWorkspaceRecruiter,
  resolveAdminReq
};
