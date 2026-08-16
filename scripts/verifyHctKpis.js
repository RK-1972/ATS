require("dotenv").config();

const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const { buildExecutiveKpiSnapshot } = require("../services/hiringControlTowerKpis");

const API_BASE_URL = process.env.API_BASE_URL || "http://localhost:5000";

const MOCK_KPI_VALUES = {
  active_hiring_processes: 24,
  pending_approvals: 6,
  clarification_requests: 2,
  budget_exceptions: 3,
  avg_approval_sla_hours: 18,
  avg_time_to_hire_days: 32,
  recruiter_workload: 8.4
};

const REQUIRED_KPI_KEYS = [
  "activeProcesses",
  "pendingApprovals",
  "clarifications",
  "budgetExceptions",
  "avgApprovalTimeHours",
  "configuredApprovalSlaHours",
  "avgTimeToHireDays",
  "recruiterWorkload"
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

function assertKpiShape(data, label) {
  if (!data?.kpis) {
    fail(`${label} missing kpis`, "");
    return false;
  }

  for (const key of REQUIRED_KPI_KEYS) {
    if (!(key in data.kpis)) {
      fail(`${label} missing KPI key`, key);
      return false;
    }
  }

  if (!data.metadata?.definitions) {
    fail(`${label} missing metadata.definitions`, "");
    return false;
  }

  pass(`${label} response shape`);
  return true;
}

function assertNoMockBundle(kpis, label) {
  const mockBundle = [
    MOCK_KPI_VALUES.active_hiring_processes,
    MOCK_KPI_VALUES.pending_approvals,
    MOCK_KPI_VALUES.clarification_requests,
    MOCK_KPI_VALUES.budget_exceptions,
    MOCK_KPI_VALUES.avg_approval_sla_hours,
    MOCK_KPI_VALUES.avg_time_to_hire_days,
    MOCK_KPI_VALUES.recruiter_workload
  ];

  const actualBundle = [
    kpis.activeProcesses,
    kpis.pendingApprovals,
    kpis.clarifications,
    kpis.budgetExceptions,
    kpis.avgApprovalTimeHours,
    kpis.avgTimeToHireDays,
    kpis.recruiterWorkload
  ];

  const matchesMockBundle = mockBundle.every(
    (value, index) => actualBundle[index] === value
  );

  if (matchesMockBundle) {
    fail(`${label} entire KPI bundle matches mock seed`, "");
    return false;
  }

  if (kpis.avgApprovalTimeHours === MOCK_KPI_VALUES.avg_approval_sla_hours) {
    fail(`${label} fake approval time`, "18h");
    return false;
  }

  pass(`${label} not mock KPI bundle`);
  return true;
}

async function testHttpKpis(token, expectedStatus, label) {
  const response = await fetch(`${API_BASE_URL}/api/v1/hiring-control-tower/kpis`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {}
  });

  const body = await readJson(response);

  if (response.status !== expectedStatus) {
    fail(`${label} HTTP status`, `expected ${expectedStatus}, got ${response.status}`);
    return null;
  }

  pass(`${label} HTTP ${expectedStatus}`);

  if (expectedStatus === 200) {
    assertKpiShape(body.data, label);
    assertNoMockBundle(body.data.kpis, label);
  }

  return body;
}

async function main() {
  console.log("=== HCT Phase 3B KPI Verification ===\n");

  const snapshot = await buildExecutiveKpiSnapshot(pool);
  assertKpiShape(snapshot, "Service snapshot");
  assertNoMockBundle(snapshot.kpis, "Service snapshot");

  if (typeof snapshot.kpis.activeProcesses !== "number") {
    fail("activeProcesses type", typeof snapshot.kpis.activeProcesses);
  } else {
    pass("activeProcesses is numeric");
  }

  if (typeof snapshot.kpis.pendingApprovals !== "number") {
    fail("pendingApprovals type", typeof snapshot.kpis.pendingApprovals);
  } else {
    pass("pendingApprovals is numeric");
  }

  if (typeof snapshot.kpis.clarifications !== "number") {
    fail("clarifications type", typeof snapshot.kpis.clarifications);
  } else {
    pass("clarifications is numeric");
  }

  if (typeof snapshot.kpis.budgetExceptions !== "number") {
    fail("budgetExceptions type", typeof snapshot.kpis.budgetExceptions);
  } else {
    pass("budgetExceptions is numeric");
  }

  if (
    snapshot.kpis.avgApprovalTimeHours !== null
    && typeof snapshot.kpis.avgApprovalTimeHours !== "number"
  ) {
    fail("avgApprovalTimeHours type", typeof snapshot.kpis.avgApprovalTimeHours);
  } else {
    pass("avgApprovalTimeHours null or numeric");
  }

  if (
    snapshot.kpis.avgTimeToHireDays !== null
    && typeof snapshot.kpis.avgTimeToHireDays !== "number"
  ) {
    fail("avgTimeToHireDays type", typeof snapshot.kpis.avgTimeToHireDays);
  } else {
    pass("avgTimeToHireDays null or numeric");
  }

  if (
    snapshot.kpis.recruiterWorkload !== null
    && typeof snapshot.kpis.recruiterWorkload !== "number"
  ) {
    fail("recruiterWorkload type", typeof snapshot.kpis.recruiterWorkload);
  } else {
    pass("recruiterWorkload null or numeric");
  }

  if (snapshot.metadata.approvalTimeWindowDays !== 90) {
    fail("approval window days", String(snapshot.metadata.approvalTimeWindowDays));
  } else {
    pass("approval window is 90 days");
  }

  console.log("\nSample KPI snapshot:", JSON.stringify(snapshot, null, 2));

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

  await testHttpKpis(adminToken, 200, "Admin KPIs");
  await testHttpKpis(null, 401, "Missing token");
  await testHttpKpis(recruiterToken, 403, "Non-admin token");

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
