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

const FORBIDDEN_KEYS = [
  "sql_expression",
  "base_view_key",
  "dataSql",
  "countSql",
  "from_sql"
];

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

function collectKeys(value, keys = new Set()) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectKeys(item, keys));
    return keys;
  }

  if (value && typeof value === "object") {
    Object.entries(value).forEach(([key, nestedValue]) => {
      keys.add(key);
      collectKeys(nestedValue, keys);
    });
  }

  return keys;
}

function assertNoSensitiveKeys(payload, label) {
  const keys = collectKeys(payload);

  for (const forbiddenKey of FORBIDDEN_KEYS) {
    if (keys.has(forbiddenKey)) {
      fail(`${label} leaked sensitive key`, forbiddenKey);
      return false;
    }
  }

  pass(`${label} contains no SQL metadata`);
  return true;
}

async function postQuery(token, body) {
  return fetch(`${API_BASE_URL}/api/v1/reports/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
}

async function resolveAdminUser() {
  const result = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name
     FROM user_mstr
     WHERE role_name = 'Admin' AND COALESCE(is_active, TRUE) = TRUE
     ORDER BY user_id ASC
     LIMIT 1`
  );

  return result.rows[0] || null;
}

async function resolveNonAdminUser() {
  const result = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name
     FROM user_mstr
     WHERE role_name <> 'Admin' AND COALESCE(is_active, TRUE) = TRUE
     ORDER BY user_id ASC
     LIMIT 1`
  );

  return result.rows[0] || null;
}

async function main() {
  const adminUser = await resolveAdminUser();

  if (!adminUser) {
    fail("Admin user lookup", "No active Admin user found");
    await pool.end();
    return;
  }

  const adminToken = signToken({
    user_id: adminUser.user_id,
    employee_code: adminUser.employee_code,
    email_id: adminUser.email_id,
    role_name: adminUser.role_name
  });

  console.log("\n=== A. Admin CANDIDATE_PIPELINE query ===");
  const pipelineResponse = await postQuery(adminToken, {
    dataset: "CANDIDATE_PIPELINE",
    fields: [
      "requisition_code",
      "candidate_name",
      "stage_name",
      "assigned_recruiter_name"
    ],
    page: 1,
    pageSize: 5
  });
  const pipelineBody = await readJson(pipelineResponse);

  if (pipelineResponse.status !== 200 || !pipelineBody.success) {
    fail("CANDIDATE_PIPELINE query", JSON.stringify(pipelineBody));
  } else {
    pass("CANDIDATE_PIPELINE query returns 200");
    console.log(JSON.stringify(pipelineBody, null, 2));
    assertNoSensitiveKeys(pipelineBody, "CANDIDATE_PIPELINE query");

    if (!Array.isArray(pipelineBody.data?.rows)) {
      fail("CANDIDATE_PIPELINE rows array missing");
    } else {
      pass(`CANDIDATE_PIPELINE returned ${pipelineBody.data.rows.length} row(s)`);
    }
  }

  console.log("\n=== B. Admin REQUISITION_SUMMARY query ===");
  const reqResponse = await postQuery(adminToken, {
    dataset: "REQUISITION_SUMMARY",
    fields: ["requisition_code", "position_title", "department", "req_status"],
    sort: [{ field: "created_on", direction: "desc" }],
    page: 1,
    pageSize: 5
  });
  const reqBody = await readJson(reqResponse);

  if (reqResponse.status !== 200 || !reqBody.success) {
    fail("REQUISITION_SUMMARY query", JSON.stringify(reqBody));
  } else {
    pass("REQUISITION_SUMMARY query returns 200");
    console.log(JSON.stringify(reqBody, null, 2));
    assertNoSensitiveKeys(reqBody, "REQUISITION_SUMMARY query");
  }

  console.log("\n=== C. Invalid dataset ===");
  const invalidDatasetResponse = await postQuery(adminToken, {
    dataset: "UNKNOWN_DATASET",
    fields: ["requisition_code"]
  });
  const invalidDatasetBody = await readJson(invalidDatasetResponse);
  if (invalidDatasetResponse.status === 400) {
    pass("Invalid dataset rejected with 400");
  } else {
    fail("Invalid dataset status", String(invalidDatasetResponse.status));
  }
  console.log(JSON.stringify(invalidDatasetBody, null, 2));

  console.log("\n=== D/E. Unauthorized dataset (Recruiter) ===");
  const nonAdminUser = await resolveNonAdminUser();

  if (!nonAdminUser) {
    console.log("SKIP: No non-Admin user for unauthorized dataset test.");
  } else {
    const nonAdminToken = signToken({
      user_id: nonAdminUser.user_id,
      employee_code: nonAdminUser.employee_code,
      email_id: nonAdminUser.email_id,
      role_name: nonAdminUser.role_name
    });

    const unauthorizedResponse = await postQuery(nonAdminToken, {
      dataset: "CANDIDATE_PIPELINE",
      fields: ["candidate_name"]
    });
    const unauthorizedBody = await readJson(unauthorizedResponse);

    if (unauthorizedResponse.status === 404) {
      pass("Unauthorized dataset rejected with 404");
    } else {
      fail("Unauthorized dataset status", String(unauthorizedResponse.status));
    }
    console.log(JSON.stringify(unauthorizedBody, null, 2));
  }

  console.log("\n=== E. Unauthorized field ===");
  const badFieldResponse = await postQuery(adminToken, {
    dataset: "CANDIDATE_PIPELINE",
    fields: ["candidate_name", "not_a_real_field"]
  });
  const badFieldBody = await readJson(badFieldResponse);
  if (badFieldResponse.status === 400) {
    pass("Unauthorized/invalid field rejected");
  } else {
    fail("Invalid field status", String(badFieldResponse.status));
  }
  console.log(JSON.stringify(badFieldBody, null, 2));

  console.log("\n=== F. Non-filterable field filter ===");
  const nonFilterResponse = await postQuery(adminToken, {
    dataset: "CANDIDATE_PIPELINE",
    fields: ["candidate_name"],
    filters: [{ field: "mapping_id", operator: "equals", value: 1 }]
  });
  const nonFilterBody = await readJson(nonFilterResponse);
  if (nonFilterResponse.status === 400) {
    pass("Non-filterable field filter rejected");
  } else {
    fail("Non-filterable filter status", String(nonFilterResponse.status));
  }
  console.log(JSON.stringify(nonFilterBody, null, 2));

  console.log("\n=== G. Non-sortable field sort ===");
  const nonSortResponse = await postQuery(adminToken, {
    dataset: "CANDIDATE_PIPELINE",
    fields: ["candidate_name", "pipeline_remarks"],
    sort: [{ field: "pipeline_remarks", direction: "asc" }]
  });
  const nonSortBody = await readJson(nonSortResponse);
  if (nonSortResponse.status === 400) {
    pass("Non-sortable field sort rejected");
  } else {
    fail("Non-sortable sort status", String(nonSortResponse.status));
  }
  console.log(JSON.stringify(nonSortBody, null, 2));

  console.log("\n=== H. Non-groupable field group ===");
  const nonGroupResponse = await postQuery(adminToken, {
    dataset: "CANDIDATE_PIPELINE",
    fields: ["candidate_name"],
    groupBy: ["candidate_name"]
  });
  const nonGroupBody = await readJson(nonGroupResponse);
  if (nonGroupResponse.status === 400) {
    pass("Non-groupable field group rejected");
  } else {
    fail("Non-groupable group status", String(nonGroupResponse.status));
  }
  console.log(JSON.stringify(nonGroupBody, null, 2));

  console.log("\n=== I. Unsupported operator ===");
  const badOperatorResponse = await postQuery(adminToken, {
    dataset: "CANDIDATE_PIPELINE",
    fields: ["candidate_name"],
    filters: [{ field: "candidate_name", operator: "regex", value: "a" }]
  });
  const badOperatorBody = await readJson(badOperatorResponse);
  if (badOperatorResponse.status === 400) {
    pass("Unsupported operator rejected");
  } else {
    fail("Unsupported operator status", String(badOperatorResponse.status));
  }
  console.log(JSON.stringify(badOperatorBody, null, 2));

  console.log("\n=== J. Invalid filter value ===");
  const badValueResponse = await postQuery(adminToken, {
    dataset: "CANDIDATE_PIPELINE",
    fields: ["candidate_name"],
    filters: [{ field: "applied_on", operator: "equals", value: "not-a-date" }]
  });
  const badValueBody = await readJson(badValueResponse);
  if (badValueResponse.status === 400) {
    pass("Invalid filter value rejected");
  } else {
    fail("Invalid filter value status", String(badValueResponse.status));
  }
  console.log(JSON.stringify(badValueBody, null, 2));

  console.log("\n=== K. Malicious field input ===");
  const maliciousFieldResponse = await postQuery(adminToken, {
    dataset: "CANDIDATE_PIPELINE",
    fields: ["candidate_name; DROP TABLE cand_mstr"]
  });
  const maliciousFieldBody = await readJson(maliciousFieldResponse);
  if (maliciousFieldResponse.status === 400) {
    pass("Malicious field input rejected");
  } else {
    fail("Malicious field status", String(maliciousFieldResponse.status));
  }
  console.log(JSON.stringify(maliciousFieldBody, null, 2));

  console.log("\n=== L. Malicious operator input ===");
  const maliciousOperatorResponse = await postQuery(adminToken, {
    dataset: "CANDIDATE_PIPELINE",
    fields: ["candidate_name"],
    filters: [{ field: "candidate_name", operator: "= OR 1=1", value: "x" }]
  });
  const maliciousOperatorBody = await readJson(maliciousOperatorResponse);
  if (maliciousOperatorResponse.status === 400) {
    pass("Malicious operator input rejected");
  } else {
    fail("Malicious operator status", String(maliciousOperatorResponse.status));
  }
  console.log(JSON.stringify(maliciousOperatorBody, null, 2));

  console.log("\n=== M. Malicious filter value ===");
  const maliciousValueResponse = await postQuery(adminToken, {
    dataset: "CANDIDATE_PIPELINE",
    fields: ["candidate_name"],
    filters: [
      { field: "candidate_name", operator: "equals", value: "' OR 1=1 --" }
    ]
  });
  const maliciousValueBody = await readJson(maliciousValueResponse);
  if (maliciousValueResponse.status === 200 || maliciousValueResponse.status === 400) {
    pass("Malicious filter value handled safely (parameterized or rejected)");
  } else {
    fail("Malicious value status", String(maliciousValueResponse.status));
  }
  console.log(JSON.stringify(maliciousValueBody, null, 2));

  console.log("\n=== N. Malicious sort input ===");
  const maliciousSortResponse = await postQuery(adminToken, {
    dataset: "CANDIDATE_PIPELINE",
    fields: ["candidate_name"],
    sort: [{ field: "candidate_name DESC, pg_sleep(5)", direction: "asc" }]
  });
  const maliciousSortBody = await readJson(maliciousSortResponse);
  if (maliciousSortResponse.status === 400) {
    pass("Malicious sort field rejected");
  } else {
    fail("Malicious sort status", String(maliciousSortResponse.status));
  }
  console.log(JSON.stringify(maliciousSortBody, null, 2));

  console.log("\n=== O. Malicious group input ===");
  const maliciousGroupResponse = await postQuery(adminToken, {
    dataset: "CANDIDATE_PIPELINE",
    fields: ["department"],
    groupBy: ["department; DROP TABLE rm_requisitions"]
  });
  const maliciousGroupBody = await readJson(maliciousGroupResponse);
  if (maliciousGroupResponse.status === 400) {
    pass("Malicious group field rejected");
  } else {
    fail("Malicious group status", String(maliciousGroupResponse.status));
  }
  console.log(JSON.stringify(maliciousGroupBody, null, 2));

  console.log("\n=== P/Q. Pagination and max page size ===");
  const pageResponse = await postQuery(adminToken, {
    dataset: "REQUISITION_SUMMARY",
    fields: ["requisition_code"],
    page: 2,
    pageSize: 500
  });
  const pageBody = await readJson(pageResponse);
  if (pageResponse.status === 200 && pageBody.data?.pagination?.page === 2) {
    pass("Pagination page=2 accepted");
  } else {
    fail("Pagination test", JSON.stringify(pageBody));
  }

  const maxPageResponse = await postQuery(adminToken, {
    dataset: "REQUISITION_SUMMARY",
    fields: ["requisition_code"],
    page: 1,
    pageSize: 9999
  });
  const maxPageBody = await readJson(maxPageResponse);
  if (
    maxPageResponse.status === 200 &&
    maxPageBody.data?.pagination?.page_size === 500
  ) {
    pass("Page size capped at maximum 500");
  } else {
    fail("Max page size enforcement", JSON.stringify(maxPageBody));
  }

  console.log("\n=== S. Dataset grain check ===");
  const grainResponse = await postQuery(adminToken, {
    dataset: "REQUISITION_SUMMARY",
    fields: ["requisition_code", "assigned_recruiter_code"],
    page: 1,
    pageSize: 100
  });
  const grainBody = await readJson(grainResponse);
  if (grainResponse.status === 200) {
    const codes = (grainBody.data?.rows || []).map((row) => row.requisition_code);
    const uniqueCodes = new Set(codes);
    if (uniqueCodes.size === codes.length) {
      pass("REQUISITION_SUMMARY grain preserved (no duplicate requisition_code in page)");
    } else {
      fail(
        "Grain duplication detected",
        `${codes.length} rows vs ${uniqueCodes.size} unique codes`
      );
    }
  }

  console.log("\n=== T. Existing dashboard API smoke check ===");
  const dashboardResponse = await fetch(`${API_BASE_URL}/dashboard-summary?period=month`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  const dashboardBody = await readJson(dashboardResponse);
  if (dashboardResponse.status === 200 && dashboardBody.success) {
    pass("/dashboard-summary still works");
  } else {
    fail("/dashboard-summary regression", JSON.stringify(dashboardBody));
  }

  await pool.end();
}

main().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
  await pool.end();
});
