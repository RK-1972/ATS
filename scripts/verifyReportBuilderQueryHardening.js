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

const FORBIDDEN_PATTERNS = [
  /sql_expression/i,
  /base_view_key/i,
  /FROM\s+rm_/i,
  /FROM\s+cand_/i,
  /pg_catalog/i,
  /syntax error/i,
  /column "/i,
  /relation "/i,
  /at \/.*\.js/i
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
  } catch {
    return { raw: text };
  }
}

function assertSafeError(body, label) {
  const serialized = JSON.stringify(body);
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(serialized)) {
      fail(`${label} leaked internal details`, pattern.toString());
      return false;
    }
  }
  pass(`${label} error response is sanitized`);
  return true;
}

async function postQuery(token, body) {
  return fetch(`${API_BASE_URL}/api/v1/reports/query`, {
    method: "POST",
    headers: {
      Authorization: token ? `Bearer ${token}` : undefined,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
}

async function getMetadata(token, datasetCode) {
  return fetch(`${API_BASE_URL}/api/v1/reports/datasets/${datasetCode}`, {
    headers: { Authorization: `Bearer ${token}` }
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

async function main() {
  const adminUser = await resolveAdminUser();
  if (!adminUser) {
    fail("Setup", "No Admin user");
    await pool.end();
    return;
  }

  const adminToken = signToken({
    user_id: adminUser.user_id,
    employee_code: adminUser.employee_code,
    email_id: adminUser.email_id,
    role_name: adminUser.role_name
  });

  console.log("\n=== A. Authentication ===");

  const noTokenResponse = await postQuery(null, {
    dataset: "CANDIDATE_PIPELINE",
    fields: ["candidate_name"]
  });
  const noTokenBody = await readJson(noTokenResponse);
  if (noTokenResponse.status === 401) {
    pass("Missing token returns 401");
  } else {
    fail("Missing token", String(noTokenResponse.status));
  }

  const badTokenResponse = await postQuery("not-a-jwt", {
    dataset: "CANDIDATE_PIPELINE",
    fields: ["candidate_name"]
  });
  if (badTokenResponse.status === 401) {
    pass("Invalid token returns 401");
  } else {
    fail("Invalid token", String(badTokenResponse.status));
  }

  const candidateToken = signToken({
    account_type: "candidate",
    candidate_id: 1,
    portal_account_id: 1
  });
  const candidateResponse = await postQuery(candidateToken, {
    dataset: "CANDIDATE_PIPELINE",
    fields: ["candidate_name"]
  });
  if (candidateResponse.status === 403) {
    pass("Candidate portal token returns 403");
  } else {
    fail("Candidate token", String(candidateResponse.status));
  }

  console.log("\n=== B/D. Authorization & dataset validation ===");

  const inactiveDataset = await pool.query(
    `UPDATE rb_dataset SET is_active = FALSE WHERE code = 'CANDIDATE_PIPELINE' RETURNING dataset_id`
  );
  if (inactiveDataset.rowCount > 0) {
    const inactiveResponse = await postQuery(adminToken, {
      dataset: "CANDIDATE_PIPELINE",
      fields: ["candidate_name"]
    });
    await pool.query(
      `UPDATE rb_dataset SET is_active = TRUE WHERE code = 'CANDIDATE_PIPELINE'`
    );
    if (inactiveResponse.status === 404 || inactiveResponse.status === 400) {
      pass("Inactive dataset cannot execute");
    } else {
      fail("Inactive dataset", String(inactiveResponse.status));
    }
  }

  console.log("\n=== D/E. Field validation edge cases ===");

  const emptyFieldsResponse = await postQuery(adminToken, {
    dataset: "CANDIDATE_PIPELINE",
    fields: []
  });
  if (emptyFieldsResponse.status === 400) {
    pass("Empty field list rejected");
  } else {
    fail("Empty field list", String(emptyFieldsResponse.status));
  }

  const dupFieldsResponse = await postQuery(adminToken, {
    dataset: "CANDIDATE_PIPELINE",
    fields: ["candidate_name", "candidate_name", "requisition_code"],
    pageSize: 3
  });
  const dupFieldsBody = await readJson(dupFieldsResponse);
  if (
    dupFieldsResponse.status === 200 &&
    dupFieldsBody.data?.columns?.length === 2
  ) {
    pass("Duplicate fields deduplicated in response columns");
  } else {
    fail("Duplicate fields", JSON.stringify(dupFieldsBody));
  }

  const maxFields = Array.from({ length: 51 }, (_, i) => `field_${i}`);
  const tooManyFieldsResponse = await postQuery(adminToken, {
    dataset: "CANDIDATE_PIPELINE",
    fields: maxFields
  });
  if (tooManyFieldsResponse.status === 400) {
    pass("Oversized field list rejected");
  } else {
    fail("Oversized field list", String(tooManyFieldsResponse.status));
  }

  console.log("\n=== E/F/G. Filter, operator, sort validation ===");

  const nullFilterResponse = await postQuery(adminToken, {
    dataset: "CANDIDATE_PIPELINE",
    fields: ["candidate_name"],
    filters: [{ field: "stage_name", operator: "equals", value: null }]
  });
  if (nullFilterResponse.status === 400) {
    pass("Null filter value rejected");
  } else {
    fail("Null filter value", String(nullFilterResponse.status));
  }

  const emptyTextFilterResponse = await postQuery(adminToken, {
    dataset: "CANDIDATE_PIPELINE",
    fields: ["candidate_name"],
    filters: [{ field: "requisition_code", operator: "equals", value: "   " }]
  });
  if (emptyTextFilterResponse.status === 400) {
    pass("Empty text filter value rejected");
  } else {
    fail("Empty text filter", String(emptyTextFilterResponse.status));
  }

  const badDirectionResponse = await postQuery(adminToken, {
    dataset: "CANDIDATE_PIPELINE",
    fields: ["candidate_name"],
    sort: [{ field: "candidate_name", direction: "ascending" }]
  });
  if (badDirectionResponse.status === 400) {
    pass("Invalid sort direction rejected");
  } else {
    fail("Invalid sort direction", String(badDirectionResponse.status));
  }

  const duplicateSortResponse = await postQuery(adminToken, {
    dataset: "CANDIDATE_PIPELINE",
    fields: ["candidate_name", "requisition_code"],
    sort: [
      { field: "candidate_name", direction: "asc" },
      { field: "candidate_name", direction: "desc" }
    ],
    pageSize: 5
  });
  if (duplicateSortResponse.status === 200) {
    pass("Duplicate sort rules accepted deterministically");
  } else {
    fail("Duplicate sort", String(duplicateSortResponse.status));
  }

  console.log("\n=== I. Pagination edge cases ===");

  const zeroPageResponse = await postQuery(adminToken, {
    dataset: "REQUISITION_SUMMARY",
    fields: ["requisition_code"],
    page: 0,
    pageSize: 10
  });
  const zeroPageBody = await readJson(zeroPageResponse);
  if (zeroPageResponse.status === 200 && zeroPageBody.data?.pagination?.page === 1) {
    pass("Zero page normalized to 1");
  } else {
    fail("Zero page", JSON.stringify(zeroPageBody));
  }

  const negativePageResponse = await postQuery(adminToken, {
    dataset: "REQUISITION_SUMMARY",
    fields: ["requisition_code"],
    page: -5,
    pageSize: 10
  });
  const negativePageBody = await readJson(negativePageResponse);
  if (negativePageResponse.status === 200 && negativePageBody.data?.pagination?.page === 1) {
    pass("Negative page normalized to 1");
  } else {
    fail("Negative page", JSON.stringify(negativePageBody));
  }

  const hugePageResponse = await postQuery(adminToken, {
    dataset: "REQUISITION_SUMMARY",
    fields: ["requisition_code"],
    page: 999999,
    pageSize: 25
  });
  const hugePageBody = await readJson(hugePageResponse);
  if (
    hugePageResponse.status === 200 &&
    Array.isArray(hugePageBody.data?.rows) &&
    hugePageBody.data.rows.length === 0
  ) {
    pass("Extremely large page returns safely with zero rows");
  } else {
    fail("Huge page", JSON.stringify(hugePageBody));
  }

  console.log("\n=== J/K. NULL and empty result handling ===");

  const nullDataResponse = await postQuery(adminToken, {
    dataset: "CANDIDATE_PIPELINE",
    fields: [
      "candidate_name",
      "assigned_recruiter_name",
      "assigned_recruiter_code",
      "pipeline_remarks"
    ],
    pageSize: 10
  });
  const nullDataBody = await readJson(nullDataResponse);
  if (nullDataResponse.status === 200) {
    const hasNullRecruiter = (nullDataBody.data?.rows || []).some(
      (row) => row.assigned_recruiter_name === null
    );
    if (hasNullRecruiter) {
      pass("NULL recruiter values preserved in results");
    } else {
      pass("NULL recruiter query executed without crash (no null rows in sample)");
    }
  } else {
    fail("NULL data query", JSON.stringify(nullDataBody));
  }

  const zeroResultResponse = await postQuery(adminToken, {
    dataset: "CANDIDATE_PIPELINE",
    fields: ["candidate_name"],
    filters: [{ field: "stage_name", operator: "equals", value: "NonExistentStageXYZ" }]
  });
  const zeroResultBody = await readJson(zeroResultResponse);
  if (
    zeroResultResponse.status === 400 ||
    (zeroResultResponse.status === 200 &&
      zeroResultBody.data?.pagination?.total_count === 0)
  ) {
    pass("Zero-result query handled safely");
  } else {
    fail("Zero result", JSON.stringify(zeroResultBody));
  }

  console.log("\n=== L. SQL injection (pagination/dataset) ===");

  const maliciousPageResponse = await postQuery(adminToken, {
    dataset: "CANDIDATE_PIPELINE",
    fields: ["candidate_name"],
    page: "1; DROP TABLE rb_dataset",
    pageSize: "25 OR 1=1"
  });
  if (maliciousPageResponse.status === 200) {
    pass("Malicious pagination values coerced safely");
  } else if (maliciousPageResponse.status === 400) {
    pass("Malicious pagination rejected");
  } else {
    fail("Malicious pagination", String(maliciousPageResponse.status));
  }

  const maliciousDatasetResponse = await postQuery(adminToken, {
    dataset: "CANDIDATE_PIPELINE; DROP TABLE rb_dataset",
    fields: ["candidate_name"]
  });
  if (maliciousDatasetResponse.status === 400) {
    pass("Malicious dataset code rejected");
  } else {
    fail("Malicious dataset", String(maliciousDatasetResponse.status));
  }

  console.log("\n=== M. Grain integrity ===");

  const pipelineGrainResponse = await postQuery(adminToken, {
    dataset: "CANDIDATE_PIPELINE",
    fields: ["mapping_id", "requisition_code", "candidate_name"],
    pageSize: 100
  });
  const pipelineGrainBody = await readJson(pipelineGrainResponse);
  if (pipelineGrainResponse.status === 200) {
    const mappingIds = (pipelineGrainBody.data?.rows || []).map((row) => row.mapping_id);
    const uniqueIds = new Set(mappingIds);
    if (uniqueIds.size === mappingIds.length) {
      pass("CANDIDATE_PIPELINE mapping grain preserved");
    } else {
      fail(
        "CANDIDATE_PIPELINE grain duplication",
        `${mappingIds.length} rows vs ${uniqueIds.size} unique mapping_id`
      );
    }
  } else {
    fail("CANDIDATE_PIPELINE grain query", JSON.stringify(pipelineGrainBody));
  }

  console.log("\n=== N. Deterministic ordering across pages ===");

  const page1Response = await postQuery(adminToken, {
    dataset: "CANDIDATE_PIPELINE",
    fields: ["mapping_id", "candidate_name"],
    sort: [{ field: "candidate_name", direction: "asc" }],
    page: 1,
    pageSize: 5
  });
  const page2Response = await postQuery(adminToken, {
    dataset: "CANDIDATE_PIPELINE",
    fields: ["mapping_id", "candidate_name"],
    sort: [{ field: "candidate_name", direction: "asc" }],
    page: 2,
    pageSize: 5
  });
  const page1Body = await readJson(page1Response);
  const page2Body = await readJson(page2Response);
  if (page1Response.status === 200 && page2Response.status === 200) {
    const page1Ids = new Set((page1Body.data?.rows || []).map((r) => r.mapping_id));
    const page2Ids = new Set((page2Body.data?.rows || []).map((r) => r.mapping_id));
    const overlap = [...page1Ids].filter((id) => page2Ids.has(id));
    if (overlap.length === 0) {
      pass("Paginated pages have no overlapping mapping_id values");
    } else {
      fail("Pagination overlap detected", overlap.join(", "));
    }
  } else {
    fail("Deterministic pagination query failed");
  }

  console.log("\n=== O. Error sanitization ===");

  const dbErrorResponse = await postQuery(adminToken, {
    dataset: "CANDIDATE_PIPELINE",
    fields: ["candidate_name"],
    filters: [{ field: "applied_on", operator: "between", value: ["2020-01-01", "2020-12-31"] }]
  });
  const dbErrorBody = await readJson(dbErrorResponse);
  assertSafeError(dbErrorBody, "Filter execution");

  console.log("\n=== P. Real PostgreSQL multi-filter/sorted query ===");

  const multiFilterResponse = await postQuery(adminToken, {
    dataset: "REQUISITION_SUMMARY",
    fields: ["requisition_code", "department", "req_status", "assigned_recruiter_name"],
    filters: [
      { field: "req_status", operator: "equals", value: "Approved" },
      { field: "department", operator: "contains", value: "IT" }
    ],
    sort: [{ field: "requisition_code", direction: "desc" }],
    page: 1,
    pageSize: 10
  });
  const multiFilterBody = await readJson(multiFilterResponse);
  if (multiFilterResponse.status === 200 && multiFilterBody.data?.rows?.length >= 0) {
    pass("Multi-filter sorted REQUISITION_SUMMARY query executed");
  } else {
    fail("Multi-filter query", JSON.stringify(multiFilterBody));
  }

  console.log("\n=== Q. Phase 3 metadata compatibility ===");

  const metadataResponse = await getMetadata(adminToken, "CANDIDATE_PIPELINE");
  const metadataBody = await readJson(metadataResponse);
  if (metadataResponse.status !== 200) {
    fail("Metadata fetch", JSON.stringify(metadataBody));
  } else {
    const metaFieldCodes = new Set(
      (metadataBody.data?.fields || []).map((field) => field.code)
    );
    const queryResponse = await postQuery(adminToken, {
      dataset: "CANDIDATE_PIPELINE",
      fields: [...metaFieldCodes].slice(0, 10),
      pageSize: 3
    });
    if (queryResponse.status === 200) {
      pass("Phase 3 metadata field codes execute in Phase 4 query");
    } else {
      fail("Metadata/query field mismatch", await queryResponse.text());
    }

    const stageFilterMeta = (metadataBody.data?.filters || []).find(
      (filter) => filter.code === "stage_name"
    );
    if (stageFilterMeta?.supported_operators?.includes("equals")) {
      pass("Phase 3 filter operators include equals for enum filter");
    } else {
      fail("Phase 3 operator contract", JSON.stringify(stageFilterMeta));
    }

    const textFilterMeta = (metadataBody.data?.filters || []).find(
      (filter) => filter.operator_type === "text"
    );
    const queryConstants = require("../services/reportBuilderQueryConstants");
    for (const operatorType of ["text", "number", "date", "enum", "reference"]) {
      const engineOps = queryConstants.OPERATOR_WHITELIST[operatorType] || [];
      if (engineOps.length === 0) {
        continue;
      }

      const sampleFilter = (metadataBody.data?.filters || []).find(
        (filter) => filter.operator_type === operatorType
      );

      if (!sampleFilter) {
        continue;
      }

      const metaOps = sampleFilter.supported_operators || [];
      const mismatch = engineOps.filter((op) => !metaOps.includes(op));
      if (mismatch.length > 0) {
        fail(
          `Phase 3/4 operator mismatch for ${operatorType}`,
          `engine has ${mismatch.join(", ")} not in metadata`
        );
      } else {
        pass(`Phase 3 ${operatorType} operators align with query engine whitelist`);
      }
    }
  }

  console.log("\n=== R. Regression ===");

  const dashboardResponse = await fetch(`${API_BASE_URL}/dashboard-summary?period=month`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  const dashboardBody = await readJson(dashboardResponse);
  if (dashboardResponse.status === 200 && dashboardBody.success) {
    pass("/dashboard-summary regression OK");
  } else {
    fail("/dashboard-summary regression", JSON.stringify(dashboardBody));
  }

  const metadataListResponse = await fetch(`${API_BASE_URL}/api/v1/reports/datasets`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  if (metadataListResponse.status === 200) {
    pass("Phase 3 datasets list regression OK");
  } else {
    fail("Phase 3 datasets list", String(metadataListResponse.status));
  }

  await pool.end();
}

main().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
  await pool.end();
});
