/**
 * Phase 7E-2 — enterprise candidate experience read verification.
 * Run: node scripts/verifyPhase7eExperienceRead.js
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

function normalizeExperienceRows(rows = []) {
  return [...rows]
    .map((row) => ({
      experience_id: row.experience_id,
      candidate_id: row.candidate_id,
      company_name: row.company_name,
      designation: row.designation,
      joining_date: row.joining_date,
      relieving_date: row.relieving_date,
      role_summary: row.role_summary,
      technology: row.technology,
      reason_for_change: row.reason_for_change,
      active_flag: row.active_flag,
      created_on: row.created_on,
      modified_on: row.modified_on
    }))
    .sort((a, b) => Number(b.experience_id || 0) - Number(a.experience_id || 0));
}

function rowsEqual(left = [], right = []) {
  const a = normalizeExperienceRows(left);
  const b = normalizeExperienceRows(right);

  return JSON.stringify(a) === JSON.stringify(b);
}

async function main() {
  console.log("=== Phase 7E-2 Candidate Experience Read ===\n");

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

  const experienceCandidateId =
    ownedCandidate?.candidate_id ||
    poolCandidate?.candidate_id ||
    null;

  if (!experienceCandidateId) {
    fail("fixtures", "no readable candidate fixture found");
    await pool.end();
    return;
  }

  const enterprisePath = `/api/v1/recruitment/candidates/${experienceCandidateId}/experience`;
  const legacyPath = `/candidate/${experienceCandidateId}/experience`;

  const unauth = await fetchJson(enterprisePath);
  if (unauth.status === 401) {
    pass("HTTP: unauthenticated request rejected (401)");
  } else {
    fail("HTTP: unauthenticated request", `expected 401, got ${unauth.status}`);
  }

  const adminExperience = await fetchJson(enterprisePath, adminToken);
  if (adminExperience.status === 200 && adminExperience.body?.success === true) {
    pass("HTTP: Admin experience GET (200)");
  } else {
    fail("HTTP: Admin experience GET", `status=${adminExperience.status}`);
  }

  if (Array.isArray(adminExperience.body?.data)) {
    pass("Admin response shape includes success + data array");
  } else {
    fail("Admin response shape", "data is not an array");
  }

  const recruiterAllowed =
    ownedCandidate?.candidate_id === experienceCandidateId ||
    poolCandidate?.candidate_id === experienceCandidateId;

  const recruiterExperience = await fetchJson(enterprisePath, recruiterToken);

  if (recruiterAllowed) {
    if (recruiterExperience.status === 200 && recruiterExperience.body?.success === true) {
      pass("HTTP: authorized recruiter experience GET (200)");
    } else {
      fail(
        "HTTP: authorized recruiter experience GET",
        `status=${recruiterExperience.status}`
      );
    }
  } else {
    console.log("SKIP: authorized recruiter experience — no owned/pool fixture for recruiter");
  }

  if (foreignCandidate?.candidate_id) {
    const foreignPath = `/api/v1/recruitment/candidates/${foreignCandidate.candidate_id}/experience`;
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
    "/api/v1/recruitment/candidates/999999999/experience",
    adminToken
  );

  if (missing.status === 404) {
    pass("HTTP: missing candidate returns 404");
  } else {
    fail("HTTP: missing candidate", `expected 404, got ${missing.status}`);
  }

  const legacyExperience = await fetchJson(legacyPath, adminToken);

  if (legacyExperience.status === 200 && legacyExperience.body?.success === true) {
    pass("Legacy experience endpoint remains available");
  } else {
    fail(
      "Legacy experience endpoint",
      `expected 200, got ${legacyExperience.status}`
    );
  }

  if (rowsEqual(adminExperience.body?.data, legacyExperience.body?.data)) {
    pass("Enterprise experience rows match legacy GET /candidate/:id/experience");
  } else {
    fail(
      "Experience row parity",
      `enterprise=${(adminExperience.body?.data || []).length}, legacy=${(legacyExperience.body?.data || []).length}`
    );
  }

  const postAttempt = await fetchJson(enterprisePath, adminToken, {
    method: "POST",
    body: JSON.stringify({ company_name: "Should Not Create" })
  });

  if (postAttempt.status === 404 || postAttempt.status === 405) {
    pass("HTTP: endpoint is read-only (no POST handler)");
  } else {
    fail("HTTP: read-only check", `expected 404/405, got ${postAttempt.status}`);
  }

  const afterPost = await fetchJson(enterprisePath, adminToken);
  if (rowsEqual(afterPost.body?.data, legacyExperience.body?.data)) {
    pass("Experience rows unchanged after read-only probe");
  } else {
    fail("Experience rows unchanged", "enterprise data changed after POST probe");
  }

  await pool.end();

  if (process.exitCode) {
    console.log("\nPhase 7E-2 experience read verification completed with failures.");
  } else {
    console.log("\nAll Phase 7E-2 experience read checks passed.");
  }
}

main().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
  await pool.end();
});
