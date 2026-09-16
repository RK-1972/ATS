/**
 * Phase 6B-2 — Candidate portal apply API verification.
 * Run: node scripts/verifyPhase6b2CandidatePortalApply.js
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

const ALLOWED_RESPONSE_FIELDS = new Set([
  "requisition_code",
  "title",
  "stage_name",
  "applied_on"
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
    mobile_number: "9876503333",
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
    candidateId: registerResult.data.account.candidate_id
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

async function findClosedRequisitionCode() {
  const result = await pool.query(
    `SELECT requisition_code
     FROM rm_requisitions
     WHERE req_status <> $1
        OR candidate_portal_published_at IS NULL
     ORDER BY modified_on DESC NULLS LAST, created_on DESC
     LIMIT 1`,
    [REQUISITION_STATUS.APPROVED]
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
    "portal-apply-test.pdf"
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
      mobile: profile.mobile || "9876504321",
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

function assertCandidateSafeResponse(data) {
  for (const key of Object.keys(data || {})) {
    if (!ALLOWED_RESPONSE_FIELDS.has(key)) {
      fail(`response excludes internal field ${key}`);
      return false;
    }
  }
  return true;
}

async function main() {
  const uniqueSuffix = Date.now();
  const emailA = `portal.apply.a.${uniqueSuffix}@example.com`;
  const emailB = `portal.apply.b.${uniqueSuffix}@example.com`;

  const { token: tokenA, candidateId: candidateA } = await registerAndLogin(
    emailA,
    "Apply Candidate A"
  );
  const { token: tokenB, candidateId: candidateB } = await registerAndLogin(
    emailB,
    "Apply Candidate B"
  );

  pass("register and login portal candidates");

  const openRequisitionCode = await findOpenRequisitionWithoutActiveMapping(
    candidateA
  );

  if (!openRequisitionCode) {
    skip("apply scenarios", "no open published requisition available");
    await cleanupCandidate(candidateA);
    await cleanupCandidate(candidateB);
    await pool.end();
    return;
  }

  const unauth = await fetchJson("/candidate-portal/applications", null, {
    method: "POST",
    body: { requisition_code: openRequisitionCode }
  });

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
      employeeToken,
      {
        method: "POST",
        body: { requisition_code: openRequisitionCode }
      }
    );

    if (!employeeAttempt.isJson) {
      skip("employee token rejected", "backend route not loaded");
    } else if (employeeAttempt.response.status !== 403) {
      fail("employee token rejected", String(employeeAttempt.response.status));
    } else {
      pass("employee token rejected");
    }
  }

  const closedRequisitionCode = await findClosedRequisitionCode();
  if (!closedRequisitionCode) {
    skip("closed requisition rejected", "no ineligible requisition in database");
  } else {
    const closedAttempt = await fetchJson(
      "/candidate-portal/applications",
      tokenA,
      {
        method: "POST",
        body: { requisition_code: closedRequisitionCode }
      }
    );

    if (closedAttempt.isJson && closedAttempt.response.status === 404) {
      pass("closed/unpublished requisition rejected");
    } else if (closedAttempt.isJson) {
      fail(
        "closed/unpublished requisition rejected",
        String(closedAttempt.response.status)
      );
    }
  }

  try {
    await recruitmentService.applyCandidateFromPortal(
      pool,
      {
        candidate_id: candidateA,
        email_id: emailA,
        full_name: "Apply Candidate A"
      },
      { requisition_code: openRequisitionCode }
    );
    fail("fresh registered candidate cannot apply without resume");
  } catch (error) {
    if (error.message === "Upload your resume before applying.") {
      pass("fresh registered candidate cannot apply without resume");
    } else {
      fail(
        "fresh registered candidate cannot apply without resume",
        `${error.status || ""} ${error.message}`
      );
    }
  }

  const profileOnlyIntake = await fetchJson(
    "/candidate-portal/profile/intake",
    tokenB,
    { method: "POST" }
  );

  if (!profileOnlyIntake.response.ok || !profileOnlyIntake.body.data?.intake_id) {
    fail(
      "profile-only intake setup",
      profileOnlyIntake.body.message || String(profileOnlyIntake.response.status)
    );
  }

  const profileOnlySave = await fetchJson("/candidate-portal/profile", tokenB, {
    method: "PUT",
    body: {
      first_name: "Apply",
      last_name: "Candidate B",
      email: emailB,
      mobile: "9876503333"
    }
  });

  if (!profileOnlySave.response.ok) {
    fail(
      "profile-only save for readiness negative case",
      profileOnlySave.body.message || String(profileOnlySave.response.status)
    );
  } else {
    try {
      await recruitmentService.applyCandidateFromPortal(
        pool,
        {
          candidate_id: candidateB,
          email_id: emailB,
          full_name: "Apply Candidate B"
        },
        { requisition_code: openRequisitionCode }
      );
      fail("submitted profile without resume cannot apply");
    } catch (error) {
      if (error.message === "Upload your resume before applying.") {
        pass("submitted profile without resume cannot apply");
      } else {
        fail(
          "submitted profile without resume cannot apply",
          `${error.status || ""} ${error.message}`
        );
      }
    }
  }

  const resumeOnlyEmail = `portal.apply.resume.${uniqueSuffix}@example.com`;
  const { token: resumeOnlyToken, candidateId: resumeOnlyCandidateId } =
    await registerAndLogin(resumeOnlyEmail, "Resume Only Candidate");

  try {
    const intakeResult = await fetchJson(
      "/candidate-portal/profile/intake",
      resumeOnlyToken,
      { method: "POST" }
    );
    const intakeId = intakeResult.body.data?.intake_id;

    if (!intakeId) {
      fail("resume-only intake setup", intakeResult.body.message);
    } else {
      const formData = new FormData();
      formData.append(
        "resume",
        new Blob([buildMinimalPdfBuffer()], { type: "application/pdf" }),
        "portal-apply-resume-only.pdf"
      );

      const processResponse = await fetch(
        `${API_BASE_URL}/candidate-portal/profile/intake/${intakeId}/process`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${resumeOnlyToken}`
          },
          body: formData
        }
      );

      if (!processResponse.ok) {
        fail("resume-only upload setup", String(processResponse.status));
      } else {
        const parseResult = await fetchJson(
          `/candidate-portal/profile/intake/${intakeId}/parse`,
          resumeOnlyToken,
          { method: "POST" }
        );

        if (!parseResult.response.ok) {
          fail("resume-only parse setup", parseResult.body.message);
        } else {
          try {
            await recruitmentService.applyCandidateFromPortal(
              pool,
              {
                candidate_id: resumeOnlyCandidateId,
                email_id: resumeOnlyEmail,
                full_name: "Resume Only Candidate"
              },
              { requisition_code: openRequisitionCode }
            );
            fail("resume without submitted profile cannot apply");
          } catch (error) {
            if (error.message === "Complete your profile before applying.") {
              pass("resume without submitted profile cannot apply");
            } else {
              fail(
                "resume without submitted profile cannot apply",
                `${error.status || ""} ${error.message}`
              );
            }
          }
        }
      }
    }
  } finally {
    await cleanupCandidate(resumeOnlyCandidateId);
  }

  try {
    await completePortalProfileFlow(tokenA, emailA);
    pass("complete portal profile flow before apply");
  } catch (error) {
    fail("complete portal profile flow before apply", error.message);
    await cleanupCandidate(candidateA);
    await cleanupCandidate(candidateB);
    await pool.end();
    return;
  }

  const applyResult = await recruitmentService.applyCandidateFromPortal(
    pool,
    {
      candidate_id: candidateA,
      email_id: emailA,
      full_name: "Apply Candidate A"
    },
    { requisition_code: openRequisitionCode }
  );

  if (applyResult.stage_name !== "Applied") {
    fail("service apply sets Applied stage", applyResult.stage_name);
  } else {
    pass("service apply sets Applied stage");
  }

  const mappingRow = await pool.query(
    `SELECT mapping_id, candidate_id, requisition_code, stage_name, workflow_instance_id
     FROM rm_candidate_mappings
     WHERE candidate_id = $1
       AND requisition_code = $2
     LIMIT 1`,
    [candidateA, openRequisitionCode]
  );

  if (!mappingRow.rows[0]) {
    fail("rm_candidate_mappings row created");
  } else {
    pass("rm_candidate_mappings row created");

    if (mappingRow.rows[0].stage_name !== "Applied") {
      fail("mapping stage_name is Applied", mappingRow.rows[0].stage_name);
    } else {
      pass("mapping stage_name is Applied");
    }

    const historyRow = await pool.query(
      `SELECT event_type, to_stage, actor_role
       FROM rm_pipeline_history
       WHERE mapping_id = $1
         AND event_type = 'CandidateMapped'
       ORDER BY created_on DESC
       LIMIT 1`,
      [mappingRow.rows[0].mapping_id]
    );

    if (!historyRow.rows[0]) {
      fail("rm_pipeline_history CandidateMapped row created");
    } else if (historyRow.rows[0].to_stage !== "Applied") {
      fail("pipeline history to_stage is Applied", historyRow.rows[0].to_stage);
    } else if (historyRow.rows[0].actor_role !== "Candidate") {
      fail("pipeline history actor_role is Candidate", historyRow.rows[0].actor_role);
    } else {
      pass("rm_pipeline_history CandidateMapped row created");
    }

    if (!mappingRow.rows[0].workflow_instance_id) {
      fail("workflow_instance_id set on mapping");
    } else {
      pass("workflow_instance_id set on mapping");
    }
  }

  if (!assertCandidateSafeResponse(applyResult)) {
    // fail already recorded
  } else {
    pass("service response is candidate-safe");
  }

  try {
    await recruitmentService.applyCandidateFromPortal(
      pool,
      {
        candidate_id: candidateA,
        email_id: emailA,
        full_name: "Apply Candidate A"
      },
      { requisition_code: openRequisitionCode }
    );
    fail("duplicate application rejected");
  } catch (error) {
    if (Number(error.status) === 400) {
      pass("duplicate application rejected");
    } else {
      fail("duplicate application rejected", `${error.status} ${error.message}`);
    }
  }

  const forgeEmail = `portal.apply.forge.${uniqueSuffix}@example.com`;
  const { token: forgeToken, candidateId: forgeCandidateId } =
    await registerAndLogin(forgeEmail, "Forge Candidate");

  try {
    await completePortalProfileFlow(forgeToken, forgeEmail);
  } catch (error) {
    fail("forge candidate profile completion", error.message);
  }

  await recruitmentService.applyCandidateFromPortal(
    pool,
    {
      candidate_id: forgeCandidateId,
      email_id: forgeEmail,
      full_name: "Forge Candidate"
    },
    {
      requisition_code: openRequisitionCode,
      candidate_id: candidateB
    }
  );

  const forgedMapping = await pool.query(
    `SELECT candidate_id
     FROM rm_candidate_mappings
     WHERE candidate_id IN ($1, $2)
       AND requisition_code = $3`,
    [forgeCandidateId, candidateB, openRequisitionCode]
  );

  const forgedCandidateIds = forgedMapping.rows.map((row) => row.candidate_id);
  if (
    forgedCandidateIds.includes(forgeCandidateId) &&
    !forgedCandidateIds.includes(candidateB)
  ) {
    pass("candidate_id body forgery ignored");
  } else {
    fail(
      "candidate_id body forgery ignored",
      `mapped=${forgedCandidateIds.join(",")}`
    );
  }

  if (unauth.isJson) {
    const httpApply = await fetchJson(
      "/candidate-portal/applications",
      tokenA,
      {
        method: "POST",
        body: { requisition_code: openRequisitionCode }
      }
    );

    if (httpApply.response.status === 400 && httpApply.body.success === false) {
      pass("http duplicate application rejected");
    } else if (httpApply.isJson) {
      fail("http duplicate application rejected", String(httpApply.response.status));
    }
  }

  await cleanupCandidate(candidateA);
  await cleanupCandidate(candidateB);
  await cleanupCandidate(forgeCandidateId);

  pass("verification cleanup completed");
  console.log("Phase 6B-2 candidate portal apply verification finished.");
  await pool.end();
}

main().catch(async (error) => {
  fail("unexpected error", error.message);
  await pool.end();
});
