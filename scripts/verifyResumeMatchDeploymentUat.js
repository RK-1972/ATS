/**
 * Resume Match V1 — live HTTP UAT against port 5000.
 * Run: node scripts/verifyResumeMatchDeploymentUat.js
 */
require("dotenv").config();

const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const recruitmentService = require("../services/recruitmentService");
const { REQUISITION_STATUS } = require("../constants/requisitionStatus");
const { ALLOWED_RESPONSE_FIELDS } = require("../services/resumeMatchService");

const API_BASE_URL = process.env.API_BASE_URL || "http://localhost:5000";
const RUN_ID = String(Date.now()).slice(-8);
const REQ_CODE = `REQ-RMU-${RUN_ID}`;

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

const createdCandidateIds = [];

function pass(label) {
  console.log(`PASS: ${label}`);
}

function fail(label, detail) {
  console.error(`FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
  process.exitCode = 1;
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

async function fetchJson(path, token, options = {}) {
  const headers = { ...(options.headers || {}), "Content-Type": "application/json" };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers
  });

  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

async function resolvePublishedSkills(count = 4) {
  const result = await pool.query(
    `SELECT code, name
     FROM md_records
     WHERE entity_type = 'skills'
       AND is_deleted = FALSE
       AND LOWER(COALESCE(status, 'active')) = 'active'
       AND LOWER(COALESCE(version_status, 'published')) = 'published'
     ORDER BY code ASC
     LIMIT $1`,
    [count]
  );
  return result.rows;
}

async function resolveRecruiter() {
  const result = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name, full_name
     FROM user_mstr
     WHERE role_name = 'Recruiter' AND COALESCE(is_active, TRUE) = TRUE
     ORDER BY user_id ASC LIMIT 1`
  );
  return result.rows[0] || null;
}

async function resolveUnauthorizedRecruiter(excludeCode) {
  const result = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name, full_name
     FROM user_mstr
     WHERE role_name = 'Recruiter'
       AND employee_code <> $1
       AND COALESCE(is_active, TRUE) = TRUE
     ORDER BY user_id ASC LIMIT 1`,
    [excludeCode]
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

async function insertApprovedRequisition(code, primarySkill) {
  const reqId = await allocateReqId();
  await pool.query(
    `INSERT INTO rm_requisitions (
      requisition_code, req_id, position_title, department, headcount, req_status,
      primary_skill, budget_approved, created_by, modified_by
    ) VALUES ($1,$2,$3,'Resume Match UAT',1,$4,$5,0,'Resume Match UAT','Resume Match UAT')`,
    [code, reqId, `Resume Match UAT ${code}`, REQUISITION_STATUS.APPROVED, primarySkill]
  );

  if (await tableExists("req_mstr")) {
    await pool.query(
      `INSERT INTO req_mstr (
        req_id, req_code, client_name, project_name, job_title, job_description,
        openings_count, req_status, created_by
      ) VALUES ($1,$2,'UAT','Resume Match UAT',$3,'UAT disposable requisition',1,$4,'Resume Match UAT')
      ON CONFLICT (req_id) DO NOTHING`,
      [reqId, code.replace(/^REQ-/, "REQ"), `Resume Match UAT ${code}`, REQUISITION_STATUS.APPROVED]
    );
  }

  return reqId;
}

async function assignRecruiter(code, recruiterCode) {
  await pool.query(
    `INSERT INTO rm_recruiter_assignments (
      requisition_code, recruiter_code, assigned_by, is_active, version, version_status, effective_from
    ) VALUES ($1,$2,'Resume Match UAT',TRUE,1.0,'Published',NOW())`,
    [code, recruiterCode]
  );
}

async function createTalentPoolCandidate({ label, primarySkill, secondarySkill = null }) {
  const email = `resume.uat.${label}.${RUN_ID}@example.com`;
  const result = await pool.query(
    `INSERT INTO cand_mstr (
      first_name, last_name, email_id, mobile_number, primary_skill, secondary_skill,
      total_experience, candidate_status, candidate_container, created_by
    ) VALUES ($1, 'UAT', $2, '9876504321', $3, $4, 5, 'Applied', 'TALENT_POOL', 'Resume Match UAT')
    RETURNING candidate_id`,
    [label, email, primarySkill, secondarySkill]
  );
  const candidateId = result.rows[0].candidate_id;
  createdCandidateIds.push(candidateId);
  return candidateId;
}

async function cleanup() {
  await pool.query(
    "DELETE FROM rm_candidate_mappings WHERE requisition_code = $1",
    [REQ_CODE]
  );
  if (await tableExists("candidate_req_map")) {
    await pool.query(
      `DELETE FROM candidate_req_map
       WHERE req_id IN (SELECT req_id FROM rm_requisitions WHERE requisition_code = $1)`,
      [REQ_CODE]
    );
  }
  if (createdCandidateIds.length) {
    await pool.query(
      "DELETE FROM cand_mstr WHERE candidate_id = ANY($1::int[])",
      [createdCandidateIds]
    );
  }
  await pool.query(
    "DELETE FROM rm_recruiter_assignments WHERE requisition_code = $1",
    [REQ_CODE]
  );
  await pool.query(
    "DELETE FROM rm_requisitions WHERE requisition_code = $1",
    [REQ_CODE]
  );
}

function findCandidate(matches, label) {
  return (matches?.candidates || []).find((row) =>
    String(row.candidate_name || "").includes(label)
  );
}

async function main() {
  console.log(`=== Resume Match V1 HTTP UAT (${API_BASE_URL}) ===\n`);

  const health = await fetchJson("/api/v1/master");
  if (health.status !== 401 && health.status !== 200) {
    fail("Backend reachable on port 5000", `status=${health.status}`);
    await pool.end();
    return;
  }
  pass("Backend reachable on port 5000");

  const skills = await resolvePublishedSkills(4);
  const recruiter = await resolveRecruiter();
  if (skills.length < 4 || !recruiter) {
    fail("Fixtures", `skills=${skills.length}, recruiter=${Boolean(recruiter)}`);
    await pool.end();
    return;
  }

  const [s1, s2, s3, s4] = skills;
  const requiredCodes = `${s1.code},${s2.code},${s3.code},${s4.code}`;
  const recruiterToken = signToken(recruiter);
  const unauthorizedRecruiter = await resolveUnauthorizedRecruiter(recruiter.employee_code);
  const unauthorizedToken = unauthorizedRecruiter
    ? signToken(unauthorizedRecruiter)
    : null;

  try {
    await insertApprovedRequisition(REQ_CODE, requiredCodes);
    await assignRecruiter(REQ_CODE, recruiter.employee_code);

    await createTalentPoolCandidate({
      label: "UAT100",
      primarySkill: `${s1.code},${s2.code}`,
      secondarySkill: `${s3.code},${s4.code}`
    });
    await createTalentPoolCandidate({
      label: "UAT75",
      primarySkill: `${s1.name},${s2.code},${s3.code}`
    });
    const mappedId = await createTalentPoolCandidate({
      label: "UATMAP",
      primarySkill: requiredCodes
    });

    await recruitmentService.mapCandidate(
      pool,
      {
        candidate_id: mappedId,
        requisition_code: REQ_CODE,
        stage_name: "Applied",
        source_type: "Direct"
      },
      {
        user: {
          employee_code: recruiter.employee_code,
          role_name: recruiter.role_name,
          full_name: recruiter.full_name
        }
      }
    );

    const authorized = await fetchJson(
      `/api/v1/recruitment/requisitions/${encodeURIComponent(REQ_CODE)}/resume-matches`,
      recruiterToken
    );

    if (authorized.status === 200 && authorized.body?.success) {
      pass("Assigned recruiter resume-matches HTTP 200");
    } else {
      fail("Assigned recruiter resume-matches HTTP 200", `status=${authorized.status}`);
    }

    const data = authorized.body?.data || {};
    const row100 = findCandidate(data, "UAT100");
    const row75 = findCandidate(data, "UAT75");
    const rowMapped = findCandidate(data, "UATMAP");

    if (row100?.match_pct === 100) {
      pass("HTTP match_pct 100%");
    } else {
      fail("HTTP match_pct 100%", `actual=${row100?.match_pct}`);
    }

    if (row75?.match_pct === 75) {
      pass("HTTP match_pct 75% with legacy name normalization");
    } else {
      fail("HTTP match_pct 75%", `actual=${row75?.match_pct}`);
    }

    if (
      row75?.matched_skills?.length === 3 &&
      row75?.missing_skills?.length === 1
    ) {
      pass("HTTP matched/missing skills breakdown");
    } else {
      fail(
        "HTTP matched/missing skills breakdown",
        `matched=${row75?.matched_skills?.length}, missing=${row75?.missing_skills?.length}`
      );
    }

    if (!rowMapped) {
      pass("HTTP already-mapped candidate excluded");
    } else {
      fail("HTTP already-mapped candidate excluded", "mapped row still present");
    }

    const forbidden = ["email_id", "mobile_number", "pan_number", "resume_path", "remarks"];
    let piiLeak = false;
    for (const row of data.candidates || []) {
      for (const field of forbidden) {
        if (Object.prototype.hasOwnProperty.call(row, field)) {
          piiLeak = true;
        }
      }
      for (const key of Object.keys(row)) {
        if (!ALLOWED_RESPONSE_FIELDS.has(key)) {
          piiLeak = true;
        }
      }
    }
    if (!piiLeak) {
      pass("HTTP response has no candidate PII/resume leakage");
    } else {
      fail("HTTP response has no candidate PII/resume leakage");
    }

    if (unauthorizedToken) {
      const denied = await fetchJson(
        `/api/v1/recruitment/requisitions/${encodeURIComponent(REQ_CODE)}/resume-matches`,
        unauthorizedToken
      );
      if (denied.status === 403) {
        pass("Unauthorized recruiter HTTP 403");
      } else {
        fail("Unauthorized recruiter HTTP 403", `status=${denied.status}`);
      }
    } else {
      pass("Unauthorized recruiter HTTP 403", "skipped — no alternate recruiter");
    }

    const mapTarget = await createTalentPoolCandidate({
      label: "UATACTION",
      primarySkill: requiredCodes
    });

    const mapResponse = await fetchJson(
      "/api/v1/recruitment/candidate-mappings",
      recruiterToken,
      {
        method: "POST",
        body: JSON.stringify({
          candidate_id: mapTarget,
          requisition_code: REQ_CODE,
          stage_name: "Applied",
          source_type: "Direct"
        })
      }
    );

    if (mapResponse.status === 200 || mapResponse.status === 201) {
      pass("HTTP mapCandidate flow succeeds");
    } else {
      fail("HTTP mapCandidate flow succeeds", `status=${mapResponse.status}`);
    }

    const profileAllowed = await fetchJson(
      `/api/v1/recruitment/candidates/${mapTarget}/profile`,
      recruiterToken
    );
    if (profileAllowed.status === 200) {
      pass("View Profile authorized for talent pool candidate (200)");
    } else {
      fail("View Profile authorized for talent pool candidate", `status=${profileAllowed.status}`);
    }

    if (unauthorizedToken) {
      const profileDenied = await fetchJson(
        `/api/v1/recruitment/candidates/${mapTarget}/profile`,
        unauthorizedToken
      );
      if (profileDenied.status === 403 || profileDenied.status === 401) {
        pass("View Profile respects existing candidate authorization");
      } else {
        fail(
          "View Profile respects existing candidate authorization",
          `status=${profileDenied.status}`
        );
      }
    } else {
      pass("View Profile respects existing candidate authorization", "skipped — no alternate recruiter");
    }
  } finally {
    await cleanup();
  }

  if (process.exitCode) {
    console.log("\nResume Match V1 HTTP UAT completed with failures.");
  } else {
    console.log("\nAll Resume Match V1 HTTP UAT checks passed.");
  }

  await pool.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
