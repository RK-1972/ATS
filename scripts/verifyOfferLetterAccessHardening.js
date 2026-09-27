/**
 * Offer letter read/generate authorization (Wave 5).
 * Run: node scripts/verifyOfferLetterAccessHardening.js
 */
require("dotenv").config();

const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const offerManagementService = require("../services/offerManagementService");
const recruitmentService = require("../services/recruitmentService");
const { REQUISITION_STATUS } = require("../constants/requisitionStatus");
const { ensureEmployeeWorkAssignment } = require("../demo/e2eDemoLib");

const API_BASE_URL = process.env.API_BASE_URL || "http://localhost:5000";
const RUN_ID = Date.now();
const TEMP_ASSIGNMENT_MARKER = "OLetterV5";

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

function signToken(user) {
  return jwt.sign(
    {
      user_id: user.user_id,
      employee_code: user.employee_code,
      email_id: user.email_id,
      role_name: user.role_name,
      secondary_role: user.secondary_role || null
    },
    process.env.JWT_SECRET,
    { expiresIn: "1h" }
  );
}

async function fetchJson(routePath, token, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (options.body && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(`${API_BASE_URL}${routePath}`, {
    ...options,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return { status: response.status, body: await response.json().catch(() => ({})) };
  }

  const buffer = await response.arrayBuffer();
  return { status: response.status, bytes: buffer.byteLength };
}

async function resolvePrimaryRecruiter() {
  const result = await pool.query(
    `SELECT u.user_id, u.employee_code, u.email_id, u.role_name, u.secondary_role, u.full_name
     FROM user_mstr u
     INNER JOIN employee_work_assignment ewa
       ON ewa.employee_code = u.employee_code AND ewa.is_active = TRUE
     INNER JOIN work_assignment_mstr wam
       ON wam.work_assignment_id = ewa.work_assignment_id AND wam.is_active = TRUE
     WHERE TRIM(COALESCE(wam.workspace_flag, '')) = 'showOfferWorkspace'
       AND u.role_name = 'Recruiter'
     ORDER BY u.user_id ASC
     LIMIT 1`
  );
  return result.rows[0] || null;
}

async function resolveForeignRecruiter(excludeCode) {
  const result = await pool.query(
    `SELECT u.user_id, u.employee_code, u.email_id, u.role_name, u.secondary_role, u.full_name
     FROM user_mstr u
     WHERE u.role_name = 'Recruiter'
       AND u.employee_code <> $1
       AND COALESCE(u.is_active, TRUE) = TRUE
       AND NOT EXISTS (
         SELECT 1
         FROM employee_work_assignment ewa
         INNER JOIN work_assignment_mstr wam
           ON wam.work_assignment_id = ewa.work_assignment_id
          AND wam.is_active = TRUE
         WHERE ewa.employee_code = u.employee_code
           AND ewa.is_active = TRUE
           AND TRIM(COALESCE(wam.workspace_flag, '')) = 'showOfferWorkspace'
       )
     ORDER BY u.user_id ASC
     LIMIT 1`,
    [excludeCode]
  );
  return result.rows[0] || null;
}

async function resolveAdmin() {
  const result = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name, secondary_role, full_name
     FROM user_mstr WHERE role_name = 'Admin' AND COALESCE(is_active, TRUE) = TRUE
     ORDER BY user_id ASC LIMIT 1`
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

async function resolveOfferApprovalRouteTemplate() {
  const result = await pool.query(
    `SELECT department, position_title, grade, offered_ctc
     FROM om_offers
     WHERE department IS NOT NULL AND position_title IS NOT NULL AND grade IS NOT NULL
       AND offer_status IN ('Pending Approval', 'Approved', 'Released', 'Accepted')
     ORDER BY modified_on DESC NULLS LAST
     LIMIT 1`
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

async function insertApprovedRequisition(code) {
  const reqId = await allocateReqId();
  await pool.query(
    `INSERT INTO rm_requisitions (
      requisition_code, req_id, position_title, department, headcount, req_status,
      budget_approved, created_by, modified_by
    ) VALUES ($1, $2, $3, 'Offer Letter QA', 1, $4, 1500000, $5, $5)`,
    [code, reqId, `Offer V1 ${code}`, REQUISITION_STATUS.APPROVED, TEMP_ASSIGNMENT_MARKER]
  );
  await pool.query(
    `INSERT INTO req_mstr (
      req_id, req_code, client_name, project_name, job_title, job_description,
      openings_count, req_status, created_by
    ) VALUES ($1, $2, 'Letter QA', 'Offer Letter QA', $3, 'Disposable', 1, $4, $5)
    ON CONFLICT (req_id) DO NOTHING`,
    [reqId, code.replace(/^REQ-/, "REQ"), `Offer V1 ${code}`, REQUISITION_STATUS.APPROVED, TEMP_ASSIGNMENT_MARKER]
  );
  return reqId;
}

async function cleanupOffer(offerId) {
  if (!offerId) {
    return;
  }
  const wf = await pool.query(
    `SELECT workflow_instance_id FROM om_offers WHERE offer_id = $1`,
    [offerId]
  );
  const workflowInstanceId = wf.rows[0]?.workflow_instance_id;
  await pool.query(`DELETE FROM om_offer_letters WHERE offer_id = $1`, [offerId]).catch(() => undefined);
  await pool.query(`DELETE FROM om_offer_history WHERE offer_id = $1`, [offerId]);
  await pool.query(`DELETE FROM om_offer_acceptance WHERE offer_id = $1`, [offerId]);
  await pool.query(`DELETE FROM om_offer_compensation WHERE offer_id = $1`, [offerId]);
  await pool.query(`DELETE FROM om_offer_approvals WHERE offer_id = $1`, [offerId]);
  await pool.query(`DELETE FROM om_offers WHERE offer_id = $1`, [offerId]);
  if (workflowInstanceId) {
    await pool.query(
      `DELETE FROM wf_assignments WHERE task_id IN (
        SELECT task_id FROM wf_tasks WHERE instance_id = $1
      )`,
      [workflowInstanceId]
    );
    await pool.query(`DELETE FROM wf_tasks WHERE instance_id = $1`, [workflowInstanceId]);
    await pool.query(`DELETE FROM wf_instances WHERE instance_id = $1`, [workflowInstanceId]);
  }
}

async function main() {
  console.log("=== Offer Letter Access Hardening (Wave 5) ===\n");

  const recruiterA = await resolvePrimaryRecruiter();
  const foreignRecruiter = recruiterA
    ? await resolveForeignRecruiter(recruiterA.employee_code)
    : null;
  const admin = await resolveAdmin();
  const grade = await resolveValidGrade();
  const routeTemplate = await resolveOfferApprovalRouteTemplate();

  if (!recruiterA || !foreignRecruiter || !admin || !grade || !routeTemplate) {
    fail("fixtures", "primary recruiter, foreign recruiter, admin, grade, route template required");
    await pool.end();
    return;
  }

  await ensureEmployeeWorkAssignment(pool, foreignRecruiter.employee_code, "OFFER_RECRUITER");

  const requisitionCode = `REQ-OL${String(RUN_ID).slice(-8)}`;
  const candidateEmail = `e2e.offer.letter.${RUN_ID}@example.com`;
  let offerId = null;
  let candidateId = null;
  let mapId = null;

  try {
    await insertApprovedRequisition(requisitionCode);
    await pool.query(
      `UPDATE rm_requisitions
       SET department = $1, position_title = $2
       WHERE requisition_code = $3`,
      [routeTemplate.department, routeTemplate.position_title, requisitionCode]
    );
    await recruitmentService.assignRecruiter(
      pool,
      requisitionCode,
      recruiterA.employee_code,
      mockReq(admin)
    );

    const candidateInsert = await pool.query(
      `INSERT INTO cand_mstr (
        first_name, last_name, email_id, mobile_number, primary_skill,
        total_experience, candidate_status, created_by
      ) VALUES ('Letter', 'QA', $1, '9876512345', 'Java', 4, 'Applied', $2)
      RETURNING candidate_id`,
      [candidateEmail, TEMP_ASSIGNMENT_MARKER]
    );
    candidateId = candidateInsert.rows[0].candidate_id;

    const mapped = await recruitmentService.mapCandidate(
      pool,
      {
        candidate_id: candidateId,
        requisition_code: requisitionCode,
        stage_name: "Applied",
        source_type: "Direct"
      },
      mockReq(recruiterA)
    );
    mapId = (mapped.mapping || mapped).map_id || (mapped.mapping || mapped).mapping_id;

    const created = await offerManagementService.createOffer(
      pool,
      {
        requisition_code: requisitionCode,
        mapping_id: mapId,
        candidate_id: candidateId,
        candidate_name: "Letter QA Candidate",
        offered_ctc: Number(routeTemplate.offered_ctc || 1400000),
        approved_budget: 1500000,
        grade: routeTemplate.grade || grade,
        department: routeTemplate.department,
        position_title: routeTemplate.position_title,
        expected_joining_date: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10)
      },
      mockReq(recruiterA)
    );
    offerId = created.offer?.offerId;

    await pool.query(
      `UPDATE om_offers SET offer_status = 'Approved', modified_on = NOW() WHERE offer_id = $1`,
      [offerId]
    );

    const tokenA = signToken(recruiterA);
    const tokenB = signToken(foreignRecruiter);

    const pendingA = await fetchJson("/api/v1/offer-letters/pending", tokenA);
    if (pendingA.status === 200) {
      const includesOwn = (pendingA.body?.data || []).some(
        (row) => String(row.offerId) === String(offerId)
      );
      if (includesOwn) {
        pass("HTTP: authorized recruiter pending list includes owned offer");
      } else {
        fail("HTTP: authorized recruiter pending list", "owned offer missing");
      }
    } else {
      fail("HTTP: authorized recruiter pending list", `status=${pendingA.status}`);
    }

    const pendingB = await fetchJson("/api/v1/offer-letters/pending", tokenB);
    const leaked = (pendingB.body?.data || []).filter(
      (row) => String(row.offerId) === String(offerId)
    );
    if (pendingB.status === 200 && leaked.length === 0) {
      pass("HTTP: foreign recruiter pending list excludes unassigned offer");
    } else {
      fail(
        "HTTP: foreign recruiter pending list scope",
        `status=${pendingB.status} leaked=${leaked.length}`
      );
    }

    const detailA = await fetchJson(`/api/v1/offer-letters/${encodeURIComponent(offerId)}`, tokenA);
    if (detailA.status === 200) {
      pass("HTTP: authorized letter detail");
    } else {
      fail("HTTP: authorized letter detail", `status=${detailA.status}`);
    }

    const detailB = await fetchJson(`/api/v1/offer-letters/${encodeURIComponent(offerId)}`, tokenB);
    if (detailB.status === 403) {
      pass("HTTP: foreign letter detail denied (403)");
    } else {
      fail("HTTP: foreign letter detail", `expected 403, got ${detailB.status}`);
    }

    const pdfB = await fetchJson(
      `/api/v1/offer-letters/${encodeURIComponent(offerId)}/pdf`,
      tokenB
    );
    if (pdfB.status === 403) {
      pass("HTTP: foreign letter PDF denied (403)");
    } else {
      fail("HTTP: foreign letter PDF", `expected 403, got ${pdfB.status}`);
    }

    const generateB = await fetchJson(
      `/api/v1/offer-letters/${encodeURIComponent(offerId)}/generate`,
      tokenB,
      { method: "POST", body: { templateName: "Standard Offer Letter", ctcBreakup: [] } }
    );
    if (generateB.status === 403) {
      pass("HTTP: foreign letter generate denied (403)");
    } else {
      fail("HTTP: foreign letter generate", `expected 403, got ${generateB.status}`);
    }
  } finally {
    await cleanupOffer(offerId);
    if (mapId || requisitionCode) {
      await pool.query(`DELETE FROM rm_candidate_mappings WHERE requisition_code = $1`, [
        requisitionCode
      ]).catch(() => undefined);
      await pool.query(`DELETE FROM rm_requisitions WHERE requisition_code = $1`, [
        requisitionCode
      ]).catch(() => undefined);
    }
    if (candidateId) {
      await pool.query(`DELETE FROM candidate_req_map WHERE candidate_id = $1`, [candidateId]).catch(
        () => undefined
      );
      await pool.query(`DELETE FROM cand_mstr WHERE candidate_id = $1`, [candidateId]).catch(
        () => undefined
      );
    }
    await pool.end();
  }

  if (process.exitCode) {
    console.log("\nOffer letter access hardening completed with failures.");
  } else {
    console.log("\nAll offer letter access hardening checks passed.");
  }
}

main().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
  await pool.end().catch(() => undefined);
});
