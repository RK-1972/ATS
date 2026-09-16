/**
 * Resume Match V1 Part 1 — canonical requisition skills verification.
 * Run: node scripts/verifyRequisitionCanonicalSkillsV1.js
 */
require("dotenv").config();

const { Pool } = require("pg");
const recruitmentService = require("../services/recruitmentService");
const { REQUISITION_STATUS } = require("../constants/requisitionStatus");

const RUN_ID = Date.now();
const REQ_CODE = `REQ-E2E-SKILLS-${RUN_ID}`;

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

const results = [];

function record(name, passed, detail = "") {
  results.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
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

async function resolveRequestor() {
  const result = await pool.query(
    `SELECT u.user_id, u.employee_code, u.email_id, u.role_name, u.full_name
     FROM user_mstr u
     INNER JOIN employee_work_assignment ewa
       ON ewa.employee_code = u.employee_code AND ewa.is_active = TRUE
     INNER JOIN work_assignment_mstr wam
       ON wam.work_assignment_id = ewa.work_assignment_id AND wam.is_active = TRUE
     WHERE wam.assignment_code = 'REQUISITION_REQUESTOR'
       AND COALESCE(u.is_active, TRUE) = TRUE
     ORDER BY u.user_id ASC
     LIMIT 1`
  );
  return result.rows[0] || null;
}

async function resolveApprovalRouteId() {
  const result = await pool.query(
    `SELECT route_id
     FROM approval_route_mstr
     WHERE LOWER(TRIM(status)) = 'active'
     ORDER BY route_id ASC
     LIMIT 1`
  );
  return result.rows[0]?.route_id || null;
}

async function resolvePublishedSkills(limit = 2) {
  const result = await pool.query(
    `SELECT code, name
     FROM md_records
     WHERE entity_type = 'skills'
       AND is_deleted = FALSE
       AND LOWER(COALESCE(status, 'active')) = 'active'
       AND LOWER(COALESCE(version_status, 'published')) = 'published'
     ORDER BY code ASC
     LIMIT $1`,
    [limit]
  );
  return result.rows;
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

async function insertOpenRequisition(code, approvalRouteId, createdBy) {
  const reqId = await allocateReqId();
  await pool.query(
    `INSERT INTO rm_requisitions (
      requisition_code, req_id, position_title, department, headcount, req_status,
      budget_approved, created_by, modified_by, approval_route_id
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      code,
      reqId,
      `Skills Verify ${RUN_ID}`,
      "Verification",
      1,
      REQUISITION_STATUS.OPEN,
      0,
      createdBy,
      createdBy,
      approvalRouteId
    ]
  );
}

async function cleanup(code) {
  await pool.query("DELETE FROM rm_requisitions WHERE requisition_code = $1", [code]);
}

async function main() {
  console.log("=== Resume Match V1 Part 1 — Canonical Requisition Skills ===\n");

  const requestor = await resolveRequestor();
  const approvalRouteId = await resolveApprovalRouteId();
  const skills = await resolvePublishedSkills(2);

  record("Requestor fixture", Boolean(requestor), requestor?.employee_code || "missing");
  record("Approval route fixture", Boolean(approvalRouteId), approvalRouteId || "missing");
  record("Published EMD skills available", skills.length >= 1, `count=${skills.length}`);

  if (!requestor || !approvalRouteId || !skills.length) {
    await pool.end();
    return;
  }

  const primaryCode = skills[0].code;
  const secondaryCode = skills[1]?.code || skills[0].code;
  const requestorReq = mockReq(requestor);

  try {
    await insertOpenRequisition(
      REQ_CODE,
      approvalRouteId,
      requestor.full_name || requestor.email_id
    );

    await recruitmentService.updateRequisition(
      pool,
      REQ_CODE,
      {
        primary_skill: primaryCode,
        secondary_skill: secondaryCode
      },
      requestorReq
    );

    const updated = await recruitmentService.loadRequisitionByCode(pool, REQ_CODE);
    record(
      "Valid update persists canonical codes",
      updated.primary_skill === primaryCode
        && updated.secondary_skill === secondaryCode,
      `primary=${updated.primary_skill}, secondary=${updated.secondary_skill}`
    );

    let invalidRejected = false;
    try {
      await recruitmentService.updateRequisition(
        pool,
        REQ_CODE,
        { primary_skill: "SK-DOES-NOT-EXIST-999" },
        requestorReq
      );
    } catch (error) {
      invalidRejected = error.status === 400;
    }
    record("Invalid primary skill rejected", invalidRejected);

    const multiPrimary =
      skills.length >= 2
        ? `${skills[0].code},${skills[1].code}`
        : `${skills[0].code}`;

    await recruitmentService.updateRequisition(
      pool,
      REQ_CODE,
      { primary_skill: multiPrimary },
      requestorReq
    );
    const multiRow = await recruitmentService.loadRequisitionByCode(pool, REQ_CODE);
    record(
      "Multi-select primary codes round-trip",
      multiRow.primary_skill === multiPrimary,
      multiRow.primary_skill
    );

    const mdValidation = await recruitmentService.validateMasterDataReferences(pool, {
      primary_skill: multiPrimary,
      secondary_skill: secondaryCode
    });
    record("Master-data validation accepts canonical codes", mdValidation.valid, mdValidation.errors.join("; "));
  } finally {
    await cleanup(REQ_CODE);
  }

  const failed = results.filter((row) => !row.passed).length;
  console.log(`\n=== Summary: ${results.length - failed}/${results.length} passed ===`);
  await pool.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
