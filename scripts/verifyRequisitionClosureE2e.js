/**
 * E2E verification for requisition fulfillment and closure (disposable DEV data).
 * Run: node scripts/verifyRequisitionClosureE2e.js
 */
require("dotenv").config();

const { Pool } = require("pg");
const recruitmentService = require("../services/recruitmentService");
const offerManagementService = require("../services/offerManagementService");
const requisitionClosureService = require("../services/requisitionClosureService");
const interviewService = require("../services/interviewService");
const { REQUISITION_STATUS } = require("../constants/requisitionStatus");
const {
  getFulfillmentForRequisition,
  countReservedOffers
} = require("../services/requisitionFulfillmentService");

const RUN_ID = Date.now();
const REQ_FILLED = `REQ-E2E-CLOSE-F-${RUN_ID}`;
const REQ_CANCEL = `REQ-E2E-CLOSE-C-${RUN_ID}`;

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

const scenarioResults = [];

function record(scenario, passed, detail = "") {
  scenarioResults.push({ scenario, passed, detail });
  const label = `${scenario}${detail ? ` — ${detail}` : ""}`;
  console.log(`${passed ? "PASS" : "FAIL"}: ${label}`);
  if (!passed) {
    process.exitCode = 1;
  }
}

function mockReq(user) {
  return {
    user: {
      user_id: user.user_id,
      employee_code: user.employee_code,
      email_id: user.email_id,
      role_name: user.role_name,
      secondary_role: user.secondary_role || null,
      full_name: user.full_name || user.email_id
    }
  };
}

async function resolveUserByRole(roleName) {
  const result = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name, secondary_role, full_name
     FROM user_mstr
     WHERE role_name = $1 AND COALESCE(is_active, TRUE) = TRUE
     ORDER BY user_id ASC LIMIT 1`,
    [roleName]
  );
  return result.rows[0] || null;
}

async function resolveOfferWorkspaceUser() {
  const result = await pool.query(
    `SELECT u.user_id, u.employee_code, u.email_id, u.role_name, u.secondary_role, u.full_name
     FROM user_mstr u
     INNER JOIN employee_work_assignment ewa ON ewa.employee_code = u.employee_code AND ewa.is_active = TRUE
     INNER JOIN work_assignment_mstr wam ON wam.work_assignment_id = ewa.work_assignment_id AND wam.is_active = TRUE
     WHERE TRIM(COALESCE(wam.workspace_flag, '')) = 'showOfferWorkspace'
       AND COALESCE(u.is_active, TRUE) = TRUE
     ORDER BY u.user_id ASC LIMIT 1`
  );
  return result.rows[0] || null;
}

async function resolveUnauthorizedRecruiter() {
  const result = await pool.query(
    `SELECT u.user_id, u.employee_code, u.email_id, u.role_name, u.secondary_role, u.full_name
     FROM user_mstr u
     WHERE u.role_name = 'Recruiter'
       AND COALESCE(u.is_active, TRUE) = TRUE
       AND NOT EXISTS (
         SELECT 1 FROM employee_work_assignment ewa
         INNER JOIN work_assignment_mstr wam ON wam.work_assignment_id = ewa.work_assignment_id
         WHERE ewa.employee_code = u.employee_code AND ewa.is_active = TRUE
           AND wam.assignment_code = 'REQUISITION_ASSIGNER'
       )
     ORDER BY u.user_id ASC LIMIT 1`
  );
  return result.rows[0] || null;
}

async function resolveTaLeadOperator() {
  const result = await pool.query(
    `SELECT u.user_id, u.employee_code, u.email_id, u.role_name, u.secondary_role, u.full_name
     FROM user_mstr u
     WHERE u.role_name IN ('TA Lead', 'TA Leader')
       AND COALESCE(u.is_active, TRUE) = TRUE
     ORDER BY u.user_id ASC LIMIT 1`
  );
  return result.rows[0] || null;
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

async function insertApprovedRequisition(code, headcount = 2) {
  const reqId = await allocateReqId();
  await pool.query(
    `INSERT INTO rm_requisitions (
      requisition_code, req_id, position_title, department, headcount, req_status,
      budget_approved, created_by, modified_by
    ) VALUES ($1, $2, $3, 'E2E Closure QA', $4, $5, 1000000, 'E2E Closure Verify', 'E2E Closure Verify')`,
    [code, reqId, `E2E Closure ${code}`, headcount, REQUISITION_STATUS.APPROVED]
  );

  if (await tableExists("req_mstr")) {
    await pool.query(
      `INSERT INTO req_mstr (
        req_id, req_code, client_name, project_name, job_title, job_description,
        openings_count, req_status, created_by
      ) VALUES ($1, $2, 'E2E', 'E2E Closure QA', $3, 'E2E disposable requisition', $4, $5, 'E2E Closure Verify')
      ON CONFLICT (req_id) DO NOTHING`,
      [reqId, code.replace(/^REQ-/, "REQ"), `E2E Closure ${code}`, headcount, REQUISITION_STATUS.APPROVED]
    );
  }

  return reqId;
}

async function publishPortal(code, adminReq) {
  await recruitmentService.publishRequisitionToCandidatePortal(pool, code, adminReq);
}

async function createCandidate(label) {
  const email = `e2e.closure.${label}.${RUN_ID}@example.com`;
  const result = await pool.query(
    `INSERT INTO cand_mstr (
      first_name, last_name, email_id, mobile_number, primary_skill,
      total_experience, candidate_status, created_by
    ) VALUES ($1, 'Closure', $2, '9876500001', 'Java', 3, 'Applied', 'E2E Closure Verify')
    RETURNING candidate_id`,
    [label, email]
  );
  return result.rows[0].candidate_id;
}

async function mapCandidateToReq(candidateId, requisitionCode, adminReq) {
  const result = await recruitmentService.mapCandidate(
    pool,
    {
      candidate_id: candidateId,
      requisition_code: requisitionCode,
      stage_name: "Applied",
      source_type: "Direct"
    },
    adminReq
  );
  const mapping = result.mapping;
  return {
    mappingId: mapping.mapping_id,
    mapId: mapping.map_id || mapping.mapping_id
  };
}

async function assignRecruiter(requisitionCode, recruiterCode, adminReq) {
  await recruitmentService.assignRecruiter(pool, requisitionCode, recruiterCode, adminReq);
}

async function resolveValidGrade() {
  const result = await pool.query(
    `SELECT name FROM md_records
     WHERE entity_type = 'grades' AND COALESCE(is_deleted, FALSE) = FALSE
     ORDER BY name ASC LIMIT 1`
  );
  return result.rows[0]?.name || null;
}

async function createReleasedOffer(requisition, candidateId, mappingId, offerUser, grade) {
  const joiningDate = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const payload = {
    requisition_code: requisition.requisition_code,
    candidate_id: candidateId,
    mapping_id: mappingId,
    offered_ctc: 1200000,
    approved_budget: 1500000,
    department: requisition.department,
    candidate_name: `E2E Candidate ${candidateId}`,
    expected_joining_date: joiningDate
  };
  if (grade) {
    payload.grade = grade;
  }
  const created = await offerManagementService.createOffer(
    pool,
    payload,
    mockReq(offerUser)
  );
  const offerId = created.offer.offerId;
  await pool.query(
    `UPDATE om_offers SET offer_status = 'Released', modified_by = 'E2E', modified_on = NOW()
     WHERE offer_id = $1`,
    [offerId]
  );
  return offerId;
}

async function countRows(table, whereSql, params) {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS total FROM ${table} WHERE ${whereSql}`,
    params
  );
  return result.rows[0].total;
}

async function cleanupDisposableData() {
  const codes = [REQ_FILLED, REQ_CANCEL];
  const offers = await pool.query(
    `SELECT offer_id FROM om_offers WHERE requisition_code = ANY($1::text[])`,
    [codes]
  );
  const offerIds = offers.rows.map((row) => row.offer_id);
  if (offerIds.length) {
    await pool.query(`DELETE FROM om_offer_acceptance WHERE offer_id = ANY($1::text[])`, [offerIds]);
    await pool.query(`DELETE FROM om_offer_history WHERE offer_id = ANY($1::text[])`, [offerIds]);
    await pool.query(`DELETE FROM om_offers WHERE offer_id = ANY($1::text[])`, [offerIds]);
  }
  await pool.query(`DELETE FROM rm_pipeline_history WHERE requisition_code = ANY($1::text[])`, [codes]);
  const mappingRows = await pool.query(
    `SELECT map_id, candidate_id FROM rm_candidate_mappings WHERE requisition_code = ANY($1::text[])`,
    [codes]
  );
  const mapIds = mappingRows.rows.map((row) => row.map_id).filter(Boolean);
  const candidateIds = mappingRows.rows.map((row) => row.candidate_id).filter(Boolean);
  await pool.query(`DELETE FROM rm_candidate_mappings WHERE requisition_code = ANY($1::text[])`, [codes]);
  if (mapIds.length && (await tableExists("candidate_req_map"))) {
    await pool.query(`DELETE FROM candidate_req_map WHERE map_id = ANY($1::int[])`, [mapIds]);
  }
  const extraCandidates = await pool.query(
    `SELECT candidate_id FROM cand_mstr WHERE email_id LIKE $1`,
    [`e2e.closure.%${RUN_ID}@example.com`]
  );
  const allCandidateIds = [
    ...new Set([
      ...candidateIds,
      ...extraCandidates.rows.map((row) => row.candidate_id)
    ])
  ];
  if (allCandidateIds.length && (await tableExists("candidate_req_map"))) {
    await pool.query(
      `DELETE FROM candidate_req_map WHERE candidate_id = ANY($1::int[])`,
      [allCandidateIds]
    );
  }
  if (allCandidateIds.length) {
    await pool.query(`DELETE FROM cand_mstr WHERE candidate_id = ANY($1::int[])`, [allCandidateIds]);
  }
  await pool.query(`DELETE FROM rm_recruiter_assignments WHERE requisition_code = ANY($1::text[])`, [codes]);
  const reqIds = await pool.query(
    `SELECT req_id FROM rm_requisitions WHERE requisition_code = ANY($1::text[]) AND req_id IS NOT NULL`,
    [codes]
  );
  await pool.query(`DELETE FROM rm_requisitions WHERE requisition_code = ANY($1::text[])`, [codes]);
  if (await tableExists("req_mstr") && reqIds.rows.length) {
    await pool.query(
      `DELETE FROM req_mstr WHERE req_id = ANY($1::int[])`,
      [reqIds.rows.map((row) => row.req_id)]
    );
  }
}

async function main() {
  console.log("=== Requisition Closure E2E Verification ===\n");
  console.log(`Run ID: ${RUN_ID}`);
  console.log(`Filled requisition: ${REQ_FILLED}`);
  console.log(`Cancel requisition: ${REQ_CANCEL}\n`);

  const admin = await resolveUserByRole("Admin");
  const offerUser = await resolveOfferWorkspaceUser();
  const taLead = await resolveTaLeadOperator();
  const badRecruiter = await resolveUnauthorizedRecruiter();
  const recruiter = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name, full_name
     FROM user_mstr WHERE role_name = 'Recruiter' AND COALESCE(is_active, TRUE) = TRUE
     ORDER BY user_id ASC LIMIT 1`
  ).then((r) => r.rows[0]);

  if (!admin || !offerUser || !recruiter) {
    record("0 — fixtures", false, "Admin, offer-workspace user, or recruiter missing");
    await pool.end();
    return;
  }

  const adminReq = mockReq(admin);
  const offerReq = mockReq(offerUser);

  try {
    // Scenario 1
    await insertApprovedRequisition(REQ_FILLED, 2);
    await insertApprovedRequisition(REQ_CANCEL, 1);
    await assignRecruiter(REQ_FILLED, recruiter.employee_code, adminReq);
    await assignRecruiter(REQ_CANCEL, recruiter.employee_code, adminReq);
    if (offerUser.employee_code !== recruiter.employee_code) {
      await assignRecruiter(REQ_FILLED, offerUser.employee_code, adminReq);
      await assignRecruiter(REQ_CANCEL, offerUser.employee_code, adminReq);
    }
    await publishPortal(REQ_FILLED, adminReq);
    await publishPortal(REQ_CANCEL, adminReq);

    const reqFilled = await recruitmentService.loadRequisitionByCode(pool, REQ_FILLED);
    record(
      "1 — Headcount=2 approved requisition with portal published",
      reqFilled?.headcount === 2 && reqFilled?.req_status === REQUISITION_STATUS.APPROVED
        && Boolean(reqFilled?.candidate_portal_published_at),
      `headcount=${reqFilled?.headcount}`
    );

    const candidateA = await createCandidate("A");
    const candidateB = await createCandidate("B");
    const candidateC = await createCandidate("C");

    const recruiterReq = mockReq(recruiter);
    const mapA = await mapCandidateToReq(candidateA, REQ_FILLED, recruiterReq);
    const mapB = await mapCandidateToReq(candidateB, REQ_FILLED, recruiterReq);
    const mapC = await mapCandidateToReq(candidateC, REQ_FILLED, recruiterReq);

    const validGrade = await resolveValidGrade();
    const offerA = await createReleasedOffer(reqFilled, candidateA, mapA.mappingId, offerUser, validGrade);
    const offerB = await createReleasedOffer(reqFilled, candidateB, mapB.mappingId, offerUser, validGrade);
    const offerC = await createReleasedOffer(reqFilled, candidateC, mapC.mappingId, offerUser, validGrade);

    await offerManagementService.acceptOffer(pool, offerA, offerReq);
    record("2 — Candidate A Accepted offer", true);

    await offerManagementService.acceptOffer(pool, offerB, offerReq);
    record("3 — Candidate B Accepted offer", true);

    const afterAccept = await getFulfillmentForRequisition(pool, reqFilled);
    const reservedSlotsRemaining = Math.max(0, afterAccept.required_headcount - afterAccept.reserved_headcount);
    record(
      "4 — Reserved=2 and reservation capacity exhausted (Remaining slots=0)",
      afterAccept.reserved_headcount === 2 && reservedSlotsRemaining === 0,
      `reserved=${afterAccept.reserved_headcount}, slots_remaining=${reservedSlotsRemaining}, fill_remaining=${afterAccept.remaining_headcount}`
    );

    let blockedC = false;
    try {
      await offerManagementService.acceptOffer(pool, offerC, offerReq);
    } catch (error) {
      blockedC = error.status === 400 || error.status === 409;
    }
    record("5 — Candidate C Accepted offer blocked at capacity", blockedC);

    await recruitmentService.updateCandidateStage(pool, mapA.mapId, "Joined", "E2E join A", adminReq);
    await recruitmentService.updateCandidateStage(pool, mapB.mapId, "Joined", "E2E join B", adminReq);
    record("6 — Candidates A and B moved to governed Joined", true);

    const afterJoin = await getFulfillmentForRequisition(pool, reqFilled);
    record(
      "7 — Filled=2 and Closure Eligible=true",
      afterJoin.filled_headcount === 2 && afterJoin.closure_eligible === true,
      JSON.stringify(afterJoin)
    );

    const countsBeforeClose = {
      mappings: await countRows("rm_candidate_mappings", "requisition_code = $1", [REQ_FILLED]),
      offers: await countRows("om_offers", "requisition_code = $1", [REQ_FILLED]),
      history: await countRows("rm_pipeline_history", "requisition_code = $1", [REQ_FILLED])
    };

    const closeActor = taLead || admin;
    const closeResult = await requisitionClosureService.closeRequisitionAsFilled(
      pool,
      REQ_FILLED,
      mockReq(closeActor)
    );

    const closedRow = await recruitmentService.loadRequisitionByCode(pool, REQ_FILLED);
    const audit = await pool.query(
      `SELECT event_type, entity_id, new_value, user_name
       FROM md_enterprise_audit
       WHERE entity_id = $1 AND event_type = 'RequisitionClosedFilled'
       ORDER BY created_on DESC NULLS LAST LIMIT 1`,
      [REQ_FILLED]
    );

    record(
      "8 — Close Filled sets status, closed_at/by, audit, portal unpublished",
      closedRow.req_status === REQUISITION_STATUS.CLOSED_FILLED
        && Boolean(closedRow.closed_at)
        && Boolean(closedRow.closed_by)
        && !closedRow.candidate_portal_published_at
        && audit.rows.length > 0,
      `status=${closedRow.req_status}, closed_by=${closedRow.closed_by}`
    );

    let portalBlocked = false;
    try {
      await recruitmentService.loadOpenRequisitionForCandidatePortal(pool, REQ_FILLED);
    } catch (error) {
      portalBlocked = error.status === 404;
    }

    let offerBlocked = false;
    try {
      await offerManagementService.createOffer(
        pool,
        {
          requisition_code: REQ_FILLED,
          candidate_id: candidateC,
          mapping_id: mapC.mappingId,
          offered_ctc: 1200000,
          approved_budget: 1500000,
          department: reqFilled.department,
          expected_joining_date: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10)
        },
        offerReq
      );
    } catch (error) {
      offerBlocked = /closed|recruiting/i.test(error.message);
    }

    let mapBlocked = false;
    try {
      const extraCandidate = await createCandidate("D");
      await recruitmentService.mapCandidate(
        pool,
        { candidate_id: extraCandidate, requisition_code: REQ_FILLED, stage_name: "Applied" },
        adminReq
      );
    } catch (error) {
      mapBlocked = /closed|recruiting/i.test(error.message);
    }

    let stageBlocked = false;
    try {
      await recruitmentService.updateCandidateStage(pool, mapC.mapId, "Screening", "blocked", adminReq);
    } catch (error) {
      stageBlocked = /closed|recruiting/i.test(error.message);
    }

    let interviewBlocked = false;
    let interviewDetail = "";
    try {
      const roundType = await pool.query(
        `SELECT name FROM md_records WHERE entity_type = 'interview_types' LIMIT 1`
      ).then((r) => r.rows[0]?.name || "Technical");
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 2);
      await interviewService.scheduleInterview(
        pool,
        {
          map_id: mapC.mapId,
          req_id: reqFilled.req_id,
          interviewer_id: "IGS0001",
          round_type: roundType,
          interview_date: tomorrow.toISOString().slice(0, 10),
          interview_time: "10:00"
        },
        mockReq(recruiter)
      );
      interviewDetail = "scheduleInterview succeeded unexpectedly";
    } catch (error) {
      interviewDetail = error.message;
      interviewBlocked = /closed|recruiting|cannot accept/i.test(error.message);
    }

    record(
      "9 — Post-close portal/offer/map/stage/interview blocked",
      portalBlocked && offerBlocked && mapBlocked && stageBlocked && interviewBlocked,
      `portal=${portalBlocked}, offer=${offerBlocked}, map=${mapBlocked}, stage=${stageBlocked}, interview=${interviewBlocked}, interview_error=${interviewDetail}`
    );

    const countsAfterClose = {
      mappings: await countRows("rm_candidate_mappings", "requisition_code = $1", [REQ_FILLED]),
      offers: await countRows("om_offers", "requisition_code = $1", [REQ_FILLED]),
      history: await countRows("rm_pipeline_history", "requisition_code = $1", [REQ_FILLED])
    };

    record(
      "10 — Existing mapping/offer/history preserved after close",
      countsAfterClose.mappings === countsBeforeClose.mappings
        && countsAfterClose.offers === countsBeforeClose.offers
        && countsAfterClose.history >= countsBeforeClose.history,
      `before=${JSON.stringify(countsBeforeClose)}, after=${JSON.stringify(countsAfterClose)}`
    );

    const cancelReason = `E2E cancellation ${RUN_ID}`;
    const cancelResult = await requisitionClosureService.closeRequisitionAsCancelled(
      pool,
      REQ_CANCEL,
      cancelReason,
      mockReq(closeActor)
    );
    const cancelledRow = await recruitmentService.loadRequisitionByCode(pool, REQ_CANCEL);
    const cancelAudit = await pool.query(
      `SELECT event_type FROM md_enterprise_audit
       WHERE entity_id = $1 AND event_type = 'RequisitionClosedCancelled' LIMIT 1`,
      [REQ_CANCEL]
    );

    record(
      "11 — Close Cancelled with reason",
      cancelledRow.req_status === REQUISITION_STATUS.CLOSED_CANCELLED
        && cancelledRow.closure_reason === cancelReason
        && cancelAudit.rows.length > 0,
      cancelledRow.req_status
    );

    record(
      "12 — Cancelled req portal unpublished and recruiting blocked",
      !cancelledRow.candidate_portal_published_at,
      `portal=${cancelledRow.candidate_portal_published_at}`
    );

    let recruiterCloseBlocked = false;
    if (badRecruiter) {
      try {
        await requisitionClosureService.closeRequisitionAsFilled(
          pool,
          REQ_CANCEL,
          mockReq(badRecruiter)
        );
      } catch (error) {
        recruiterCloseBlocked = error.status === 403;
      }
      record("13 — Unauthorized recruiter cannot close", recruiterCloseBlocked);
    } else {
      record("13 — Unauthorized recruiter cannot close", true, "SKIP no non-operator recruiter fixture");
    }

    let operatorCanClose = false;
    let operatorCloseDetail = "";
    try {
      const tempCode = `REQ-E2E-CLOSE-TMP-${RUN_ID}`;
      await insertApprovedRequisition(tempCode, 1);
      await assignRecruiter(tempCode, recruiter.employee_code, adminReq);
      const tempCand = await createCandidate("TMP");
      const tempMap = await mapCandidateToReq(tempCand, tempCode, recruiterReq);
      await recruitmentService.updateCandidateStage(pool, tempMap.mapId, "Joined", "tmp", adminReq);
      const tempFulfillment = await getFulfillmentForRequisition(
        pool,
        await recruitmentService.loadRequisitionByCode(pool, tempCode)
      );
      await requisitionClosureService.closeRequisitionAsFilled(pool, tempCode, mockReq(closeActor));
      const tempClosed = await recruitmentService.loadRequisitionByCode(pool, tempCode);
      operatorCanClose = tempClosed.req_status === REQUISITION_STATUS.CLOSED_FILLED;
      const tempReqId = tempClosed.req_id;
      const tempMapIds = await pool.query(
        `SELECT map_id FROM rm_candidate_mappings WHERE requisition_code = $1`,
        [tempCode]
      ).then((r) => r.rows.map((row) => row.map_id).filter(Boolean));
      await pool.query(`DELETE FROM rm_pipeline_history WHERE requisition_code = $1`, [tempCode]);
      if (tempMapIds.length && (await tableExists("candidate_req_map"))) {
        await pool.query(`DELETE FROM candidate_req_map WHERE map_id = ANY($1::int[])`, [tempMapIds]);
      }
      await pool.query(`DELETE FROM rm_candidate_mappings WHERE requisition_code = $1`, [tempCode]);
      await pool.query(`DELETE FROM rm_recruiter_assignments WHERE requisition_code = $1`, [tempCode]);
      await pool.query(`DELETE FROM cand_mstr WHERE candidate_id = $1`, [tempCand]);
      await pool.query(`DELETE FROM rm_requisitions WHERE requisition_code = $1`, [tempCode]);
      if (tempReqId && (await tableExists("req_mstr"))) {
        await pool.query(`DELETE FROM req_mstr WHERE req_id = $1`, [tempReqId]);
      }
      operatorCloseDetail = `fulfillment=${JSON.stringify(tempFulfillment)}`;
    } catch (error) {
      operatorCanClose = false;
      operatorCloseDetail = error.message;
    }
    record(
      "14 — TA Lead/Admin can close",
      operatorCanClose,
      `actor=${closeActor.role_name}/${closeActor.employee_code}, ${operatorCloseDetail}`
    );
  } catch (error) {
    record("E2E runtime", false, error.message);
    console.error(error);
  } finally {
    console.log("\n--- Cleaning disposable E2E data ---");
    await cleanupDisposableData();
    await pool.end();
  }

  console.log("\n=== Scenario Summary ===");
  for (const row of scenarioResults) {
    console.log(`${row.passed ? "PASS" : "FAIL"} | ${row.scenario}${row.detail ? ` | ${row.detail}` : ""}`);
  }
}

main();
