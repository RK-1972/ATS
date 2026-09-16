/**
 * O1 — Enterprise audit read API verification.
 * Run: node scripts/verifyO1AuditReadApi.js
 *
 * Requires API server running at API_BASE_URL (default http://localhost:5000).
 */
require("dotenv").config();

const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const { writeEnterpriseAudit } = require("../services/enterpriseAuditService");

const API_BASE_URL = process.env.API_BASE_URL || "http://localhost:5000";
const VERIFY_PREFIX = `o1-verify-${Date.now()}`;

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
      role_name: user.role_name
    },
    process.env.JWT_SECRET,
    { expiresIn: "1h" }
  );
}

async function fetchJson(path, token) {
  const headers = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE_URL}${path}`, { headers });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

async function resolveUserByRole(roleName) {
  const result = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name
     FROM user_mstr
     WHERE role_name = $1 AND COALESCE(is_active, TRUE) = TRUE
     ORDER BY user_id ASC
     LIMIT 1`,
    [roleName]
  );
  return result.rows[0] || null;
}

async function seedAuditRows() {
  const correlationId = `${VERIFY_PREFIX}-corr`;
  const moduleName = "O1 Verify Test";

  await writeEnterpriseAudit(pool, {
    eventType: "O1VerifyOldest",
    module: moduleName,
    entity: "O1Fixture",
    entityId: `${VERIFY_PREFIX}-entity`,
    action: "O1 verify oldest event",
    userName: "O1 Verify Script",
    userRole: "Admin",
    correlationId,
    metadata: { sequence: 1 }
  });

  await new Promise((resolve) => setTimeout(resolve, 15));

  await writeEnterpriseAudit(pool, {
    eventType: "O1VerifyNewest",
    module: moduleName,
    entity: "O1Fixture",
    entityId: `${VERIFY_PREFIX}-entity`,
    action: "O1 verify newest event",
    userName: "O1 Verify Script",
    userRole: "Admin",
    correlationId,
    metadata: { sequence: 2 }
  });

  return { correlationId, moduleName };
}

async function main() {
  console.log("=== O1 Enterprise Audit Read API ===\n");

  const admin = await resolveUserByRole("Admin");
  const recruiter = await resolveUserByRole("Recruiter");

  if (!admin || !recruiter) {
    fail("fixtures", "Admin and Recruiter users required");
    await pool.end();
    return;
  }

  const { correlationId, moduleName } = await seedAuditRows();
  const adminToken = signToken(admin);
  const recruiterToken = signToken(recruiter);

  const noToken = await fetchJson("/api/v1/audit");
  if (noToken.status === 401) {
    pass("HTTP: no token denied (401)");
  } else {
    fail("HTTP: no token", `expected 401, got ${noToken.status}`);
  }

  const recruiterResponse = await fetchJson("/api/v1/audit", recruiterToken);
  if (recruiterResponse.status === 403) {
    pass("HTTP: non-Admin denied (403)");
  } else {
    fail("HTTP: non-Admin", `expected 403, got ${recruiterResponse.status}`);
  }

  const adminResponse = await fetchJson("/api/v1/audit?limit=10", adminToken);
  if (adminResponse.status !== 200 || !adminResponse.body?.success) {
    fail("HTTP: Admin list", `status=${adminResponse.status}`);
  } else {
    pass("HTTP: Admin list (200)");
  }

  const items = adminResponse.body?.data?.items;
  if (!Array.isArray(items)) {
    fail("response shape", "data.items is not an array");
  } else {
    pass("response shape includes data.items array");
  }

  const pagination = adminResponse.body?.data?.pagination;
  if (
    !pagination
    || typeof pagination.page !== "number"
    || typeof pagination.limit !== "number"
    || typeof pagination.total_count !== "number"
  ) {
    fail("pagination shape", JSON.stringify(pagination));
  } else {
    pass("pagination includes page, limit, total_count");
  }

  const filteredByModule = await fetchJson(
    `/api/v1/audit?module=${encodeURIComponent(moduleName)}&limit=50`,
    adminToken
  );
  const moduleItems = filteredByModule.body?.data?.items || [];
  if (moduleItems.length < 2) {
    fail("module filter", `expected >= 2 rows, got ${moduleItems.length}`);
  } else {
    pass("module filter returns seeded rows");
  }

  const filteredByCorrelation = await fetchJson(
    `/api/v1/audit?correlationId=${encodeURIComponent(correlationId)}&limit=50`,
    adminToken
  );
  const correlationItems = filteredByCorrelation.body?.data?.items || [];
  if (correlationItems.length !== 2) {
    fail("correlationId filter", `expected 2 rows, got ${correlationItems.length}`);
  } else {
    pass("correlationId filter returns seeded rows");
  }

  const filteredByEventType = await fetchJson(
    `/api/v1/audit?eventType=O1VerifyNewest&correlationId=${encodeURIComponent(correlationId)}`,
    adminToken
  );
  const eventItems = filteredByEventType.body?.data?.items || [];
  if (eventItems.length !== 1 || eventItems[0]?.eventType !== "O1VerifyNewest") {
    fail("eventType filter", `rows=${eventItems.length}, eventType=${eventItems[0]?.eventType}`);
  } else {
    pass("eventType filter returns matching row");
  }

  const filteredByEntity = await fetchJson(
    `/api/v1/audit?entity=O1Fixture&entityId=${encodeURIComponent(`${VERIFY_PREFIX}-entity`)}&correlationId=${encodeURIComponent(correlationId)}`,
    adminToken
  );
  const entityItems = filteredByEntity.body?.data?.items || [];
  if (entityItems.length !== 2) {
    fail("entity/entityId filter", `expected 2 rows, got ${entityItems.length}`);
  } else {
    pass("entity and entityId filters return seeded rows");
  }

  const newestFirst = correlationItems[0];
  if (newestFirst?.eventType !== "O1VerifyNewest") {
    fail("newest-first order", `first eventType=${newestFirst?.eventType}`);
  } else {
    pass("newest-first order");
  }

  if (newestFirst?.id && newestFirst?.timestamp && newestFirst?.user) {
    pass("items mapped to frontend audit shape");
  } else {
    fail("frontend audit shape", JSON.stringify(newestFirst));
  }

  const pageOne = await fetchJson(
    `/api/v1/audit?correlationId=${encodeURIComponent(correlationId)}&page=1&limit=1`,
    adminToken
  );
  const pageTwo = await fetchJson(
    `/api/v1/audit?correlationId=${encodeURIComponent(correlationId)}&page=2&limit=1`,
    adminToken
  );

  const pageOneItems = pageOne.body?.data?.items || [];
  const pageTwoItems = pageTwo.body?.data?.items || [];
  const pageOneTotal = pageOne.body?.data?.pagination?.total_count;

  if (pageOneItems.length !== 1 || pageTwoItems.length !== 1) {
    fail("pagination slices", `page1=${pageOneItems.length}, page2=${pageTwoItems.length}`);
  } else if (pageOneItems[0]?.id === pageTwoItems[0]?.id) {
    fail("pagination slices", "page 1 and page 2 returned same item");
  } else {
    pass("pagination page/limit slices");
  }

  if (pageOneTotal !== 2) {
    fail("pagination total_count", `expected 2, got ${pageOneTotal}`);
  } else {
    pass("pagination total_count for filtered set");
  }

  await pool.end();

  if (process.exitCode) {
    console.log("\nO1 audit read API verification completed with failures.");
  } else {
    console.log("\nAll O1 audit read API checks passed.");
  }
}

main().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
  await pool.end();
});
