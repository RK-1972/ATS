/**
 * Classic Candidate bundle retirement verification.
 * Run: node scripts/verifyClassicCandidateRetirement.js
 */
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");

const API_BASE_URL = process.env.API_BASE_URL || "http://localhost:5000";
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const APP_JSX = path.join(REPO_ROOT, "ats-frontend", "src", "App.jsx");

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

const CLASSIC_ROUTES = [
  { method: "GET", path: "/pipeline-details" },
  { method: "GET", path: "/my-candidates-list" },
  { method: "POST", path: "/candidate-req-map", body: {} },
  { method: "POST", path: "/map-existing-candidate", body: {} },
  { method: "PUT", path: "/update-ats-stage/1", body: {} }
];

const INDEX_JS = path.join(REPO_ROOT, "ats-backend", "index.js");

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

async function fetchJson(routePath, token, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {})
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE_URL}${routePath}`, {
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

async function findActiveMappingSample() {
  const result = await pool.query(
    `SELECT m.map_id, m.candidate_id, m.requisition_code
     FROM rm_candidate_mappings m
     WHERE m.is_active = true
       AND m.map_id IS NOT NULL
     ORDER BY m.modified_on DESC NULLS LAST
     LIMIT 1`
  );
  return result.rows[0] || null;
}

async function findTalentPoolCandidate() {
  const result = await pool.query(
    `SELECT candidate_id
     FROM cand_mstr
     WHERE COALESCE(candidate_container, 'TALENT_POOL') = 'TALENT_POOL'
     ORDER BY candidate_id DESC
     LIMIT 1`
  );
  return result.rows[0] || null;
}

function verifyIndexRouteWiring() {
  const indexSource = fs.readFileSync(INDEX_JS, "utf8");
  const routeLiterals = [
    '"/pipeline-details"',
    '"/my-candidates-list"',
    '"/candidate-req-map"',
    '"/map-existing-candidate"',
    '"/update-ats-stage/:mapId"'
  ];

  for (const routeLiteral of routeLiterals) {
    if (!indexSource.includes(routeLiteral)) {
      fail(`index.js defines route ${routeLiteral}`);
      continue;
    }

    const routeIndex = indexSource.indexOf(routeLiteral);
    const routeWindow = indexSource.slice(routeIndex, routeIndex + 500);

    if (!routeWindow.includes("respondClassicCandidateRouteDeprecated")) {
      fail(`index.js wires ${routeLiteral} to deprecation handler`);
      continue;
    }

    pass(`index.js wires ${routeLiteral} to 410 handler`);
  }
}

function verifyDeprecationHandlerUnit() {
  const {
    respondClassicCandidateRouteDeprecated,
    CLASSIC_CANDIDATE_ROUTE_MESSAGE
  } = require("../utils/classicCandidateRouteDeprecation");

  let statusCode = null;
  let payload = null;

  respondClassicCandidateRouteDeprecated({
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      payload = body;
      return this;
    }
  });

  if (statusCode !== 410) {
    fail("deprecation handler status code", `status=${statusCode}`);
    return;
  }

  if (!payload?.deprecated || payload?.success !== false) {
    fail("deprecation handler payload shape");
    return;
  }

  if (!String(payload?.message || "").includes("retired")) {
    fail("deprecation handler message", payload?.message);
    return;
  }

  if (payload.message !== CLASSIC_CANDIDATE_ROUTE_MESSAGE) {
    fail("deprecation handler message constant mismatch");
    return;
  }

  pass("deprecation handler returns 410 Gone with message");
}

function verifyFrontendClassicRedirect() {
  const appSource = fs.readFileSync(APP_JSX, "utf8");

  if (!appSource.includes('path="/candidates/classic"')) {
    fail("frontend /candidates/classic route defined");
    return;
  }

  if (!appSource.includes('<Navigate to="/candidates" replace />')) {
    fail("frontend /candidates/classic redirects to /candidates");
    return;
  }

  if (appSource.includes("CandidatePage")) {
    fail("frontend CandidatePage removed from App.jsx routing");
    return;
  }

  pass("frontend /candidates/classic redirects to /candidates");
}

async function verifyClassicRoutesReturn410(token) {
  for (const route of CLASSIC_ROUTES) {
    const response = await fetchJson(route.path, token, {
      method: route.method,
      body: route.body ? JSON.stringify(route.body) : undefined
    });

    if (response.status !== 410) {
      fail(`${route.method} ${route.path} returns 410`, `status=${response.status}`);
      continue;
    }

    if (!response.body?.deprecated) {
      fail(`${route.method} ${route.path} deprecation payload`, "missing deprecated flag");
      continue;
    }

    if (!String(response.body?.message || "").includes("retired")) {
      fail(`${route.method} ${route.path} deprecation message`, response.body?.message);
      continue;
    }

    pass(`${route.method} ${route.path} returns 410 Gone`);
  }
}

async function verifyEnterpriseCandidateApis(token, mappingRow, poolCandidate) {
  const poolRead = await fetchJson(
    "/api/v1/recruitment/candidates?view=pool",
    token
  );

  if (poolRead.status === 200 && poolRead.body?.success) {
    pass("Enterprise candidate pool GET (200)");
  } else {
    fail("Enterprise candidate pool GET", `status=${poolRead.status}`);
  }

  const pipelineRead = await fetchJson(
    "/api/v1/recruitment/candidates?view=pipeline",
    token
  );

  if (pipelineRead.status === 200 && pipelineRead.body?.success) {
    pass("Enterprise candidate pipeline GET (200)");
  } else {
    fail("Enterprise candidate pipeline GET", `status=${pipelineRead.status}`);
  }

  const profileCandidateId = poolCandidate?.candidate_id || mappingRow?.candidate_id;

  if (profileCandidateId) {
    const profileRead = await fetchJson(
      `/api/v1/recruitment/candidates/${profileCandidateId}/profile`,
      token
    );

    if (profileRead.status === 200 && profileRead.body?.success) {
      pass("Enterprise candidate profile GET (200)");
    } else {
      fail("Enterprise candidate profile GET", `status=${profileRead.status}`);
    }
  } else {
    skip("Enterprise candidate profile GET", "no candidate sample in DB");
  }

  if (mappingRow?.map_id) {
    const stageProbe = await fetchJson(
      `/api/v1/recruitment/candidate-mappings/${mappingRow.map_id}/stage`,
      token,
      {
        method: "PUT",
        body: JSON.stringify({
          stage_name: "Applied",
          remarks: "Classic retirement verification"
        })
      }
    );

    if (stageProbe.status === 200 && stageProbe.body?.success) {
      pass("Enterprise candidate stage update PUT (200)");
    } else if (stageProbe.status === 403) {
      pass("Enterprise candidate stage update enforces authorization (403)");
    } else {
      fail("Enterprise candidate stage update PUT", `status=${stageProbe.status}`);
    }

    const historyRead = await fetchJson(
      `/api/v1/recruitment/candidate-mappings/${encodeURIComponent(mappingRow.map_id)}/pipeline-history`,
      token
    );

    if (historyRead.status === 200 && historyRead.body?.success) {
      pass("Enterprise mapping pipeline-history GET (200)");
    } else if (historyRead.status === 403) {
      pass("Enterprise mapping history enforces authorization (403)");
    } else {
      fail("Enterprise mapping pipeline-history GET", `status=${historyRead.status}`);
    }
  } else {
    skip("Enterprise mapping operations", "no active mapping sample");
  }
}

async function verifyCandidateIntake(token) {
  const intakeDashboard = await fetchJson("/candidate-intake/dashboard", token);

  if (intakeDashboard.status === 200 && intakeDashboard.body?.success) {
    pass("Candidate Intake dashboard GET still works (200)");
    return;
  }

  if (intakeDashboard.status === 403) {
    pass("Candidate Intake dashboard enforces role authorization (403)");
    return;
  }

  fail("Candidate Intake dashboard GET", `status=${intakeDashboard.status}`);
}

async function verifyAuthStillEnforced() {
  const unauthPool = await fetchJson("/api/v1/recruitment/candidates?view=pool", null);

  if (unauthPool.status === 401) {
    pass("Enterprise candidate pool requires auth (401)");
  } else {
    fail("Enterprise candidate pool requires auth", `status=${unauthPool.status}`);
  }

  const unauthClassic = await fetchJson("/pipeline-details", null);

  if (unauthClassic.status === 401) {
    pass("Deprecated classic route still requires auth before 410 (401)");
  } else {
    fail("Deprecated classic route auth", `status=${unauthClassic.status}`);
  }
}

async function main() {
  console.log("Classic Candidate Bundle Retirement Verification\n");

  verifyFrontendClassicRedirect();
  verifyIndexRouteWiring();
  verifyDeprecationHandlerUnit();

  const recruiter = await resolveUserByRole("Recruiter");
  if (!recruiter) {
    fail("resolve Recruiter user");
    await pool.end();
    return;
  }

  const token = signToken(recruiter);
  const mappingRow = await findActiveMappingSample();
  const poolCandidate = await findTalentPoolCandidate();

  await verifyClassicRoutesReturn410(token);
  await verifyEnterpriseCandidateApis(token, mappingRow, poolCandidate);
  await verifyCandidateIntake(token);
  await verifyAuthStillEnforced();

  await pool.end();

  if (process.exitCode) {
    console.log("\nVerification completed with failures.");
  } else {
    console.log("\nAll targeted checks passed.");
  }
}

main().catch((error) => {
  console.error("Verification script error:", error);
  process.exitCode = 1;
  pool.end().catch(() => {});
});
