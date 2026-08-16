require("dotenv").config();

const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const {
  buildStageInspectorSnapshot,
  VALID_MILESTONE_KEYS,
  UNSUPPORTED_FIELDS
} = require("../services/hiringControlTowerStageInspector");
const recruitmentService = require("../services/recruitmentService");

const API_BASE_URL = process.env.API_BASE_URL || "http://localhost:5000";

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

const FORBIDDEN_RESPONSE_KEYS = [
  "sla_hours",
  "sla_remaining_hours",
  "completion_pct",
  "ai_recommendations",
  "notification_deliveries",
  "business_rule_execution"
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

function assertNoForbiddenFields(value, path = "root") {
  if (value == null) {
    return true;
  }

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!assertNoForbiddenFields(value[index], `${path}[${index}]`)) {
        return false;
      }
    }
    return true;
  }

  if (typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      if (FORBIDDEN_RESPONSE_KEYS.includes(key)) {
        fail("forbidden mock field in response", `${path}.${key}`);
        return false;
      }

      if (!assertNoForbiddenFields(nested, `${path}.${key}`)) {
        return false;
      }
    }
  }

  return true;
}

function assertInspectorShape(data, milestoneKey, label) {
  if (!data?.requisition_code) {
    fail(`${label} requisition_code`);
    return false;
  }

  if (data.milestone?.key !== milestoneKey) {
    fail(`${label} milestone key`, `expected ${milestoneKey}, got ${data.milestone?.key}`);
    return false;
  }

  if (!data.milestone?.label || !data.milestone?.status) {
    fail(`${label} milestone header fields`);
    return false;
  }

  if (!data.sections || typeof data.sections !== "object") {
    fail(`${label} sections object`);
    return false;
  }

  if (!Array.isArray(data.metadata?.unsupported_fields)) {
    fail(`${label} metadata.unsupported_fields`);
    return false;
  }

  for (const field of UNSUPPORTED_FIELDS) {
    if (!data.metadata.unsupported_fields.includes(field)) {
      fail(`${label} missing unsupported field`, field);
      return false;
    }
  }

  if (!assertNoForbiddenFields(data, label)) {
    return false;
  }

  pass(`${label} inspector shape for ${milestoneKey}`);
  return true;
}

async function findSampleRequisition() {
  const result = await pool.query(
    `SELECT requisition_code
     FROM rm_requisitions
     ORDER BY modified_on DESC NULLS LAST
     LIMIT 1`
  );

  return result.rows[0]?.requisition_code || null;
}

async function testServiceSnapshots(code) {
  for (const milestoneKey of EXPECTED_MILESTONE_KEYS) {
    const snapshot = await buildStageInspectorSnapshot(pool, code, milestoneKey);
    assertInspectorShape(snapshot, milestoneKey, "Service");
  }
}

async function testHttpInspector(token, code, milestoneKey, expectedStatus, label) {
  const response = await fetch(
    `${API_BASE_URL}/api/v1/hiring-control-tower/requisitions/${encodeURIComponent(code)}/stage-inspector/${encodeURIComponent(milestoneKey)}`,
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
    assertInspectorShape(body.data, milestoneKey, `${label} API`);
  }

  return body;
}

async function main() {
  console.log("=== HCT Phase 4B-1 Stage Inspector Verification ===\n");

  const sampleCode = (await findSampleRequisition()) || "REQ-2026-1261";
  console.log("Sample requisition:", sampleCode);

  try {
    await testServiceSnapshots(sampleCode);
  } catch (error) {
    if (error.status === 404) {
      fail("service snapshot", error.message);
    } else {
      throw error;
    }
  }

  const invalidKeyError = await buildStageInspectorSnapshot(pool, sampleCode, "invalid_milestone")
    .then(() => null)
    .catch((error) => error);

  if (!invalidKeyError || invalidKeyError.status !== 400) {
    fail("invalid milestone key", "expected 400 from service");
  } else {
    pass("invalid milestone key returns 400");
  }

  const missingReq = await buildStageInspectorSnapshot(
    pool,
    "REQ-DOES-NOT-EXIST-9999",
    "budget_submitted"
  )
    .then(() => null)
    .catch((error) => error);

  if (!missingReq || missingReq.status !== 404) {
    fail("missing requisition", "expected 404 from service");
  } else {
    pass("missing requisition returns 404");
  }

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

  await testHttpInspector(adminToken, sampleCode, "budget_submitted", 200, "Admin valid inspector");
  await testHttpInspector(null, sampleCode, "budget_submitted", 401, "Missing token");
  await testHttpInspector(recruiterToken, sampleCode, "budget_submitted", 403, "Non-admin token");
  await testHttpInspector(
    adminToken,
    "REQ-DOES-NOT-EXIST-9999",
    "budget_submitted",
    404,
    "Invalid requisition code"
  );
  await testHttpInspector(
    adminToken,
    sampleCode,
    "not_a_real_key",
    400,
    "Invalid milestone key"
  );

  for (const milestoneKey of EXPECTED_MILESTONE_KEYS) {
    await testHttpInspector(
      adminToken,
      sampleCode,
      milestoneKey,
      200,
      `Admin all milestones (${milestoneKey})`
    );
  }

  const candidateBody = await testHttpInspector(
    adminToken,
    sampleCode,
    "candidate_pipeline",
    200,
    "Candidate pipeline sections"
  );

  if (candidateBody?.data?.sections?.related_records?.candidates?.length > 20) {
    fail("candidate list truncation", "more than 20 candidates returned");
  } else {
    pass("candidate list size within limit or empty");
  }

  if (
    candidateBody?.data?.sections?.related_records?.candidates_truncated === true
    && candidateBody.data.sections.related_records.candidates.length > 20
  ) {
    fail("truncation flag consistency");
  } else {
    pass("truncation flag consistent when present");
  }

  console.log("\nValid milestone keys:", [...VALID_MILESTONE_KEYS].join(", "));
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
