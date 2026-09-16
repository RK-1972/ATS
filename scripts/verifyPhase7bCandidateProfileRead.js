/**
 * Phase 7B — enterprise candidate workspace profile read verification.
 * Run: node scripts/verifyPhase7bCandidateProfileRead.js
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

function assertProfileBundle(data, label) {
  if (!data?.master?.candidate_id) {
    fail(`${label} master.candidate_id`, "missing");
    return false;
  }

  if (!data.master.email_id && !data.master.first_name) {
    fail(`${label} master profile fields`, "missing core identity fields");
    return false;
  }

  if (!("country_code" in data.master) || !("address_line" in data.master)) {
    fail(`${label} master address fields`, "missing merged address fields");
    return false;
  }

  if (!data.mapping || typeof data.mapping !== "object") {
    fail(`${label} mapping object`, "missing");
    return false;
  }

  if (String(data.mapping.candidate_id) !== String(data.master.candidate_id)) {
    fail(`${label} mapping candidate_id`, "does not match master");
    return false;
  }

  const mappingKeys = [
    "map_id",
    "req_id",
    "req_code",
    "stage_name",
    "source_type",
    "remarks"
  ];

  for (const key of mappingKeys) {
    if (!(key in data.mapping)) {
      fail(`${label} mapping.${key}`, "missing");
      return false;
    }
  }

  return true;
}

async function main() {
  console.log("=== Phase 7B Candidate Workspace Profile Read ===\n");

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

  const profileCandidateId =
    ownedCandidate?.candidate_id ||
    poolCandidate?.candidate_id ||
    null;

  if (!profileCandidateId) {
    fail("fixtures", "no readable candidate fixture found");
    await pool.end();
    return;
  }

  const adminProfile = await fetchJson(
    `/api/v1/recruitment/candidates/${profileCandidateId}/profile`,
    adminToken
  );

  if (adminProfile.status === 200 && adminProfile.body?.success) {
    pass("HTTP: Admin profile GET (200)");
  } else {
    fail("HTTP: Admin profile GET", `status=${adminProfile.status}`);
  }

  if (assertProfileBundle(adminProfile.body?.data, "Admin")) {
    pass("Admin response includes master + mapping bundle");
  }

  const recruiterProfile = await fetchJson(
    `/api/v1/recruitment/candidates/${profileCandidateId}/profile`,
    recruiterToken
  );

  const recruiterAllowed =
    ownedCandidate?.candidate_id === profileCandidateId ||
    poolCandidate?.candidate_id === profileCandidateId;

  if (recruiterAllowed) {
    if (recruiterProfile.status === 200 && recruiterProfile.body?.success) {
      pass("HTTP: authorized recruiter profile GET (200)");
    } else {
      fail("HTTP: authorized recruiter profile GET", `status=${recruiterProfile.status}`);
    }
  } else {
    console.log("SKIP: authorized recruiter profile — no owned/pool fixture for recruiter");
  }

  if (foreignCandidate?.candidate_id) {
    const denied = await fetchJson(
      `/api/v1/recruitment/candidates/${foreignCandidate.candidate_id}/profile`,
      recruiterToken
    );

    if (denied.status === 403) {
      pass("HTTP: foreign/unowned recruiter denied (403)");
    } else {
      fail("HTTP: foreign/unowned recruiter", `expected 403, got ${denied.status}`);
    }
  } else {
    console.log("SKIP: foreign recruiter denial — no foreign-owned PIPELINE fixture");
  }

  const missing = await fetchJson(
    "/api/v1/recruitment/candidates/999999999/profile",
    adminToken
  );

  if (missing.status === 404) {
    pass("HTTP: missing candidate returns 404");
  } else {
    fail("HTTP: missing candidate", `expected 404, got ${missing.status}`);
  }

  const postAttempt = await fetchJson(
    `/api/v1/recruitment/candidates/${profileCandidateId}/profile`,
    adminToken,
    { method: "POST", body: JSON.stringify({}) }
  );

  if (postAttempt.status === 404 || postAttempt.status === 405) {
    pass("HTTP: endpoint is read-only (no POST handler)");
  } else {
    fail("HTTP: read-only check", `expected 404/405, got ${postAttempt.status}`);
  }

  const legacyMaster = await fetchJson(`/candidate/${profileCandidateId}`, adminToken);
  const legacyDetails = await fetchJson(
    `/candidate-full-details/${profileCandidateId}`,
    adminToken
  );

  if (legacyMaster.status === 200 && legacyDetails.status === 200) {
    pass("Legacy profile endpoints remain available");
  } else {
    fail(
      "Legacy profile endpoints",
      `master=${legacyMaster.status}, details=${legacyDetails.status}`
    );
  }

  const bundle = adminProfile.body?.data;
  const legacyMasterData = legacyMaster.body?.data;
  const legacyMappingData = legacyDetails.body?.data;

  if (
    bundle?.master?.candidate_id === legacyMasterData?.candidate_id &&
    String(bundle?.master?.email_id || "") === String(legacyMasterData?.email_id || "")
  ) {
    pass("Bundle master aligns with legacy GET /candidate/:id");
  } else {
    fail("Bundle master alignment", "candidate identity mismatch vs legacy master");
  }

  if (
    String(bundle?.mapping?.map_id ?? "") === String(legacyMappingData?.map_id ?? "") &&
    String(bundle?.mapping?.stage_name ?? "") === String(legacyMappingData?.stage_name ?? "")
  ) {
    pass("Bundle mapping aligns with legacy GET /candidate-full-details/:id");
  } else {
    fail("Bundle mapping alignment", "mapping fields mismatch vs legacy details");
  }

  await pool.end();

  if (process.exitCode) {
    console.log("\nPhase 7B candidate profile read verification completed with failures.");
  } else {
    console.log("\nAll Phase 7B candidate profile read checks passed.");
  }
}

main().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
  await pool.end();
});
