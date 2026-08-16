require("dotenv").config();

const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const { buildLifecycleSnapshot } = require("../services/hiringControlTowerLifecycle");
const recruitmentService = require("../services/recruitmentService");

const API_BASE_URL = process.env.API_BASE_URL || "http://localhost:5000";

const FORBIDDEN_MILESTONE_KEYS = new Set([
  "finance_approval",
  "leadership_approval",
  "recruiter_notified",
  "budget_validation",
  "position_budget_approval"
]);

const ALLOWED_STATUSES = new Set([
  "Not Started",
  "In Progress",
  "Completed",
  "Blocked",
  "Not Applicable"
]);

const EXPECTED_MILESTONE_KEYS = [
  "budget_submitted",
  "budget_approved",
  "requisition_created",
  "requisition_submitted",
  "requisition_approved",
  "recruiter_assigned",
  "candidate_pipeline",
  "interview_progress",
  "offer_progress",
  "hire_outcome"
];

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

function signToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "8h" });
}

async function readJson(response) {
  const text = await response.text();

  try {
    return JSON.parse(text);
  } catch (error) {
    return { raw: text };
  }
}

function assertLifecycleShape(data, label) {
  if (!data?.milestones || data.milestones.length !== 10) {
    fail(`${label} milestone count`, `expected 10, got ${data?.milestones?.length ?? 0}`);
    return false;
  }

  const keys = data.milestones.map((item) => item.key);
  const keySet = new Set(keys);

  for (const expected of EXPECTED_MILESTONE_KEYS) {
    if (!keySet.has(expected)) {
      fail(`${label} missing milestone`, expected);
      return false;
    }
  }

  for (const key of keys) {
    if (FORBIDDEN_MILESTONE_KEYS.has(key)) {
      fail(`${label} forbidden milestone`, key);
      return false;
    }
  }

  for (const milestone of data.milestones) {
    if (!ALLOWED_STATUSES.has(milestone.status)) {
      fail(`${label} invalid status`, `${milestone.key}: ${milestone.status}`);
      return false;
    }

    if (milestone.sla !== null && milestone.sla !== undefined) {
      const slaText = String(milestone.sla);
      if (/\d+h remaining|\d+d/.test(slaText)) {
        fail(`${label} fake SLA`, `${milestone.key}: ${milestone.sla}`);
        return false;
      }
    }
  }

  pass(`${label} lifecycle shape and statuses`);
  return true;
}

async function findSampleRequisitions() {
  const approvedWithBudget = await pool.query(
    `SELECT r.requisition_code
     FROM rm_requisitions r
     JOIN wp_approved_positions p ON r.approved_position_id = p.position_id
     WHERE r.req_status = 'Approved'
     LIMIT 1`
  );

  const approvedNoRecruiter = await pool.query(
    `SELECT r.requisition_code
     FROM rm_requisitions r
     LEFT JOIN rm_recruiter_assignments a
       ON a.requisition_code = r.requisition_code AND a.is_active = true
     WHERE r.req_status = 'Approved' AND a.assignment_id IS NULL
     LIMIT 1`
  );

  const withRecruiter = await pool.query(
    `SELECT DISTINCT r.requisition_code
     FROM rm_requisitions r
     JOIN rm_recruiter_assignments a
       ON a.requisition_code = r.requisition_code AND a.is_active = true
     LIMIT 1`
  );

  const withCandidates = await pool.query(
    `SELECT DISTINCT r.requisition_code
     FROM rm_requisitions r
     JOIN rm_candidate_mappings m
       ON m.requisition_code = r.requisition_code AND m.is_active = true
     LIMIT 1`
  );

  const noCandidates = await pool.query(
    `SELECT r.requisition_code
     FROM rm_requisitions r
     LEFT JOIN rm_candidate_mappings m
       ON m.requisition_code = r.requisition_code AND m.is_active = true
     WHERE m.mapping_id IS NULL
     LIMIT 1`
  );

  const withInterviews = await pool.query(
    `SELECT DISTINCT requisition_code FROM im_interviews LIMIT 1`
  );

  const withOffers = await pool.query(
    `SELECT DISTINCT requisition_code FROM om_offers LIMIT 1`
  );

  const multiOffer = await pool.query(
    `SELECT requisition_code, COUNT(*)::int AS offer_count
     FROM om_offers
     GROUP BY requisition_code
     HAVING COUNT(*) > 1
     LIMIT 1`
  );

  const multiCandidate = await pool.query(
    `SELECT requisition_code, COUNT(*)::int AS candidate_count
     FROM rm_candidate_mappings
     WHERE is_active = true
     GROUP BY requisition_code
     HAVING COUNT(*) > 1
     LIMIT 1`
  );

  return {
    approvedWithBudget: approvedWithBudget.rows[0]?.requisition_code || null,
    approvedNoRecruiter: approvedNoRecruiter.rows[0]?.requisition_code || null,
    withRecruiter: withRecruiter.rows[0]?.requisition_code || null,
    withCandidates: withCandidates.rows[0]?.requisition_code || null,
    noCandidates: noCandidates.rows[0]?.requisition_code || null,
    withInterviews: withInterviews.rows[0]?.requisition_code || null,
    withOffers: withOffers.rows[0]?.requisition_code || null,
    multiOffer: multiOffer.rows[0]?.requisition_code || null,
    multiCandidate: multiCandidate.rows[0]?.requisition_code || null
  };
}

async function testServiceSnapshot(code, label) {
  if (!code) {
    console.log(`SKIP: ${label} — no sample requisition in database`);
    return null;
  }

  const row = await recruitmentService.loadRequisitionByCode(pool, code);
  if (!row) {
    fail(`${label} load requisition`, code);
    return null;
  }

  const snapshot = await buildLifecycleSnapshot(pool, row);
  assertLifecycleShape(snapshot, label);
  return snapshot;
}

async function testHttpLifecycle(token, code, expectedStatus, label) {
  const response = await fetch(
    `${API_BASE_URL}/api/v1/hiring-control-tower/requisitions/${encodeURIComponent(code)}/lifecycle`,
    {
      headers: token ? { Authorization: `Bearer ${token}` } : {}
    }
  );

  const body = await readJson(response);

  if (response.status !== expectedStatus) {
    fail(`${label} HTTP status`, `expected ${expectedStatus}, got ${response.status}`);
    return null;
  }

  pass(`${label} HTTP ${expectedStatus}`);

  if (expectedStatus === 200) {
    assertLifecycleShape(body.data, `${label} API`);
  }

  return body;
}

async function main() {
  console.log("=== HCT Phase 2B Lifecycle Verification ===\n");

  const samples = await findSampleRequisitions();
  console.log("Sample requisitions:", samples);

  const primaryCode = samples.approvedWithBudget || "REQ-2026-1261";

  await testServiceSnapshot(primaryCode, "Approved requisition with budget");
  await testServiceSnapshot(samples.approvedNoRecruiter, "Approved requisition without recruiter");
  await testServiceSnapshot(samples.withRecruiter, "Requisition with recruiter");
  await testServiceSnapshot(samples.noCandidates, "Requisition without candidates");
  await testServiceSnapshot(samples.withCandidates, "Requisition with candidates");
  await testServiceSnapshot(samples.withInterviews, "Requisition with interviews");
  await testServiceSnapshot(samples.withOffers, "Requisition with offer");
  await testServiceSnapshot(samples.multiOffer, "Requisition with multiple offers");
  await testServiceSnapshot(samples.multiCandidate, "Requisition with multiple candidates");

  const adminToken = signToken({
    user_id: 1,
    employee_code: "ADMIN001",
    role_name: "Admin",
    email_id: "admin@example.com"
  });

  const recruiterToken = signToken({
    user_id: 10,
    employee_code: "IGS0506",
    role_name: "Recruiter",
    email_id: "recruiter@example.com"
  });

  await testHttpLifecycle(adminToken, primaryCode, 200, "Admin valid lifecycle");
  await testHttpLifecycle(null, primaryCode, 401, "Missing token");
  await testHttpLifecycle(recruiterToken, primaryCode, 403, "Non-admin token");
  await testHttpLifecycle(adminToken, "REQ-DOES-NOT-EXIST-9999", 404, "Invalid requisition code");

  const validBody = await testHttpLifecycle(adminToken, primaryCode, 200, "Admin lifecycle response fields");

  if (validBody?.data) {
    const { summary, metadata } = validBody.data;

    if (!summary || typeof summary.activeCandidateCount !== "number") {
      fail("summary.activeCandidateCount present");
    } else {
      pass("summary.activeCandidateCount present");
    }

    if (!metadata?.primaryCandidateRule || !metadata?.primaryOfferRule) {
      fail("metadata aggregation rules present");
    } else {
      pass("metadata aggregation rules present");
    }

    const submitted = validBody.data.milestones.find((item) => item.key === "requisition_submitted");
    const approved = validBody.data.milestones.find((item) => item.key === "requisition_approved");

    if (
      approved?.status === "Completed"
      && submitted?.status === "Completed"
      && !submitted.timestamp
    ) {
      fail("false inference guard", "Submitted marked Completed without timestamp");
    } else {
      pass("no obvious false submission inference");
    }
  }

  console.log("\nVerification complete.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
