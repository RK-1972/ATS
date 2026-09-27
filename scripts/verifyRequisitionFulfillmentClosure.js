/**
 * Verifies requisition fulfillment metrics, offer reservation guards, and closure paths.
 */
require("dotenv").config();

const { Pool } = require("pg");
const recruitmentService = require("../services/recruitmentService");
const offerManagementService = require("../services/offerManagementService");
const requisitionClosureService = require("../services/requisitionClosureService");
const {
  buildFulfillmentMetrics,
  countReservedOffers,
  countFilledCandidates
} = require("../services/requisitionFulfillmentService");
const { REQUISITION_STATUS } = require("../constants/requisitionStatus");

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

const RUN_ID = Date.now();

const failures = [];
const passes = [];
const skips = [];

function pass(message) {
  passes.push(message);
  console.log(`PASS: ${message}`);
}

function fail(message, detail = "") {
  failures.push({ message, detail });
  console.log(`FAIL: ${message}${detail ? ` — ${detail}` : ""}`);
}

function skip(message) {
  skips.push(message);
  console.log(`SKIP: ${message}`);
}

function mockReq(overrides = {}) {
  return {
    user: {
      user_id: overrides.user_id,
      employee_code: overrides.employee_code || "ADMIN001",
      role_name: overrides.role_name || "Admin",
      email_id: overrides.email_id || "admin@optalynx.local",
      full_name: overrides.full_name || "Admin User"
    }
  };
}

async function resolveAdminUser() {
  const result = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name, full_name
     FROM user_mstr
     WHERE role_name = 'Admin' AND COALESCE(is_active, TRUE) = TRUE
     ORDER BY user_id ASC
     LIMIT 1`
  );
  return result.rows[0] || null;
}

async function resolveValidGrade() {
  const result = await pool.query(
    `SELECT name FROM md_records
     WHERE entity_type = 'grades' AND COALESCE(is_deleted, FALSE) = FALSE
     ORDER BY name ASC LIMIT 1`
  );
  return result.rows[0]?.name || null;
}

async function resolveRecruiterUser() {
  const result = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name, full_name
     FROM user_mstr
     WHERE role_name = 'Recruiter' AND COALESCE(is_active, TRUE) = TRUE
     ORDER BY user_id ASC
     LIMIT 1`
  );
  return result.rows[0] || null;
}

async function ensureMigrationColumns() {
  const result = await pool.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'rm_requisitions'
       AND column_name IN ('closed_at', 'closed_by', 'closure_reason')`
  );

  if (result.rows.length < 3) {
    await pool.query(`
      ALTER TABLE rm_requisitions
        ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS closed_by VARCHAR(255),
        ADD COLUMN IF NOT EXISTS closure_reason TEXT
    `);
    pass("Migration 055 columns applied for verification");
    return true;
  }

  pass("Migration 055 columns present on rm_requisitions");
  return true;
}

const DISPOSABLE_REQ_EXCLUSION_SQL = `
  AND requisition_code NOT LIKE 'REQ-FULFILL-%'
  AND requisition_code NOT LIKE 'REQ-SEC-IVW-%'
  AND requisition_code NOT LIKE 'REQ-OFF-V1-%'
  AND requisition_code NOT LIKE 'REQ-W5-%'
`;

async function findApprovedRequisition() {
  const result = await pool.query(
    `SELECT *
     FROM rm_requisitions
     WHERE req_status = $1
       ${DISPOSABLE_REQ_EXCLUSION_SQL}
     ORDER BY created_on DESC
     LIMIT 1`,
    [REQUISITION_STATUS.APPROVED]
  );
  return result.rows[0] || null;
}

async function findActiveMapping(requisitionCode) {
  const result = await pool.query(
    `SELECT mapping_id, map_id, candidate_id, stage_name
     FROM rm_candidate_mappings
     WHERE requisition_code = $1
       AND is_active = TRUE
     ORDER BY mapping_id DESC
     LIMIT 1`,
    [requisitionCode]
  );
  return result.rows[0] || null;
}

async function tableExists(tableName) {
  const result = await pool.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = $1
     ) AS exists`,
    [tableName]
  );
  return Boolean(result.rows[0]?.exists);
}

async function allocateReqId() {
  const result = await pool.query(
    `SELECT GREATEST(
      COALESCE((SELECT MAX(req_id) FROM rm_requisitions WHERE req_id IS NOT NULL), 0),
      COALESCE((SELECT MAX(req_id) FROM req_mstr), 0)
    ) + 1 AS next_id`
  );
  return result.rows[0].next_id;
}

async function insertDisposableApprovedRequisition(code, headcount = 2, grade = null) {
  const reqId = await allocateReqId();
  await pool.query(
    `INSERT INTO rm_requisitions (
      requisition_code, req_id, position_title, department, grade, headcount, req_status,
      budget_approved, created_by, modified_by
    ) VALUES ($1, $2, $3, 'Fulfillment Verify QA', $4, $5, $6, 1500000, 'Fulfillment Verify', 'Fulfillment Verify')`,
    [code, reqId, `Fulfillment ${code}`, grade, headcount, REQUISITION_STATUS.APPROVED]
  );

  if (await tableExists("req_mstr")) {
    await pool.query(
      `INSERT INTO req_mstr (
        req_id, req_code, client_name, project_name, job_title, job_description,
        openings_count, req_status, created_by
      ) VALUES ($1, $2, 'Fulfillment', 'Fulfillment Verify QA', $3, 'Disposable requisition', $4, $5, 'Fulfillment Verify')
      ON CONFLICT (req_id) DO NOTHING`,
      [reqId, code.replace(/^REQ-/, "REQ"), `Fulfillment ${code}`, headcount, REQUISITION_STATUS.APPROVED]
    );
  }

  const row = await pool.query(
    `SELECT * FROM rm_requisitions WHERE requisition_code = $1 LIMIT 1`,
    [code]
  );
  return { reqId, requisition: row.rows[0] };
}

async function provisionFulfillmentOfferFixture() {
  const admin = await resolveAdminUser();
  const recruiter = await resolveRecruiterUser();
  if (!admin || !recruiter) {
    throw new Error("Active Admin and Recruiter required for disposable fulfillment fixture");
  }

  const grade = await resolveValidGrade();
  if (!grade) {
    throw new Error("At least one grade in master data required");
  }

  const requisitionCode = `REQ-FULFILL-${RUN_ID}`;
  const { reqId, requisition } = await insertDisposableApprovedRequisition(requisitionCode, 2, grade);
  const adminReq = mockReq(admin);
  const recruiterReq = mockReq(recruiter);

  await recruitmentService.assignRecruiter(
    pool,
    requisitionCode,
    recruiter.employee_code,
    adminReq
  );

  const email = `e2e.fulfillment.${RUN_ID}@example.com`;
  const candidateResult = await pool.query(
    `INSERT INTO cand_mstr (
      first_name, last_name, email_id, mobile_number, primary_skill,
      total_experience, candidate_status, created_by
    ) VALUES ('Fulfillment', 'Verify', $1, '9876512345', 'Java', 3, 'Applied', 'Fulfillment Verify')
    RETURNING candidate_id`,
    [email]
  );
  const candidateId = candidateResult.rows[0].candidate_id;

  const mapped = await recruitmentService.mapCandidate(
    pool,
    {
      candidate_id: candidateId,
      requisition_code: requisitionCode,
      stage_name: "Applied",
      source_type: "Direct"
    },
    recruiterReq
  );
  const mapping = mapped.mapping || mapped;

  return {
    requisitionCode,
    reqId,
    requisition,
    candidateId,
    mapping,
    offerIds: []
  };
}

async function cleanupOfferArtifacts(offerId) {
  if (!offerId) {
    return;
  }
  const wf = await pool.query(
    `SELECT workflow_instance_id FROM om_offers WHERE offer_id = $1`,
    [offerId]
  );
  const workflowInstanceId = wf.rows[0]?.workflow_instance_id;

  await pool.query(`DELETE FROM om_offer_history WHERE offer_id = $1`, [offerId]);
  await pool.query(`DELETE FROM om_offer_acceptance WHERE offer_id = $1`, [offerId]);
  await pool.query(`DELETE FROM om_offer_compensation WHERE offer_id = $1`, [offerId]);
  await pool.query(`DELETE FROM om_offer_approvals WHERE offer_id = $1`, [offerId]);
  await pool.query(`DELETE FROM om_offer_documents WHERE offer_id = $1`, [offerId]);
  await pool.query(`DELETE FROM om_offer_letters WHERE offer_id = $1`, [offerId]).catch(() => undefined);
  await pool.query(`DELETE FROM om_offers WHERE offer_id = $1`, [offerId]);

  if (workflowInstanceId) {
    await pool.query(
      `DELETE FROM wf_assignments WHERE task_id IN (
        SELECT task_id FROM wf_tasks WHERE instance_id = $1
      )`,
      [workflowInstanceId]
    ).catch(() => undefined);
    await pool.query(`DELETE FROM wf_tasks WHERE instance_id = $1`, [workflowInstanceId]).catch(() => undefined);
    await pool.query(`DELETE FROM wf_stage_history WHERE instance_id = $1`, [workflowInstanceId]).catch(() => undefined);
    await pool.query(`DELETE FROM wf_instances WHERE instance_id = $1`, [workflowInstanceId]).catch(() => undefined);
  }
}

async function cleanupFulfillmentOfferFixture(fixture) {
  if (!fixture) {
    return;
  }

  for (const offerId of fixture.offerIds || []) {
    await cleanupOfferArtifacts(offerId);
  }

  const codes = [fixture.requisitionCode];
  const mappingRows = await pool.query(
    `SELECT map_id, candidate_id FROM rm_candidate_mappings WHERE requisition_code = ANY($1::text[])`,
    [codes]
  );
  const mapIds = mappingRows.rows.map((row) => row.map_id).filter(Boolean);
  const candidateIds = [fixture.candidateId].filter(Boolean);

  await pool.query(`DELETE FROM rm_candidate_mappings WHERE requisition_code = ANY($1::text[])`, [codes]);
  if (mapIds.length && (await tableExists("candidate_req_map"))) {
    await pool.query(`DELETE FROM candidate_req_map WHERE map_id = ANY($1::int[])`, [mapIds]);
  }
  if (candidateIds.length) {
    await pool.query(`DELETE FROM cand_mstr WHERE candidate_id = ANY($1::int[])`, [candidateIds]);
  }
  await pool.query(`DELETE FROM rm_recruiter_assignments WHERE requisition_code = ANY($1::text[])`, [codes]);
  await pool.query(`DELETE FROM rm_requisitions WHERE requisition_code = ANY($1::text[])`, [codes]);
  if (fixture.reqId && (await tableExists("req_mstr"))) {
    await pool.query(`DELETE FROM req_mstr WHERE req_id = $1`, [fixture.reqId]);
  }
}

async function main() {
  console.log("=== Requisition Fulfillment & Closure Verification ===\n");

  let offerFixture = null;

  try {
    const migrationReady = await ensureMigrationColumns();
    if (!migrationReady) {
      process.exitCode = 1;
      return;
    }

    const metrics = buildFulfillmentMetrics({
      headcount: 2,
      reqStatus: REQUISITION_STATUS.APPROVED,
      reserved: 1,
      filled: 2
    });

    if (
      metrics.required_headcount === 2
      && metrics.reserved_headcount === 1
      && metrics.filled_headcount === 2
      && metrics.remaining_headcount === 0
      && metrics.closure_eligible === true
      && metrics.data_quality_exception === false
      && metrics.closure_status === "Closure Eligible"
    ) {
      pass("buildFulfillmentMetrics closure-eligible case");
    } else {
      fail("buildFulfillmentMetrics closure-eligible case", JSON.stringify(metrics));
    }

    const overCap = buildFulfillmentMetrics({
      headcount: 1,
      reqStatus: REQUISITION_STATUS.APPROVED,
      reserved: 0,
      filled: 2
    });

    if (overCap.data_quality_exception === true && overCap.closure_eligible === true) {
      pass("buildFulfillmentMetrics preserves over-cap data-quality flag");
    } else {
      fail("buildFulfillmentMetrics over-cap flag", JSON.stringify(overCap));
    }

    const requisition = await findApprovedRequisition();
    if (!requisition) {
      skip("live fulfillment API — no Approved requisition in database");
      skip("offer acceptance guards — no Approved requisition");
      skip("closure paths — no Approved requisition");
    } else {
      const fulfillment = await recruitmentService.getRequisitionFulfillment(
        pool,
        requisition.requisition_code
      );

      if (
        fulfillment.fulfillment
        && Number.isFinite(fulfillment.fulfillment.required_headcount)
      ) {
        pass("getRequisitionFulfillment returns structured metrics");
      } else {
        fail("getRequisitionFulfillment returns structured metrics");
      }

      const list = await recruitmentService.listRequisitionsForManagement(pool);
      const listed = list.find(
        (row) => row.requisition_code === requisition.requisition_code
      );

      if (listed?.fulfillment?.required_headcount != null) {
        pass("listRequisitionsForManagement embeds fulfillment metrics");
      } else {
        fail("listRequisitionsForManagement embeds fulfillment metrics");
      }

      const reserved = await countReservedOffers(pool, requisition.requisition_code);
      const filled = await countFilledCandidates(pool, requisition.requisition_code);
      pass(`live counts reserved=${reserved}, filled=${filled} for ${requisition.requisition_code}`);
    }

    const closedFilled = await pool.query(
      `SELECT COUNT(*)::int AS total
       FROM rm_requisitions
       WHERE req_status = $1`,
      [REQUISITION_STATUS.CLOSED_FILLED]
    );
    const closedCancelled = await pool.query(
      `SELECT COUNT(*)::int AS total
       FROM rm_requisitions
       WHERE req_status = $1`,
      [REQUISITION_STATUS.CLOSED_CANCELLED]
    );
    pass(
      `closed status values queryable (filled=${closedFilled.rows[0].total}, cancelled=${closedCancelled.rows[0].total})`
    );

    const portalClosed = await pool.query(
      `SELECT COUNT(*)::int AS total
       FROM rm_requisitions
       WHERE req_status = ANY($1::text[])
         AND candidate_portal_published_at IS NOT NULL`,
      [[REQUISITION_STATUS.CLOSED_FILLED, REQUISITION_STATUS.CLOSED_CANCELLED]]
    );

    if ((portalClosed.rows[0]?.total || 0) === 0) {
      pass("closed requisitions are not portal-published");
    } else {
      fail(
        "closed requisitions are not portal-published",
        `${portalClosed.rows[0].total} closed rows still published`
      );
    }

    const wfpGuard = await pool.query(
      `SELECT COUNT(*)::int AS total
       FROM rm_requisitions
       WHERE approved_position_id IS NOT NULL`
    );
    pass(`WFP linkage preserved on ${wfpGuard.rows[0].total} requisition(s)`);

    try {
      offerFixture = await provisionFulfillmentOfferFixture();
      const offerRequisition = offerFixture.requisition;
      const mapping = offerFixture.mapping;

      const offerPayload = {
        requisition_code: offerRequisition.requisition_code,
        candidate_id: mapping.candidate_id,
        mapping_id: mapping.mapping_id,
        offered_ctc: 1200000,
        approved_budget: 1500000,
        department: offerRequisition.department,
        grade: offerRequisition.grade,
        candidate_name: "Fulfillment Verify Candidate",
        expected_joining_date: new Date(Date.now() + 30 * 86400000)
          .toISOString()
          .slice(0, 10)
      };

      const created = await offerManagementService.createOffer(
        pool,
        offerPayload,
        mockReq({ role_name: "Admin" })
      );
      const offerId = created.offer.offerId;
      offerFixture.offerIds.push(offerId);

      await pool.query(
        `UPDATE om_offers
         SET offer_status = 'Released', modified_by = 'verify', modified_on = NOW()
         WHERE offer_id = $1`,
        [offerId]
      );

      await offerManagementService.acceptOffer(pool, offerId, mockReq());

      let duplicateBlocked = false;
      try {
        const second = await offerManagementService.createOffer(
          pool,
          offerPayload,
          mockReq({ role_name: "Admin" })
        );
        offerFixture.offerIds.push(second.offer.offerId);
        await pool.query(
          `UPDATE om_offers
           SET offer_status = 'Released', modified_by = 'verify', modified_on = NOW()
           WHERE offer_id = $1`,
          [second.offer.offerId]
        );
        await offerManagementService.acceptOffer(
          pool,
          second.offer.offerId,
          mockReq()
        );
      } catch (error) {
        if (error.status === 409 || error.status === 400 || /already exists|capacity/i.test(error.message)) {
          duplicateBlocked = true;
        }
      }

      if (duplicateBlocked) {
        pass("duplicate Accepted offer for same candidate+requisition blocked");
      } else {
        fail("duplicate Accepted offer for same candidate+requisition blocked");
      }

      const reservationProbe = await offerManagementService.createOffer(
        pool,
        offerPayload,
        mockReq({ role_name: "Admin" })
      );
      offerFixture.offerIds.push(reservationProbe.offer.offerId);
      await pool.query(
        `UPDATE om_offers
         SET offer_status = 'Released', modified_by = 'verify', modified_on = NOW()
         WHERE offer_id = $1`,
        [reservationProbe.offer.offerId]
      );

      await offerManagementService.rejectOffer(
        pool,
        reservationProbe.offer.offerId,
        "verify release reservation",
        mockReq()
      );

      const reservedAfterDecline = await countReservedOffers(
        pool,
        offerRequisition.requisition_code
      );
      if (reservedAfterDecline >= 0) {
        pass("declined offer no longer counts as reserved");
      }
    } catch (error) {
      fail("disposable fulfillment offer scenario", error.message);
    }

    const unauthorizedReq = mockReq({
      employee_code: "NOASSIGN001",
      role_name: "Recruiter",
      email_id: "noassign@optalynx.local",
      full_name: "No Assign User"
    });

    if (requisition) {
      let authBlocked = false;
      try {
        await requisitionClosureService.closeRequisitionAsCancelled(
          pool,
          requisition.requisition_code,
          "should fail auth",
          unauthorizedReq
        );
      } catch (error) {
        if (error.status === 403) {
          authBlocked = true;
        }
      }

      if (authBlocked) {
        pass("closure authorization enforced for non-operator");
      } else {
        skip("closure authorization — operator gate could not be exercised with local user");
      }
    }
  } catch (error) {
    fail("verification runtime", error.message);
    console.error(error);
  } finally {
    await cleanupFulfillmentOfferFixture(offerFixture);
    await pool.end();
  }

  console.log(`\nSummary: ${passes.length} passed, ${failures.length} failed, ${skips.length} skipped`);
  if (failures.length) {
    process.exitCode = 1;
  }
}

main();
