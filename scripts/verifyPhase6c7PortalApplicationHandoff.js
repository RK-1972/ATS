/**
 * Phase 6C-7 — Candidate Portal → Recruiter application handoff verification.
 * Run: node scripts/verifyPhase6c7PortalApplicationHandoff.js
 *
 * Requires API server running at API_BASE_URL (default http://localhost:5000).
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

function skip(label, reason) {
  console.log(`SKIP: ${label} — ${reason}`);
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

  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

async function resolveRecruiterWithAssignment() {
  const result = await pool.query(
    `SELECT DISTINCT u.user_id, u.employee_code, u.email_id, u.role_name, u.secondary_role,
            a.requisition_code
     FROM user_mstr u
     INNER JOIN rm_recruiter_assignments a
       ON a.recruiter_code = u.employee_code
      AND a.is_active = true
     INNER JOIN rm_requisitions r
       ON r.requisition_code = a.requisition_code
      AND r.req_status = $1
      AND r.candidate_portal_published_at IS NOT NULL
     WHERE u.role_name = 'Recruiter'
       AND COALESCE(u.is_active, TRUE) = TRUE
     ORDER BY u.user_id ASC
     LIMIT 1`,
    [REQUISITION_STATUS.APPROVED]
  );

  return result.rows[0] || null;
}

async function resolveOtherRecruiter(excludeCode) {
  const result = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name, secondary_role
     FROM user_mstr
     WHERE role_name = 'Recruiter'
       AND employee_code <> $1
       AND COALESCE(is_active, TRUE) = TRUE
     ORDER BY user_id ASC
     LIMIT 1`,
    [excludeCode]
  );

  return result.rows[0] || null;
}

async function findOpenUnassignedRequisitionCode() {
  const result = await pool.query(
    `SELECT r.requisition_code
     FROM rm_requisitions r
     WHERE r.req_status = $1
       AND r.candidate_portal_published_at IS NOT NULL
       AND NOT EXISTS (
         SELECT 1
         FROM rm_recruiter_assignments a
         WHERE a.requisition_code = r.requisition_code
           AND a.is_active = true
       )
     ORDER BY r.created_on DESC
     LIMIT 1`,
    [REQUISITION_STATUS.APPROVED]
  );

  return result.rows[0]?.requisition_code || null;
}

async function cleanupPortalCandidate(candidateId) {
  if (!candidateId) {
    return;
  }

  await pool.query(
    `DELETE FROM rm_pipeline_history
     WHERE candidate_id = $1`,
    [candidateId]
  );
  await pool.query(
    `DELETE FROM rm_candidate_mappings
     WHERE candidate_id = $1`,
    [candidateId]
  );
  await pool.query(
    `DELETE FROM candidate_req_map
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

  if (intakeResult.status !== 201 || !intakeId) {
    throw new Error(intakeResult.body.message || "failed to create profile intake");
  }

  const formData = new FormData();
  formData.append(
    "resume",
    new Blob([buildMinimalPdfBuffer()], { type: "application/pdf" }),
    "portal-handoff-test.pdf"
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

  if (parseResult.status !== 200) {
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
      mobile: profile.mobile || "9876543210",
      current_company: profile.current_company || "",
      designation: profile.designation || "",
      experience: profile.experience || "5",
      skills: profile.skills || "Java, SQL"
    }
  });

  if (saveResult.status !== 200) {
    throw new Error(saveResult.body.message || "failed to save profile");
  }
}

async function registerPortalCandidate(email) {
  const password = "TestPass1!";
  const portalService = createCandidatePortalService(pool);
  const registerResult = await portalService.registerCandidateAccount({
    full_name: "Portal Handoff Candidate",
    mobile_number: "9876543210",
    email_id: email,
    password,
    confirm_password: password
  });

  if (!registerResult.ok) {
    throw new Error(registerResult.message || "portal registration failed");
  }

  const loginResult = await portalService.loginCandidateAccount({
    email_id: email,
    password
  });

  if (!loginResult.ok) {
    throw new Error(loginResult.message || "portal login failed");
  }

  return {
    candidateId: registerResult.data.account.candidate_id,
    token: loginResult.data.token
  };
}

async function main() {
  console.log("=== Phase 6C-7 Portal Application Handoff ===\n");

  const assignedRecruiter = await resolveRecruiterWithAssignment();
  if (!assignedRecruiter) {
    skip("entire verification", "no recruiter with active open-requisition assignment");
    await pool.end();
    return;
  }

  const otherRecruiter = await resolveOtherRecruiter(assignedRecruiter.employee_code);
  const assignedToken = signEmployeeToken(assignedRecruiter);
  const otherToken = otherRecruiter ? signEmployeeToken(otherRecruiter) : null;
  const requisitionCode = assignedRecruiter.requisition_code;

  const uniqueSuffix = `${Date.now()}`;
  const email = `portal.handoff.${uniqueSuffix}@example.com`;
  let candidateId = null;
  let mappingId = null;

  try {
    const portal = await registerPortalCandidate(email);
    candidateId = portal.candidateId;

    await completePortalProfileFlow(portal.token, email);
    pass("complete portal profile flow before apply");

    const applyHttp = await fetchJson("/candidate-portal/applications", portal.token, {
      method: "POST",
      body: { requisition_code: requisitionCode }
    });

    if (applyHttp.status !== 201 || applyHttp.body.success !== true) {
      fail(
        "portal apply still works",
        `status=${applyHttp.status} message=${applyHttp.body.message || ""}`
      );
    } else {
      pass("portal apply still works");
    }

    const mappingRow = await pool.query(
      `SELECT mapping_id, stage_name, remarks
       FROM rm_candidate_mappings
       WHERE candidate_id = $1
         AND requisition_code = $2
       LIMIT 1`,
      [candidateId, requisitionCode]
    );

    mappingId = mappingRow.rows[0]?.mapping_id || null;

    if (!mappingId) {
      fail("rm_candidate_mappings row created for portal apply");
    } else {
      pass("rm_candidate_mappings row created for portal apply");
    }

    const ownerBefore = await pool.query(
      `SELECT owner_employee_code
       FROM cand_mstr
       WHERE candidate_id = $1`,
      [candidateId]
    );

    if (ownerBefore.rows[0]?.owner_employee_code) {
      fail("owner remains null before claim", ownerBefore.rows[0].owner_employee_code);
    } else {
      pass("owner remains null before claim");
    }

    const pendingAssigned = await fetchJson(
      "/api/v1/recruitment/pending-applications",
      assignedToken
    );

    if (pendingAssigned.status !== 200 || pendingAssigned.body.success !== true) {
      fail(
        "assigned recruiter pending list",
        `status=${pendingAssigned.status}`
      );
    } else {
      const found = (pendingAssigned.body.data || []).some(
        (row) => Number(row.mapping_id) === Number(mappingId)
      );

      if (found) {
        pass("assigned recruiter sees pending portal application");
      } else {
        fail(
          "assigned recruiter sees pending portal application",
          `count=${pendingAssigned.body.count}`
        );
      }
    }

    if (otherToken) {
      const pendingOther = await fetchJson(
        "/api/v1/recruitment/pending-applications",
        otherToken
      );

      if (pendingOther.status !== 200) {
        fail("unrelated recruiter pending list", `status=${pendingOther.status}`);
      } else {
        const leaked = (pendingOther.body.data || []).some(
          (row) => Number(row.mapping_id) === Number(mappingId)
        );

        if (!leaked) {
          pass("unrelated recruiter cannot see application");
        } else {
          fail("unrelated recruiter cannot see application");
        }
      }
    } else {
      skip("unrelated recruiter cannot see application", "no second recruiter user");
    }

    const unassignedCode = await findOpenUnassignedRequisitionCode();
    if (!unassignedCode) {
      skip("unassigned requisition not exposed", "no open unassigned requisition");
    } else {
      const unassignedEmail = `portal.handoff.unassigned.${uniqueSuffix}@example.com`;
      let unassignedCandidateId = null;

      try {
        const unassignedPortal = await registerPortalCandidate(unassignedEmail);
        unassignedCandidateId = unassignedPortal.candidateId;

        const unassignedApply = await fetchJson(
          "/candidate-portal/applications",
          unassignedPortal.token,
          {
            method: "POST",
            body: { requisition_code: unassignedCode }
          }
        );

        if (unassignedApply.status !== 201) {
          fail("portal apply on unassigned requisition", `status=${unassignedApply.status}`);
        } else {
          const unassignedMapping = await pool.query(
            `SELECT mapping_id
             FROM rm_candidate_mappings
             WHERE candidate_id = $1
               AND requisition_code = $2
             LIMIT 1`,
            [unassignedCandidateId, unassignedCode]
          );

          const unassignedMappingId = unassignedMapping.rows[0]?.mapping_id;

          const pendingAfterUnassigned = await fetchJson(
            "/api/v1/recruitment/pending-applications",
            assignedToken
          );

          const leakedUnassigned = (pendingAfterUnassigned.body.data || []).some(
            (row) => Number(row.mapping_id) === Number(unassignedMappingId)
          );

          if (!leakedUnassigned) {
            pass("unassigned requisition not exposed through assigned scope");
          } else {
            fail("unassigned requisition not exposed through assigned scope");
          }
        }
      } finally {
        await cleanupPortalCandidate(unassignedCandidateId);
      }
    }

    const claimHttp = await fetchJson(
      `/api/v1/recruitment/pending-applications/${mappingId}/claim`,
      assignedToken,
      { method: "POST", body: {} }
    );

    if (claimHttp.status !== 200 || claimHttp.body.success !== true) {
      fail("claim succeeds for assigned recruiter", `status=${claimHttp.status}`);
    } else {
      pass("claim succeeds for assigned recruiter");
    }

    const ownerAfter = await pool.query(
      `SELECT owner_employee_code, candidate_container
       FROM cand_mstr
       WHERE candidate_id = $1`,
      [candidateId]
    );

    if (ownerAfter.rows[0]?.owner_employee_code === assignedRecruiter.employee_code) {
      pass("owner set to assigned recruiter after claim");
    } else {
      fail(
        "owner set to assigned recruiter after claim",
        ownerAfter.rows[0]?.owner_employee_code || "null"
      );
    }

    const secondClaim = await fetchJson(
      `/api/v1/recruitment/pending-applications/${mappingId}/claim`,
      assignedToken,
      { method: "POST", body: {} }
    );

    if (secondClaim.status === 409) {
      pass("second claim cannot overwrite ownership");
    } else {
      fail("second claim cannot overwrite ownership", `status=${secondClaim.status}`);
    }

    if (otherToken) {
      const otherClaim = await fetchJson(
        `/api/v1/recruitment/pending-applications/${mappingId}/claim`,
        otherToken,
        { method: "POST", body: {} }
      );

      if (otherClaim.status === 409 || otherClaim.status === 403) {
        pass("other recruiter cannot claim owned application");
      } else {
        fail("other recruiter cannot claim owned application", `status=${otherClaim.status}`);
      }
    } else {
      skip("other recruiter cannot claim owned application", "no second recruiter user");
    }

    const pendingAfterClaim = await fetchJson(
      "/api/v1/recruitment/pending-applications",
      assignedToken
    );

    const stillPending = (pendingAfterClaim.body.data || []).some(
      (row) => Number(row.mapping_id) === Number(mappingId)
    );

    if (!stillPending) {
      pass("claimed application removed from pending list");
    } else {
      fail("claimed application removed from pending list");
    }

    const pipelineHttp = await fetchJson(
      "/api/v1/recruitment/candidates?view=pipeline",
      assignedToken
    );

    if (pipelineHttp.status !== 200) {
      fail("my pipeline read after claim", `status=${pipelineHttp.status}`);
    } else {
      const inPipeline = (pipelineHttp.body.data || []).some(
        (row) => Number(row.candidate_id) === Number(candidateId)
      );

      if (inPipeline) {
        pass("claimed candidate appears in My Pipeline");
      } else {
        fail("claimed candidate appears in My Pipeline");
      }
    }

    const serviceList = await recruitmentService.listPendingPortalApplications(pool, {
      user: assignedRecruiter
    });

    const serviceStillListsClaimed = serviceList.some(
      (row) => Number(row.mapping_id) === Number(mappingId)
    );

    if (!serviceStillListsClaimed) {
      pass("service pending list excludes claimed application");
    } else {
      fail("service pending list excludes claimed application");
    }
  } finally {
    await cleanupPortalCandidate(candidateId);
  }

  console.log("\nPhase 6C-7 portal application handoff verification finished.");
  await pool.end();
}

main().catch(async (error) => {
  fail("unexpected error", error.message);
  await pool.end();
});
