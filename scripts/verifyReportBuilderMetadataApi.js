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

const FORBIDDEN_RESPONSE_KEYS = [
  "sql_expression",
  "base_view_key",
  "dataset_id",
  "field_id",
  "filter_id",
  "permission_id"
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

  for (const forbiddenKey of FORBIDDEN_RESPONSE_KEYS) {
    if (keys.has(forbiddenKey)) {
      fail(`${label} leaked sensitive key`, forbiddenKey);
      return false;
    }
  }

  pass(`${label} contains no backend SQL/query metadata keys`);
  return true;
}

async function fetchWithAuth(path, token) {
  return fetch(`${API_BASE_URL}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
}

async function resolveAdminUser() {
  const result = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name, full_name
     FROM user_mstr
     WHERE role_name = 'Admin'
       AND COALESCE(is_active, TRUE) = TRUE
     ORDER BY user_id ASC
     LIMIT 1`
  );

  return result.rows[0] || null;
}

async function resolveNonAdminUser() {
  const result = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name, full_name
     FROM user_mstr
     WHERE role_name <> 'Admin'
       AND COALESCE(is_active, TRUE) = TRUE
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

  console.log("\n=== Admin dataset list ===");
  const listResponse = await fetchWithAuth("/api/v1/reports/datasets", adminToken);
  const listBody = await readJson(listResponse);

  if (listResponse.status !== 200 || !listBody.success) {
    fail("GET /api/v1/reports/datasets", JSON.stringify(listBody));
  } else {
    pass("GET /api/v1/reports/datasets returns 200");
    console.log(JSON.stringify(listBody, null, 2));
    assertNoSensitiveKeys(listBody, "dataset list");

    const datasetCodes = (listBody.data?.datasets || []).map((row) => row.code);
    if (datasetCodes.length !== 2) {
      fail("dataset list count", `expected 2, got ${datasetCodes.length}`);
    } else {
      pass("Admin sees 2 authorized datasets");
    }
  }

  for (const datasetCode of ["CANDIDATE_PIPELINE", "REQUISITION_SUMMARY"]) {
    console.log(`\n=== Admin dataset metadata: ${datasetCode} ===`);
    const detailResponse = await fetchWithAuth(
      `/api/v1/reports/datasets/${datasetCode}`,
      adminToken
    );
    const detailBody = await readJson(detailResponse);

    if (detailResponse.status !== 200 || !detailBody.success) {
      fail(`GET /api/v1/reports/datasets/${datasetCode}`, JSON.stringify(detailBody));
      continue;
    }

    pass(`GET /api/v1/reports/datasets/${datasetCode} returns 200`);
    console.log(JSON.stringify(detailBody, null, 2));
    assertNoSensitiveKeys(detailBody, datasetCode);

    const fields = detailBody.data?.fields || [];
    const filters = detailBody.data?.filters || [];

    if (fields.length === 0) {
      fail(`${datasetCode} fields`, "expected authorized fields");
    } else {
      pass(`${datasetCode} returned ${fields.length} authorized fields`);
    }

    if (filters.length === 0) {
      fail(`${datasetCode} filters`, "expected authorized filters");
    } else {
      pass(`${datasetCode} returned ${filters.length} authorized filters`);
    }

    for (const field of fields) {
      if (!field.code || !field.label || !field.data_type) {
        fail(`${datasetCode} field shape`, JSON.stringify(field));
        break;
      }
    }
  }

  console.log("\n=== Missing authentication ===");
  const noAuthResponse = await fetch(`${API_BASE_URL}/api/v1/reports/datasets`);
  const noAuthBody = await readJson(noAuthResponse);

  if (noAuthResponse.status === 401) {
    pass("Missing token returns 401");
  } else {
    fail("Missing token status", String(noAuthResponse.status));
  }
  console.log(JSON.stringify(noAuthBody, null, 2));

  console.log("\n=== Invalid token ===");
  const invalidResponse = await fetchWithAuth(
    "/api/v1/reports/datasets",
    "invalid.token.value"
  );
  const invalidBody = await readJson(invalidResponse);

  if (invalidResponse.status === 401) {
    pass("Invalid token returns 401");
  } else {
    fail("Invalid token status", String(invalidResponse.status));
  }
  console.log(JSON.stringify(invalidBody, null, 2));

  console.log("\n=== Non-existent dataset ===");
  const missingResponse = await fetchWithAuth(
    "/api/v1/reports/datasets/DOES_NOT_EXIST",
    adminToken
  );
  const missingBody = await readJson(missingResponse);

  if (missingResponse.status === 404) {
    pass("Non-existent dataset returns 404");
  } else {
    fail("Non-existent dataset status", String(missingResponse.status));
  }
  console.log(JSON.stringify(missingBody, null, 2));

  const nonAdminUser = await resolveNonAdminUser();

  if (!nonAdminUser) {
    console.log("\nSKIP: No active non-Admin user available for authorization tests.");
  } else {
    const nonAdminToken = signToken({
      user_id: nonAdminUser.user_id,
      employee_code: nonAdminUser.employee_code,
      email_id: nonAdminUser.email_id,
      role_name: nonAdminUser.role_name
    });

    console.log(`\n=== Non-Admin authorization (${nonAdminUser.role_name}) ===`);
    const nonAdminListResponse = await fetchWithAuth(
      "/api/v1/reports/datasets",
      nonAdminToken
    );
    const nonAdminListBody = await readJson(nonAdminListResponse);

    console.log(JSON.stringify(nonAdminListBody, null, 2));

    if (nonAdminListResponse.status === 200) {
      const count = nonAdminListBody.data?.datasets?.length || 0;
      if (count === 0) {
        pass("Non-Admin dataset list is empty (no permissions seeded)");
      } else {
        fail("Non-Admin dataset list", `expected 0 datasets, got ${count}`);
      }
    } else {
      pass(`Non-Admin dataset list returned ${nonAdminListResponse.status}`);
    }

    const unauthorizedDetailResponse = await fetchWithAuth(
      "/api/v1/reports/datasets/CANDIDATE_PIPELINE",
      nonAdminToken
    );
    const unauthorizedDetailBody = await readJson(unauthorizedDetailResponse);

    console.log(JSON.stringify(unauthorizedDetailBody, null, 2));

    if (unauthorizedDetailResponse.status === 404) {
      pass("Non-Admin unauthorized dataset metadata returns 404");
    } else {
      fail(
        "Non-Admin unauthorized dataset metadata status",
        String(unauthorizedDetailResponse.status)
      );
    }
  }

  await pool.end();
}

main().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
  await pool.end();
});
