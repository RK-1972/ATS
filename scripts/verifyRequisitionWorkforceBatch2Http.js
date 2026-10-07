/**
 * Batch 2 HTTP verification: requisition PUT numerics (D2) and WFP budget draft save (D4).
 * Run: node scripts/verifyRequisitionWorkforceBatch2Http.js
 */
require("dotenv").config();

const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const {
  buildBudgetRequestCriteriaFromLiveConfig
} = require("./lib/budgetVerificationCriteria");

const API_BASE_URL = process.env.API_BASE_URL || "http://localhost:5000";
const RUN_ID = Date.now();

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

const createdRequisitionCodes = [];
const createdBudgetRequestIds = [];

function record(label, passed, detail = "") {
  const line = `${passed ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`;
  console.log(line);
  if (!passed) {
    process.exitCode = 1;
  }
}

async function readJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function signToken(userRow) {
  return jwt.sign(
    {
      user_id: userRow.user_id,
      employee_code: userRow.employee_code,
      email_id: userRow.email_id,
      role_name: userRow.role_name,
      secondary_role: userRow.secondary_role || null
    },
    process.env.JWT_SECRET,
    { expiresIn: "8h" }
  );
}

async function apiFetch(path, token, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {})
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers,
    body:
      options.body !== undefined
        ? typeof options.body === "string"
          ? options.body
          : JSON.stringify(options.body)
        : undefined
  });

  const data = await readJson(response);
  return { response, data };
}

async function resolveRequestor() {
  const result = await pool.query(
    `SELECT u.user_id, u.employee_code, u.email_id, u.role_name, u.secondary_role, u.full_name
     FROM employee_work_assignment ewa
     INNER JOIN work_assignment_mstr wam
       ON wam.work_assignment_id = ewa.work_assignment_id
     INNER JOIN user_mstr u ON u.employee_code = ewa.employee_code
     WHERE ewa.is_active = TRUE
       AND wam.assignment_code = 'REQUISITION_REQUESTOR'
       AND COALESCE(u.is_active, TRUE) = TRUE
     ORDER BY ewa.employee_work_assignment_id
     LIMIT 1`
  );
  return result.rows[0] || null;
}

async function resolveAdmin() {
  const result = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name, secondary_role, full_name
     FROM user_mstr
     WHERE role_name = 'Admin' AND COALESCE(is_active, TRUE) = TRUE
     ORDER BY user_id ASC
     LIMIT 1`
  );
  return result.rows[0] || null;
}

async function allocateReqId(client) {
  const result = await client.query(
    `SELECT GREATEST(
      COALESCE((SELECT MAX(req_id) FROM rm_requisitions WHERE req_id IS NOT NULL), 0),
      COALESCE((SELECT MAX(req_id) FROM req_mstr), 0)
    ) + 1 AS next_id`
  );
  return result.rows[0].next_id;
}

async function tableExists(client, tableName) {
  const result = await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = $1
     ) AS exists`,
    [tableName]
  );
  return Boolean(result.rows[0]?.exists);
}

async function insertEditableRequisition(client, code, ownerEmployeeCode) {
  const reqId = await allocateReqId(client);
  const owner = ownerEmployeeCode || "Batch2 Verify";

  await client.query(
    `INSERT INTO rm_requisitions (
      requisition_code, req_id, position_title, department, headcount,
      experience_min, experience_max, req_status, budget_approved,
      created_by, modified_by, business_unit, primary_skill, location,
      employment_type, priority_level, target_date
    ) VALUES (
      $1, $2, $3, 'Batch2 QA', 2, 1, 5, 'Open', 1000000,
      $4, $4, 'Batch2 Client', 'Java', 'Bangalore', 'Full-time', 'High',
      CURRENT_DATE + 30
    )`,
    [code, reqId, `Batch2 PUT ${code}`, owner]
  );

  if (await tableExists(client, "req_mstr")) {
    await client.query(
      `INSERT INTO req_mstr (
        req_id, req_code, client_name, project_name, job_title, openings_count, req_status, created_by
      ) VALUES ($1, $2, 'Batch2', 'Batch2', $3, 2, 'Open', 'Batch2 Verify')
      ON CONFLICT (req_id) DO NOTHING`,
      [reqId, code.replace(/^REQ-/, "REQ"), `Batch2 PUT ${code}`]
    );
  }

  return reqId;
}

async function cleanup() {
  const client = await pool.connect();
  try {
    for (const code of createdRequisitionCodes) {
      await client.query(
        `DELETE FROM rm_requisitions WHERE requisition_code = $1`,
        [code]
      );
      if (await tableExists(client, "req_mstr")) {
        await client.query(`DELETE FROM req_mstr WHERE req_code = $1`, [
          code.replace(/^REQ-/, "REQ")
        ]);
      }
    }

    if (createdBudgetRequestIds.length) {
      const state = await client.query(
        `SELECT draft_payload FROM wp_config_state WHERE id = 1`
      );
      const draft = state.rows[0]?.draft_payload || {};
      const ids = new Set(createdBudgetRequestIds);
      draft.budget_requests = (draft.budget_requests || []).filter(
        (item) => !ids.has(item.id)
      );
      draft.approval_queue = (draft.approval_queue || []).filter(
        (item) => !ids.has(item.id)
      );
      await client.query(
        `UPDATE wp_config_state SET draft_payload = $1::jsonb WHERE id = 1`,
        [JSON.stringify(draft)]
      );
    }
  } finally {
    client.release();
  }
}

async function main() {
  const requestor = await resolveRequestor();
  const admin = await resolveAdmin();

  if (!requestor) {
    record("fixture requestor", false, "no REQUISITION_REQUESTOR user");
    await pool.end();
    return;
  }
  if (!admin) {
    record("fixture admin", false, "no Admin user");
    await pool.end();
    return;
  }

  const requestorToken = signToken(requestor);
  const adminToken = signToken(admin);
  const reqCode = `REQ-B2-PUT-${RUN_ID}`;
  createdRequisitionCodes.push(reqCode);

  const client = await pool.connect();
  try {
    await insertEditableRequisition(client, reqCode, requestor.employee_code);
  } finally {
    client.release();
  }

  const putPath = `/api/v1/recruitment/requisitions/${encodeURIComponent(reqCode)}`;

  const putZero = await apiFetch(putPath, requestorToken, {
    method: "PUT",
    body: { openings_count: 0 }
  });
  record(
    "B. PUT headcount 0 rejected",
    putZero.response.status === 400,
    `status=${putZero.response.status} ${putZero.data?.message || ""}`
  );

  const putNegative = await apiFetch(putPath, requestorToken, {
    method: "PUT",
    body: { openings_count: -2 }
  });
  record(
    "C. PUT negative headcount rejected",
    putNegative.response.status === 400,
    `status=${putNegative.response.status}`
  );

  const putFractional = await apiFetch(putPath, requestorToken, {
    method: "PUT",
    body: { openings_count: 2.5 }
  });
  record(
    "D. PUT fractional headcount rejected",
    putFractional.response.status === 400,
    `status=${putFractional.response.status}`
  );

  const putExpInvalid = await apiFetch(putPath, requestorToken, {
    method: "PUT",
    body: { experience_min: 10, experience_max: 3 }
  });
  record(
    "E. PUT experience_min > experience_max rejected",
    putExpInvalid.response.status === 400,
    `status=${putExpInvalid.response.status}`
  );

  const putValid = await apiFetch(putPath, requestorToken, {
    method: "PUT",
    body: {
      openings_count: 4,
      experience_min: 2,
      experience_max: 9,
      client_name: "Batch2 Client",
      job_title: `Batch2 PUT ${reqCode}`,
      primary_skill: "Java",
      work_location: "Bangalore",
      employment_type: "Full-time",
      priority_level: "High",
      target_date: new Date(Date.now() + 86400000 * 30).toISOString().slice(0, 10)
    }
  });
  record(
    "F. PUT valid headcount + experience succeeds",
    putValid.response.status === 200 && putValid.data?.success === true,
    `status=${putValid.response.status}`
  );

  let budgetCriteria;
  try {
    budgetCriteria = await buildBudgetRequestCriteriaFromLiveConfig(pool, {
      justification: `Batch2 verify ${RUN_ID}`
    });
  } catch (error) {
    record("budget criteria fixture", false, error.message);
    await cleanup();
    await pool.end();
    return;
  }

  const budgetBase = {
    department: budgetCriteria.department,
    position: budgetCriteria.position,
    grade: budgetCriteria.grade,
    justification: budgetCriteria.justification || `Batch2 verify ${RUN_ID}`,
    priority: budgetCriteria.priority || "Medium"
  };

  const saveZero = await apiFetch("/api/v1/workforce/budget-requests", adminToken, {
    method: "POST",
    body: { ...budgetBase, headcount: 1, proposed_budget: 0 }
  });
  record(
    "G. WFP draft save budget 0 rejected",
    saveZero.response.status === 400,
    `status=${saveZero.response.status} ${saveZero.data?.message || ""}`
  );

  const saveNegative = await apiFetch(
    "/api/v1/workforce/budget-requests",
    adminToken,
    {
      method: "POST",
      body: { ...budgetBase, headcount: 1, proposed_budget: -100 }
    }
  );
  record(
    "H. WFP draft save negative budget rejected",
    saveNegative.response.status === 400,
    `status=${saveNegative.response.status}`
  );

  const saveBadHeadcount = await apiFetch(
    "/api/v1/workforce/budget-requests",
    adminToken,
    {
      method: "POST",
      body: {
        ...budgetBase,
        headcount: 1.5,
        proposed_budget: budgetCriteria.proposed_budget
      }
    }
  );
  record(
    "I. WFP draft save fractional headcount rejected",
    saveBadHeadcount.response.status === 400,
    `status=${saveBadHeadcount.response.status}`
  );

  const saveValid = await apiFetch(
    "/api/v1/workforce/budget-requests",
    adminToken,
    {
      method: "POST",
      body: {
        ...budgetBase,
        headcount: budgetCriteria.headcount || 1,
        proposed_budget: budgetCriteria.proposed_budget
      }
    }
  );
  const savedId =
    saveValid.data?.request?.id || saveValid.data?.data?.request?.id || null;
  if (savedId) {
    createdBudgetRequestIds.push(savedId);
  }
  record(
    "J. WFP draft save valid values succeeds",
    (saveValid.response.status === 200 || saveValid.response.status === 201) &&
      Boolean(savedId),
    `status=${saveValid.response.status} id=${savedId || "missing"}`
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await cleanup();
    } catch (cleanupError) {
      console.error("Cleanup error:", cleanupError.message);
      process.exitCode = 1;
    }
    await pool.end();
    if (process.exitCode) {
      console.log("\nBatch 2 HTTP verification completed with failures.");
    } else {
      console.log("\nAll Batch 2 HTTP checks passed.");
    }
  });
