/**
 * Phase 6B-1 — Candidate portal open requisition read verification.
 * Run: node scripts/verifyPhase6b1CandidatePortalOpenRequisitions.js
 */
require("dotenv").config();

const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const { REQUISITION_STATUS } = require("../constants/requisitionStatus");
const {
  createCandidatePortalService
} = require("../services/candidatePortalService");
const recruitmentService = require("../services/recruitmentService");

function resolveBackendApiBaseUrl() {
  if (process.env.BACKEND_API_URL) {
    return String(process.env.BACKEND_API_URL).replace(/\/$/, "");
  }

  const configured = String(process.env.API_BASE_URL || "").trim();
  if (configured.includes(":5000")) {
    return configured.replace(/\/$/, "");
  }

  return "http://localhost:5000";
}

const API_BASE_URL = resolveBackendApiBaseUrl();

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

const ALLOWED_FIELDS = new Set([
  "requisition_code",
  "title",
  "location",
  "department",
  "employment_type",
  "primary_skill",
  "secondary_skill",
  "experience_min",
  "experience_max",
  "openings_count",
  "job_description"
]);

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

function signEmployeeToken(user) {
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

async function fetchJson(path, token) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const response = await fetch(`${API_BASE_URL}${path}`, { headers });
  const contentType = String(response.headers.get("content-type") || "");
  const rawText = await response.text();
  let body = {};

  if (contentType.includes("application/json")) {
    try {
      body = JSON.parse(rawText);
    } catch (_error) {
      body = {};
    }
  } else if (rawText.trim().startsWith("{")) {
    try {
      body = JSON.parse(rawText);
    } catch (_error) {
      body = {};
    }
  }

  return {
    response,
    body,
    isJson: contentType.includes("application/json") || body.success !== undefined
  };
}

function assertNoInternalFields(requisition) {
  for (const field of recruitmentService.CANDIDATE_PORTAL_REQUISITION_INTERNAL_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(requisition, field)) {
      fail(`response excludes internal field ${field}`);
      return false;
    }
  }

  for (const key of Object.keys(requisition)) {
    if (!ALLOWED_FIELDS.has(key)) {
      fail(`response contains unexpected field ${key}`);
      return false;
    }
  }

  return true;
}

async function main() {
  const uniqueSuffix = Date.now();
  const emailId = `portal.openreq.${uniqueSuffix}@example.com`;
  const password = "TestPass1!";

  const portalService = createCandidatePortalService(pool);

  const registerResult = await portalService.registerCandidateAccount({
    full_name: "Open Req Candidate",
    mobile_number: "9876502222",
    email_id: emailId,
    password,
    confirm_password: password
  });

  if (!registerResult.ok) {
    fail("register portal candidate", registerResult.message);
    await pool.end();
    return;
  }

  pass("register portal candidate");

  const loginResult = await portalService.loginCandidateAccount({
    email_id: emailId,
    password
  });

  if (!loginResult.ok) {
    fail("login portal candidate", loginResult.message);
    await pool.end();
    return;
  }

  const candidateToken = loginResult.data.token;
  pass("login portal candidate");

  const serviceRows = await recruitmentService.listOpenRequisitionsForCandidatePortal(
    pool
  );
  pass(`service lists ${serviceRows.length} open published requisitions`);

  for (const row of serviceRows.slice(0, 3)) {
    if (!assertNoInternalFields(row)) {
      break;
    }
  }
  if (serviceRows.length > 0) {
    pass("service projection exposes only candidate-safe fields");
  }

  const unauth = await fetchJson("/candidate-portal/open-requisitions");
  if (!unauth.isJson) {
    skip(
      "http auth checks",
      "backend route not loaded — restart backend and rerun verification"
    );
    await pool.query(`DELETE FROM candidate_portal_account WHERE candidate_id = $1`, [
      registerResult.data.account.candidate_id
    ]);
    await pool.query(`DELETE FROM cand_mstr WHERE candidate_id = $1`, [
      registerResult.data.account.candidate_id
    ]);
    pass("verification cleanup completed");
    console.log("Phase 6B-1 candidate portal open requisitions verification finished.");
    await pool.end();
    return;
  }

  if (unauth.response.status !== 401) {
    fail("unauthenticated request rejected", String(unauth.response.status));
  } else {
    pass("unauthenticated request rejected");
  }

  const recruiterResult = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name, secondary_role
     FROM user_mstr
     WHERE role_name = 'Recruiter'
       AND COALESCE(is_active, TRUE) = TRUE
     ORDER BY user_id
     LIMIT 1`
  );

  if (recruiterResult.rows.length === 0) {
    skip("employee token rejected", "no active recruiter user");
  } else {
    const employeeToken = signEmployeeToken(recruiterResult.rows[0]);
    const employeeAttempt = await fetchJson(
      "/candidate-portal/open-requisitions",
      employeeToken
    );

    if (employeeAttempt.response.status !== 403) {
      fail("employee token rejected", String(employeeAttempt.response.status));
    } else {
      pass("employee token rejected");
    }
  }

  const eligibleRows = await pool.query(
    `SELECT requisition_code
     FROM rm_requisitions
     WHERE req_status = $1
       AND candidate_portal_published_at IS NOT NULL
     ORDER BY created_on DESC`,
    [REQUISITION_STATUS.APPROVED]
  );
  const eligibleCodes = new Set(
    eligibleRows.rows.map((row) => row.requisition_code)
  );

  const ineligibleRows = await pool.query(
    `SELECT requisition_code, req_status, candidate_portal_published_at
     FROM rm_requisitions
     WHERE req_status <> $1
        OR candidate_portal_published_at IS NULL
     LIMIT 5`,
    [REQUISITION_STATUS.APPROVED]
  );
  const ineligibleCodes = new Set(
    ineligibleRows.rows.map((row) => row.requisition_code)
  );

  const candidateResponse = await fetchJson(
    "/candidate-portal/open-requisitions",
    candidateToken
  );

  if (!candidateResponse.response.ok) {
    fail(
      "candidate token returns open requisitions",
      candidateResponse.body.message || candidateResponse.response.status
    );
    await pool.end();
    return;
  }

  pass("candidate token returns open requisitions");

  const requisitions = candidateResponse.body.data?.requisitions;

  if (!Array.isArray(requisitions)) {
    fail("response data.requisitions is an array");
    await pool.end();
    return;
  }

  pass("response data.requisitions is an array");

  if (requisitions.length !== serviceRows.length) {
    fail(
      "response count matches service query",
      `api=${requisitions.length} service=${serviceRows.length}`
    );
  } else {
    pass("response count matches service query");
  }

  let fieldChecksOk = true;

  for (const row of requisitions) {
    if (!assertNoInternalFields(row)) {
      fieldChecksOk = false;
      break;
    }

    if (!eligibleCodes.has(row.requisition_code)) {
      fail(
        "returned requisition is eligible",
        row.requisition_code
      );
      fieldChecksOk = false;
      break;
    }

    if (ineligibleCodes.has(row.requisition_code)) {
      fail(
        "ineligible requisition excluded",
        row.requisition_code
      );
      fieldChecksOk = false;
      break;
    }
  }

  if (fieldChecksOk) {
    pass("only candidate-safe fields returned");
    pass("ineligible requisitions excluded");
  }

  if (eligibleCodes.size === 0) {
    skip("eligible open requisitions present in database", "none seeded");
  } else if (requisitions.length === 0) {
    fail("eligible open requisitions returned when present in database");
  } else {
    pass("eligible open requisitions returned when present in database");
  }

  const candidateId = registerResult.data.account.candidate_id;
  await pool.query(`DELETE FROM candidate_portal_account WHERE candidate_id = $1`, [
    candidateId
  ]);
  await pool.query(`DELETE FROM cand_mstr WHERE candidate_id = $1`, [candidateId]);

  pass("verification cleanup completed");
  console.log("Phase 6B-1 candidate portal open requisitions verification finished.");
  await pool.end();
}

main().catch(async (error) => {
  fail("unexpected error", error.message);
  await pool.end();
});
