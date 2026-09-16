/**
 * Phase 7E-1 — enterprise candidate education read verification.
 * Run: node scripts/verifyPhase7eEducationRead.js
 *
 * Requires API server running at API_BASE_URL (default http://localhost:5000).
 */
require("dotenv").config();

const jwt = require("jsonwebtoken");
const { Pool } = require("pg");

const API_BASE_URL = process.env.API_BASE_URL || "http://localhost:5000";

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
  const headers = { ...(options.headers || {}) };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  if (options.body && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers
  });

  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

async function resolveUserByRole(roleName) {
  const result = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name, secondary_role
     FROM user_mstr
     WHERE role_name = $1 AND COALESCE(is_active, TRUE) = TRUE
     ORDER BY user_id ASC
     LIMIT 1`,
    [roleName]
  );
  return result.rows[0] || null;
}

async function resolveOwnedPipelineCandidate(recruiterCode) {
  const result = await pool.query(
    `SELECT candidate_id
     FROM cand_mstr
     WHERE owner_employee_code = $1
       AND UPPER(COALESCE(candidate_container, 'PIPELINE')) = 'PIPELINE'
     ORDER BY candidate_id DESC
     LIMIT 1`,
    [recruiterCode]
  );
  return result.rows[0] || null;
}

async function resolveForeignOwnedCandidate(recruiterCode) {
  const result = await pool.query(
    `SELECT candidate_id, owner_employee_code
     FROM cand_mstr
     WHERE owner_employee_code IS NOT NULL
       AND owner_employee_code <> $1
       AND UPPER(COALESCE(candidate_container, 'PIPELINE')) = 'PIPELINE'
     ORDER BY candidate_id DESC
     LIMIT 1`,
    [recruiterCode]
  );
  return result.rows[0] || null;
}

async function resolveTalentPoolCandidate() {
  const result = await pool.query(
    `SELECT candidate_id
     FROM cand_mstr
     WHERE UPPER(COALESCE(candidate_container, 'PIPELINE')) = 'TALENT_POOL'
     ORDER BY candidate_id DESC
     LIMIT 1`
  );
  return result.rows[0] || null;
}

function normalizeEducationRows(rows = []) {
  return [...rows]
    .map((row) => ({
      education_id: row.education_id,
      candidate_id: row.candidate_id,
      qualification: row.qualification,
      institution: row.institution,
      board_university: row.board_university,
      specialization: row.specialization,
      from_date: row.from_date,
      to_date: row.to_date,
      year_of_passing: row.year_of_passing,
      percentage: row.percentage,
      cgpa: row.cgpa,
      score_type: row.score_type
    }))
    .sort((a, b) => Number(b.education_id || 0) - Number(a.education_id || 0));
}

function rowsEqual(left = [], right = []) {
  const a = normalizeEducationRows(left);
  const b = normalizeEducationRows(right);

  return JSON.stringify(a) === JSON.stringify(b);
}

async function main() {
  console.log("=== Phase 7E-1 Candidate Education Read ===\n");

  const admin = await resolveUserByRole("Admin");
  const recruiter = await resolveUserByRole("Recruiter");

  if (!admin || !recruiter) {
    fail("fixtures", "Admin and Recruiter users required");
    await pool.end();
    return;
  }

  const ownedCandidate = await resolveOwnedPipelineCandidate(recruiter.employee_code);
  const foreignCandidate = await resolveForeignOwnedCandidate(recruiter.employee_code);
  const poolCandidate = await resolveTalentPoolCandidate();

  const adminToken = signToken(admin);
  const recruiterToken = signToken(recruiter);

  const educationCandidateId =
    ownedCandidate?.candidate_id ||
    poolCandidate?.candidate_id ||
    null;

  if (!educationCandidateId) {
    fail("fixtures", "no readable candidate fixture found");
    await pool.end();
    return;
  }

  const enterprisePath = `/api/v1/recruitment/candidates/${educationCandidateId}/education`;
  const legacyPath = `/candidate/${educationCandidateId}/education`;

  const unauth = await fetchJson(enterprisePath);
  if (unauth.status === 401) {
    pass("HTTP: unauthenticated request rejected (401)");
  } else {
    fail("HTTP: unauthenticated request", `expected 401, got ${unauth.status}`);
  }

  const adminEducation = await fetchJson(enterprisePath, adminToken);
  if (adminEducation.status === 200 && adminEducation.body?.success === true) {
    pass("HTTP: Admin education GET (200)");
  } else {
    fail("HTTP: Admin education GET", `status=${adminEducation.status}`);
  }

  if (Array.isArray(adminEducation.body?.data)) {
    pass("Admin response shape includes success + data array");
  } else {
    fail("Admin response shape", "data is not an array");
  }

  const recruiterAllowed =
    ownedCandidate?.candidate_id === educationCandidateId ||
    poolCandidate?.candidate_id === educationCandidateId;

  const recruiterEducation = await fetchJson(enterprisePath, recruiterToken);

  if (recruiterAllowed) {
    if (recruiterEducation.status === 200 && recruiterEducation.body?.success === true) {
      pass("HTTP: authorized recruiter education GET (200)");
    } else {
      fail(
        "HTTP: authorized recruiter education GET",
        `status=${recruiterEducation.status}`
      );
    }
  } else {
    console.log("SKIP: authorized recruiter education — no owned/pool fixture for recruiter");
  }

  if (foreignCandidate?.candidate_id) {
    const foreignPath = `/api/v1/recruitment/candidates/${foreignCandidate.candidate_id}/education`;
    const denied = await fetchJson(foreignPath, recruiterToken);

    if (denied.status === 403) {
      pass("HTTP: foreign/unowned recruiter denied (403)");
    } else {
      fail("HTTP: foreign/unowned recruiter", `expected 403, got ${denied.status}`);
    }
  } else {
    console.log("SKIP: foreign recruiter denial — no foreign-owned PIPELINE fixture");
  }

  const missing = await fetchJson(
    "/api/v1/recruitment/candidates/999999999/education",
    adminToken
  );

  if (missing.status === 404) {
    pass("HTTP: missing candidate returns 404");
  } else {
    fail("HTTP: missing candidate", `expected 404, got ${missing.status}`);
  }

  const legacyEducation = await fetchJson(legacyPath, adminToken);

  if (legacyEducation.status === 200 && legacyEducation.body?.success === true) {
    pass("Legacy education endpoint remains available");
  } else {
    fail(
      "Legacy education endpoint",
      `expected 200, got ${legacyEducation.status}`
    );
  }

  if (rowsEqual(adminEducation.body?.data, legacyEducation.body?.data)) {
    pass("Enterprise education rows match legacy GET /candidate/:id/education");
  } else {
    fail(
      "Education row parity",
      `enterprise=${(adminEducation.body?.data || []).length}, legacy=${(legacyEducation.body?.data || []).length}`
    );
  }

  const postAttempt = await fetchJson(enterprisePath, adminToken, {
    method: "POST",
    body: JSON.stringify({ qualification: "Should Not Create" })
  });

  if (postAttempt.status === 404 || postAttempt.status === 405) {
    pass("HTTP: endpoint is read-only (no POST handler)");
  } else {
    fail("HTTP: read-only check", `expected 404/405, got ${postAttempt.status}`);
  }

  const afterPost = await fetchJson(enterprisePath, adminToken);
  if (rowsEqual(afterPost.body?.data, legacyEducation.body?.data)) {
    pass("Education rows unchanged after read-only probe");
  } else {
    fail("Education rows unchanged", "enterprise data changed after POST probe");
  }

  await pool.end();

  if (process.exitCode) {
    console.log("\nPhase 7E-1 education read verification completed with failures.");
  } else {
    console.log("\nAll Phase 7E-1 education read checks passed.");
  }
}

main().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
  await pool.end();
});
