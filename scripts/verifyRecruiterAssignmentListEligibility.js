/**
 * Recruiter assignment management list — Approved-only eligibility.
 * Run: node scripts/verifyRecruiterAssignmentListEligibility.js
 */
require("dotenv").config();

const { Pool } = require("pg");
const recruitmentService = require("../services/recruitmentService");
const { REQUISITION_STATUS } = require("../constants/requisitionStatus");

const RUN_ID = String(Date.now()).slice(-8);
const PREFIX = `REQ-ASGL-${RUN_ID}`;

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

const testCodes = {
  approved: `${PREFIX}-APR`,
  open: `${PREFIX}-OPN`,
  pending1: `${PREFIX}-P1`,
  pending2: `${PREFIX}-P2`,
  clarification: `${PREFIX}-CLR`,
  rejected: `${PREFIX}-REJ`,
  closedFilled: `${PREFIX}-CF`,
  closedCancelled: `${PREFIX}-CC`
};

function record(name, passed, detail = "") {
  console.log(`${passed ? "PASS" : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
  if (!passed) {
    process.exitCode = 1;
  }
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

async function insertRequisition(code, status) {
  const reqId = await allocateReqId();
  await pool.query(
    `INSERT INTO rm_requisitions (
      requisition_code, req_id, position_title, department, headcount, req_status,
      budget_approved, created_by, modified_by
    ) VALUES ($1,$2,$3,'Assignment List QA',1,$4,0,'Assignment List Verify','Assignment List Verify')`,
    [code, reqId, `Assignment ${code}`, status]
  );

  if (await tableExists("req_mstr")) {
    await pool.query(
      `INSERT INTO req_mstr (
        req_id, req_code, client_name, project_name, job_title, job_description,
        openings_count, req_status, created_by
      ) VALUES ($1,$2,'E2E','Assignment List QA',$3,'Disposable requisition',1,$4,'Assignment List Verify')
      ON CONFLICT (req_id) DO NOTHING`,
      [reqId, code.replace(/^REQ-/, "REQ"), `Assignment ${code}`, status]
    );
  }

  return { code, reqId };
}

async function cleanup() {
  const codes = Object.values(testCodes);
  await pool.query(
    "DELETE FROM rm_recruiter_assignments WHERE requisition_code = ANY($1::text[])",
    [codes]
  );
  await pool.query(
    "DELETE FROM rm_requisitions WHERE requisition_code = ANY($1::text[])",
    [codes]
  );
  if (await tableExists("req_mstr")) {
    await pool.query(
      `DELETE FROM req_mstr
       WHERE req_code = ANY($1::text[])`,
      [codes.map((c) => c.replace(/^REQ-/, "REQ"))]
    );
  }
}

function mockAdminReq(admin) {
  return {
    user: {
      user_id: admin.user_id,
      employee_code: admin.employee_code,
      email_id: admin.email_id,
      role_name: admin.role_name,
      full_name: admin.full_name || admin.email_id
    }
  };
}

async function resolveAdmin() {
  const result = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name, full_name
     FROM user_mstr
     WHERE role_name = 'Admin' AND COALESCE(is_active, TRUE) = TRUE
     ORDER BY user_id ASC
     LIMIT 1`
  );
  return result.rows[0] || null;
}

async function resolveRecruiter() {
  const result = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name, full_name
     FROM user_mstr
     WHERE role_name = 'Recruiter' AND COALESCE(is_active, TRUE) = TRUE
     ORDER BY user_id ASC
     LIMIT 1`
  );
  return result.rows[0] || null;
}

async function main() {
  console.log("=== Recruiter Assignment List Eligibility Verification ===\n");

  const admin = await resolveAdmin();
  const recruiter = await resolveRecruiter();

  if (!admin) {
    record("prerequisites: admin user", false, "no admin");
    await pool.end();
    return;
  }
  if (!recruiter) {
    record("prerequisites: recruiter user", false, "no recruiter");
    await pool.end();
    return;
  }

  await cleanup();

  const fixtures = [
    [testCodes.approved, REQUISITION_STATUS.APPROVED],
    [testCodes.open, REQUISITION_STATUS.OPEN],
    [testCodes.pending1, REQUISITION_STATUS.PENDING_LEVEL_1],
    [testCodes.pending2, REQUISITION_STATUS.PENDING_LEVEL_2],
    [testCodes.clarification, REQUISITION_STATUS.CLARIFICATION_REQUESTED],
    [testCodes.rejected, REQUISITION_STATUS.REJECTED],
    [testCodes.closedFilled, REQUISITION_STATUS.CLOSED_FILLED],
    [testCodes.closedCancelled, REQUISITION_STATUS.CLOSED_CANCELLED]
  ];

  let approvedReqId = null;

  for (const [code, status] of fixtures) {
    const row = await insertRequisition(code, status);
    if (status === REQUISITION_STATUS.APPROVED) {
      approvedReqId = row.reqId;
    }
  }

  const list = await recruitmentService.listRequisitionsForManagement(pool);
  const codesInList = new Set(
    list.map((row) => String(row.requisition_code || row.req_code || "").trim())
  );

  const allApproved = list.every(
    (row) => String(row.req_status || "").trim() === REQUISITION_STATUS.APPROVED
  );
  record("every listed row is Approved", allApproved);

  record(
    "Approved requisition is listed",
    codesInList.has(testCodes.approved),
    testCodes.approved
  );

  const excluded = [
    ["Open", testCodes.open],
    ["Pending Level-1", testCodes.pending1],
    ["Pending Level-2", testCodes.pending2],
    ["Clarification Requested", testCodes.clarification],
    ["Rejected", testCodes.rejected],
    ["Closed - Filled", testCodes.closedFilled],
    ["Closed - Cancelled", testCodes.closedCancelled]
  ];

  for (const [label, code] of excluded) {
    record(`${label} not listed`, !codesInList.has(code), code);
  }

  try {
    await recruitmentService.assignRecruiter(
      pool,
      approvedReqId,
      recruiter.employee_code,
      mockAdminReq(admin)
    );
    record("assignRecruiter succeeds on Approved requisition", true);
  } catch (error) {
    record("assignRecruiter succeeds on Approved requisition", false, error.message);
  }

  await cleanup();
  await pool.end();
  console.log("\nVerification finished.");
}

main().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
  try {
    await cleanup();
    await pool.end();
  } catch (_cleanupError) {
    // ignore
  }
});
