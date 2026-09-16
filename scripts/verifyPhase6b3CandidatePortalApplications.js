/**
 * Phase 6B-3 — Candidate portal My Applications API verification.
 * Run: node scripts/verifyPhase6b3CandidatePortalApplications.js
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

async function fetchJson(path, token, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {})
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const contentType = String(response.headers.get("content-type") || "");
  const rawText = await response.text();
  let body = {};

  if (contentType.includes("application/json") || rawText.trim().startsWith("{")) {
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

async function registerAndLogin(emailId, fullName) {
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

  const loginResult = await portalService.loginCandidateAccount({
    email_id: emailId,
    password
  });

  if (!loginResult.ok) {
    throw new Error(loginResult.message || "login failed");
  }

  return {
    token: loginResult.data.token,
    candidateId: registerResult.data.account.candidate_id,
    candidateContext: {
      candidate_id: registerResult.data.account.candidate_id,
      email_id: emailId,
      full_name: fullName
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

function buildMinimalPdfBuffer() {
  const pdfText = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Contents 4 0 R>>endobj
4 0 obj<</Length 120>>stream
BT /F1 12 Tf 72 720 Td (John Portal Doe) Tj 0 -20 Td (Email: portal.http.test@example.com) Tj 0 -20 Td (Mobile: 9876543210) Tj 0 -20 Td (Skills: Java SQL) Tj 0 -20 Td (Experience: 5 years) Tj ET
endstream
endobj
xref
0 5
0000000000 65535 f 
0000000009 00000 n 
0000000052 00000 n 
0000000101 00000 n 
0000000204 00000 n 
trailer<</Size 5/Root 1 0 R>>
startxref
380
%%EOF`;

  return Buffer.from(pdfText, "utf8");
}

async function completePortalProfileFlow(token, emailId) {
  const intakeResult = await fetchJson("/candidate-portal/profile/intake", token, {
    method: "POST"
  });

  const intakeId = intakeResult.body.data?.intake_id;

  if (!intakeResult.response.ok || !intakeId) {
    throw new Error(
      intakeResult.body.message || "failed to create profile intake"
    );
  }

  const formData = new FormData();
  formData.append(
    "resume",
    new Blob([buildMinimalPdfBuffer()], { type: "application/pdf" }),
    "portal-apps-test.pdf"
  );

  const processResponse = await fetch(
    `${API_BASE_URL}/candidate-portal/profile/intake/${intakeId}/process`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`
      },
      body: formData
    }
  );

  const processBody = await processResponse.json().catch(() => ({}));

  if (!processResponse.ok) {
    throw new Error(processBody.message || "failed to upload resume");
  }

  const parseResult = await fetchJson(
    `/candidate-portal/profile/intake/${intakeId}/parse`,
    token,
    { method: "POST" }
  );

  if (!parseResult.response.ok) {
    throw new Error(parseResult.body.message || "failed to parse resume");
  }

  const profile =
    parseResult.body.data?.profile ||
    parseResult.body.data?.parsed_candidate ||
    parseResult.body.data ||
    {};

  const saveResult = await fetchJson("/candidate-portal/profile", token, {
    method: "PUT",
    body: {
      first_name: profile.first_name || "John",
      last_name: profile.last_name || "Doe",
      email: profile.email || emailId,
      mobile: profile.mobile || "9876504444",
      current_company: profile.current_company || "",
      designation: profile.designation || "",
      experience: profile.experience || "5",
      skills: profile.skills || "Java, SQL"
    }
  });

  if (!saveResult.response.ok) {
    throw new Error(saveResult.body.message || "failed to save profile");
  }
}

async function cleanupCandidate(candidateId) {
  await pool.query(
    `DELETE FROM rm_candidate_intake
     WHERE source_reference = $1`,
    [`portal-candidate:${candidateId}`]
  );

  const mappingRows = await pool.query(
    `SELECT map_id, mapping_id
     FROM rm_candidate_mappings
     WHERE candidate_id = $1`,
    [candidateId]
  );

  const mapIds = mappingRows.rows
    .map((row) => row.map_id)
    .filter((value) => value != null);

  await pool.query(
    `DELETE FROM rm_pipeline_history
     WHERE candidate_id = $1`,
    [candidateId]
  );

  if (mapIds.length > 0) {
    await pool.query(
      `DELETE FROM candidate_req_map
       WHERE map_id = ANY($1::int[])`,
      [mapIds]
    );
  }

  await pool.query(
    `DELETE FROM candidate_req_map
     WHERE candidate_id = $1`,
    [candidateId]
  );
  await pool.query(
    `DELETE FROM rm_candidate_mappings
     WHERE candidate_id = $1`,
    [candidateId]
  );
  await pool.query(
    `DELETE FROM candidate_portal_account
     WHERE candidate_id = $1`,
    [candidateId]
  );
  await pool.query(
    `DELETE FROM cand_mstr
     WHERE candidate_id = $1`,
    [candidateId]
  );
}

function assertCandidateSafeApplication(application) {
  for (const key of Object.keys(application || {})) {
    if (!recruitmentService.CANDIDATE_PORTAL_APPLICATION_ALLOWED_FIELDS.has(key)) {
      fail(`response excludes internal field ${key}`);
      return false;
    }
  }

  if (
    application?.stage_name &&
    recruitmentService.CANDIDATE_PORTAL_INTERVIEW_MICRO_STATE_PATTERN.test(
      application.stage_name
    )
  ) {
    fail(
      "interview micro-state not exposed as stage_name",
      application.stage_name
    );
    return false;
  }

  return true;
}

async function main() {
  const uniqueSuffix = Date.now();
  const emailA = `portal.apps.a.${uniqueSuffix}@example.com`;
  const emailB = `portal.apps.b.${uniqueSuffix}@example.com`;

  const candidateA = await registerAndLogin(emailA, "Apps Candidate A");
  const candidateB = await registerAndLogin(emailB, "Apps Candidate B");

  pass("register and login portal candidates");

  const emptyList = await recruitmentService.listCandidatePortalApplications(
    pool,
    candidateA.candidateContext
  );

  if (!Array.isArray(emptyList) || emptyList.length !== 0) {
    fail("candidate with no applications returns empty list", String(emptyList?.length));
  } else {
    pass("candidate with no applications returns empty list");
  }

  const unauth = await fetchJson("/candidate-portal/applications");
  if (!unauth.isJson) {
    skip("http auth checks", "backend route not loaded — restart backend");
  } else if (unauth.response.status !== 401) {
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
      "/candidate-portal/applications",
      employeeToken
    );

    if (!employeeAttempt.isJson) {
      skip("employee token rejected", "backend route not loaded");
    } else if (employeeAttempt.response.status !== 403) {
      fail("employee token rejected", String(employeeAttempt.response.status));
    } else {
      pass("employee token rejected");
    }
  }

  const openRequisitionCode = await findOpenRequisitionWithoutActiveMapping(
    candidateA.candidateId
  );

  if (!openRequisitionCode) {
    skip("application list scenarios", "no open published requisition available");
    await cleanupCandidate(candidateA.candidateId);
    await cleanupCandidate(candidateB.candidateId);
    await pool.end();
    return;
  }

  try {
    await completePortalProfileFlow(candidateA.token, emailA);
    pass("complete portal profile flow before apply");
  } catch (error) {
    fail("complete portal profile flow before apply", error.message);
    await cleanupCandidate(candidateA.candidateId);
    await cleanupCandidate(candidateB.candidateId);
    await pool.end();
    return;
  }

  await recruitmentService.applyCandidateFromPortal(
    pool,
    candidateA.candidateContext,
    { requisition_code: openRequisitionCode }
  );

  pass("candidate application created for list test");

  const applications = await recruitmentService.listCandidatePortalApplications(
    pool,
    candidateA.candidateContext
  );

  if (!Array.isArray(applications) || applications.length !== 1) {
    fail("candidate sees own application", String(applications?.length));
  } else {
    pass("candidate sees own application");
  }

  const ownApplication = applications[0];

  if (ownApplication.requisition_code !== openRequisitionCode) {
    fail("application requisition_code matches", ownApplication.requisition_code);
  } else {
    pass("application requisition_code matches");
  }

  if (ownApplication.stage_name !== "Applied") {
    fail("catalog stage label Applied returned", ownApplication.stage_name);
  } else {
    pass("catalog stage label Applied returned");
  }

  if (!assertCandidateSafeApplication(ownApplication)) {
    // fail recorded
  } else {
    pass("application response is candidate-safe");
  }

  const mappingRow = await pool.query(
    `SELECT mapping_id
     FROM rm_candidate_mappings
     WHERE candidate_id = $1
       AND requisition_code = $2
     LIMIT 1`,
    [candidateA.candidateId, openRequisitionCode]
  );

  if (mappingRow.rows[0]) {
    await pool.query(
      `UPDATE rm_candidate_mappings
       SET stage_name = $1
       WHERE mapping_id = $2`,
      ["L1 Interview Scheduled", mappingRow.rows[0].mapping_id]
    );

    const microStateList = await recruitmentService.listCandidatePortalApplications(
      pool,
      candidateA.candidateContext
    );

    const microStage = microStateList[0]?.stage_name;

    if (microStage === "L1 Interview Scheduled") {
      fail("interview micro-state collapsed to catalog label", microStage);
    } else if (microStage !== "L1 Interview") {
      fail("interview micro-state maps to L1 Interview", microStage);
    } else {
      pass("interview micro-state maps to catalog L1 Interview");
    }
  } else {
    skip("interview micro-state mapping", "mapping row missing");
  }

  const otherCandidateList = await recruitmentService.listCandidatePortalApplications(
    pool,
    candidateB.candidateContext
  );

  if (!Array.isArray(otherCandidateList) || otherCandidateList.length !== 0) {
    fail("cross-candidate isolation", String(otherCandidateList?.length));
  } else {
    pass("cross-candidate isolation");
  }

  if (unauth.isJson) {
    const httpEmpty = await fetchJson(
      "/candidate-portal/applications",
      candidateB.token
    );

    if (
      httpEmpty.response.status === 200 &&
      Array.isArray(httpEmpty.body.data?.applications) &&
      httpEmpty.body.data.applications.length === 0
    ) {
      pass("http empty applications list");
    } else {
      fail("http empty applications list", String(httpEmpty.response.status));
    }

    const httpList = await fetchJson(
      "/candidate-portal/applications",
      candidateA.token
    );

    if (
      httpList.response.status === 200 &&
      Array.isArray(httpList.body.data?.applications) &&
      httpList.body.data.applications.length === 1
    ) {
      pass("http candidate applications list");
    } else {
      fail("http candidate applications list", String(httpList.response.status));
    }
  }

  await cleanupCandidate(candidateA.candidateId);
  await cleanupCandidate(candidateB.candidateId);

  pass("verification cleanup completed");
  console.log("Phase 6B-3 candidate portal applications verification finished.");
  await pool.end();
}

main().catch(async (error) => {
  fail("unexpected error", error.message);
  await pool.end();
});
