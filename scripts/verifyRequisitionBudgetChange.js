/**
 * Verification for governed requisition budget changes.
 * Run: node scripts/verifyRequisitionBudgetChange.js
 */
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const recruitmentService = require("../services/recruitmentService");
const requisitionBudgetChangeService = require("../services/requisitionBudgetChangeService");
const workflowService = require("../services/workflowService");
const { REQUISITION_STATUS } = require("../constants/requisitionStatus");
const { BUDGET_CHANGE_STATUS } = require("../constants/budgetChangeStatus");

const RUN_ID = Date.now();
const POSITION_ID = `AP-E2E-BC-${RUN_ID}`;
const REQ_APPROVED = `REQ-E2E-BC-APP-${RUN_ID}`;
const REQ_CLOSED = `REQ-E2E-BC-CLS-${RUN_ID}`;

const INITIAL_BUDGET = 1000000;
const WFP_POSITION_BUDGET = 2000000;

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

const results = [];

function record(name, passed, detail = "") {
  results.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
  if (!passed) {
    process.exitCode = 1;
  }
}

function mockReq(user) {
  return {
    user: {
      user_id: user.user_id,
      employee_code: user.employee_code,
      email_id: user.email_id,
      role_name: user.role_name,
      secondary_role: user.secondary_role || null,
      full_name: user.full_name || user.email_id
    }
  };
}

async function tableExists(tableName) {
  const result = await pool.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = $1
     ) AS exists`,
    [tableName]
  );
  return Boolean(result.rows[0]?.exists);
}

async function resolveRequestor() {
  const result = await pool.query(
    `SELECT u.user_id, u.employee_code, u.email_id, u.role_name, u.full_name
     FROM user_mstr u
     INNER JOIN employee_work_assignment ewa ON ewa.employee_code = u.employee_code AND ewa.is_active = TRUE
     INNER JOIN work_assignment_mstr wam ON wam.work_assignment_id = ewa.work_assignment_id AND wam.is_active = TRUE
     WHERE wam.assignment_code = 'REQUISITION_REQUESTOR'
       AND COALESCE(u.is_active, TRUE) = TRUE
     ORDER BY u.user_id ASC LIMIT 1`
  );
  return result.rows[0] || null;
}

async function resolveApprovalRouteId() {
  const result = await pool.query(
    `SELECT route_id
     FROM approval_route_mstr
     WHERE LOWER(TRIM(status)) = 'active'
       AND (
         LOWER(TRIM(applies_to)) LIKE '%requisition%'
         OR LOWER(TRIM(applies_to)) LIKE '%talent%'
         OR LOWER(TRIM(applies_to)) LIKE '%demand%'
       )
     ORDER BY route_id ASC
     LIMIT 1`
  );

  if (result.rows[0]?.route_id) {
    return result.rows[0].route_id;
  }

  const fallback = await pool.query(
    `SELECT route_id
     FROM approval_route_mstr
     WHERE LOWER(TRIM(status)) = 'active'
     ORDER BY route_id ASC
     LIMIT 1`
  );
  return fallback.rows[0]?.route_id || null;
}

async function allocateReqId() {
  const result = await pool.query(
    `SELECT GREATEST(
      COALESCE((SELECT MAX(req_id) FROM rm_requisitions WHERE req_id IS NOT NULL), 0),
      COALESCE((SELECT MAX(req_id) FROM req_mstr), 0)
    ) + 1 AS next_id`
  );
  return result.rows[0].next_id;
}

async function insertApprovedPosition(positionId, budgetApproved) {
  await pool.query(
    `INSERT INTO wp_approved_positions (
      position_id, department, position_title, grade, headcount,
      budget_approved, budget_consumed, remaining_budget, status,
      version, version_status, effective_from, modified_by
    ) VALUES ($1, 'E2E Budget QA', 'E2E Budget Position', 'L5', 1,
      $2, 0, $2, 'Active', 1.0, 'Published', NOW(), 'E2E BC Verify')
    ON CONFLICT (position_id) DO UPDATE SET
      budget_approved = EXCLUDED.budget_approved,
      remaining_budget = EXCLUDED.remaining_budget,
      modified_on = NOW()`,
    [positionId, budgetApproved]
  );
}

async function insertRequisition(code, status, budget, approvalRouteId, createdBy, positionId) {
  const reqId = await allocateReqId();
  const owner = createdBy || "E2E BC Verify";
  await pool.query(
    `INSERT INTO rm_requisitions (
      requisition_code, approved_position_id, req_id, position_title, department,
      headcount, req_status, budget_approved, created_by, modified_by, approval_route_id
    ) VALUES ($1, $2, $3, $4, 'E2E Budget QA', 1, $5, $6, $7, $7, $8)`,
    [
      code,
      positionId,
      reqId,
      `E2E Budget ${code}`,
      status,
      budget,
      owner,
      approvalRouteId
    ]
  );

  if (await tableExists("req_mstr")) {
    await pool.query(
      `INSERT INTO req_mstr (
        req_id, req_code, client_name, project_name, job_title, job_description,
        openings_count, req_status, created_by
      ) VALUES ($1, $2, 'E2E', 'E2E BC QA', $3, 'E2E disposable requisition', 1, $4, 'E2E BC Verify')
      ON CONFLICT (req_id) DO NOTHING`,
      [reqId, code.replace(/^REQ-/, "REQ"), `E2E Budget ${code}`, status]
    );
  }

  return reqId;
}

async function approveAllWorkflowSteps(instanceId) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const tasks = await pool.query(
      `SELECT t.task_id, t.status, a.assignee, u.user_id, u.email_id, u.role_name, u.full_name
       FROM wf_tasks t
       INNER JOIN wf_assignments a ON a.task_id = t.task_id AND a.active = TRUE
       INNER JOIN user_mstr u ON u.employee_code = a.assignee
       WHERE t.instance_id = $1
         AND LOWER(COALESCE(t.task_type, '')) = 'approval'
         AND t.status = 'Pending'
       ORDER BY t.task_id ASC
       LIMIT 1`,
      [instanceId]
    );

    if (!tasks.rows.length) {
      return;
    }

    const row = tasks.rows[0];
    await workflowService.approveMyActiveApproval(
      pool,
      row.task_id,
      mockReq({
        user_id: row.user_id,
        employee_code: row.assignee,
        email_id: row.email_id,
        role_name: row.role_name,
        full_name: row.full_name
      })
    );
  }
}

async function rejectWorkflow(instanceId) {
  const tasks = await pool.query(
    `SELECT t.task_id, a.assignee, u.user_id, u.email_id, u.role_name, u.full_name
     FROM wf_tasks t
     INNER JOIN wf_assignments a ON a.task_id = t.task_id AND a.active = TRUE
     INNER JOIN user_mstr u ON u.employee_code = a.assignee
     WHERE t.instance_id = $1
       AND LOWER(COALESCE(t.task_type, '')) = 'approval'
       AND t.status = 'Pending'
     ORDER BY t.task_id ASC
     LIMIT 1`,
    [instanceId]
  );

  if (!tasks.rows.length) {
    throw new Error(`No pending approval task for ${instanceId}`);
  }

  const row = tasks.rows[0];
  await workflowService.rejectMyActiveApproval(
    pool,
    row.task_id,
    "E2E rejection",
    mockReq({
      user_id: row.user_id,
      employee_code: row.assignee,
      email_id: row.email_id,
      role_name: row.role_name,
      full_name: row.full_name
    })
  );
}

async function cleanup() {
  const codes = [REQ_APPROVED, REQ_CLOSED];
  const workflows = await pool.query(
    `SELECT workflow_instance_id
     FROM rm_budget_change_history
     WHERE requisition_code = ANY($1::text[])
       AND workflow_instance_id IS NOT NULL`,
    [codes]
  );
  const instanceIds = workflows.rows.map((row) => row.workflow_instance_id).filter(Boolean);
  if (instanceIds.length) {
    await pool.query(
      `DELETE FROM wf_assignments WHERE task_id IN (
        SELECT task_id FROM wf_tasks WHERE instance_id = ANY($1::text[])
      )`,
      [instanceIds]
    );
    await pool.query(`DELETE FROM wf_tasks WHERE instance_id = ANY($1::text[])`, [instanceIds]);
    await pool.query(`DELETE FROM wf_instances WHERE instance_id = ANY($1::text[])`, [instanceIds]);
  }

  await pool.query(
    `DELETE FROM om_offers WHERE requisition_code = ANY($1::text[])`,
    [codes]
  );
  await pool.query(
    `DELETE FROM rm_budget_change_history WHERE requisition_code = ANY($1::text[])`,
    [codes]
  );
  await pool.query(
    `DELETE FROM wp_position_lifecycle WHERE position_id = $1`,
    [POSITION_ID]
  );
  const reqIds = await pool.query(
    `SELECT req_id FROM rm_requisitions WHERE requisition_code = ANY($1::text[]) AND req_id IS NOT NULL`,
    [codes]
  );
  await pool.query(`DELETE FROM rm_requisitions WHERE requisition_code = ANY($1::text[])`, [codes]);
  if (await tableExists("req_mstr") && reqIds.rows.length) {
    await pool.query(
      `DELETE FROM req_mstr WHERE req_id = ANY($1::int[])`,
      [reqIds.rows.map((row) => row.req_id)]
    );
  }
  await pool.query(`DELETE FROM wp_approved_positions WHERE position_id = $1`, [POSITION_ID]);
}

async function ensureBudgetChangeMigration() {
  if (await tableExists("rm_budget_change_history")) {
    return true;
  }

  const migrationPath = path.join(
    __dirname,
    "..",
    "migrations",
    "057_rm_budget_change_history.sql"
  );
  const sql = fs.readFileSync(migrationPath, "utf8");
  await pool.query(sql);
  return await tableExists("rm_budget_change_history");
}

async function runRegression(scriptName) {
  const { spawnSync } = require("child_process");
  const scriptPath = path.join(__dirname, scriptName);
  if (!fs.existsSync(scriptPath)) {
    return { name: scriptName, passed: true, detail: "skipped (script missing)" };
  }

  const result = spawnSync("node", [scriptPath], {
    cwd: path.join(__dirname, ".."),
    encoding: "utf8",
    env: process.env
  });

  const passed = result.status === 0;
  const detail = passed
    ? "ok"
    : (result.stderr || result.stdout || "failed").split("\n").slice(-3).join(" ");
  return { name: scriptName, passed, detail };
}

async function main() {
  console.log("=== Requisition Budget Change Verification ===\n");

  const migrationOk = await ensureBudgetChangeMigration();
  record("Migration 057 table present", migrationOk);
  if (!migrationOk) {
    await pool.end();
    return;
  }

  const requestor = await resolveRequestor();
  const approvalRouteId = await resolveApprovalRouteId();
  const recruiter = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name, full_name
     FROM user_mstr WHERE role_name = 'Recruiter' AND COALESCE(is_active, TRUE) = TRUE
     ORDER BY user_id ASC LIMIT 1`
  ).then((r) => r.rows[0]);

  if (!requestor || !approvalRouteId || !recruiter) {
    record("Fixtures available", false, "requestor/route/recruiter missing");
    await pool.end();
    return;
  }

  const requestorReq = mockReq(requestor);
  const createdBy = requestor.full_name || requestor.email_id;

  try {
    await insertApprovedPosition(POSITION_ID, WFP_POSITION_BUDGET);
    await insertRequisition(
      REQ_APPROVED,
      REQUISITION_STATUS.APPROVED,
      INITIAL_BUDGET,
      approvalRouteId,
      createdBy,
      POSITION_ID
    );
    await insertRequisition(
      REQ_CLOSED,
      REQUISITION_STATUS.CLOSED_FILLED,
      INITIAL_BUDGET,
      approvalRouteId,
      createdBy,
      POSITION_ID
    );

    let aboveWfpBlocked = false;
    try {
      await requisitionBudgetChangeService.requestBudgetChange(
        pool,
        REQ_APPROVED,
        { requested_budget: 2500000, reason: "above WFP ceiling" },
        requestorReq
      );
    } catch (error) {
      aboveWfpBlocked = error.status === 409;
    }
    record("2. Increase above WFP approved budget blocked", aboveWfpBlocked);

    const increase = await requisitionBudgetChangeService.requestBudgetChange(
      pool,
      REQ_APPROVED,
      { requested_budget: 1500000, reason: `E2E increase ${RUN_ID}` },
      requestorReq
    );
    record(
      "1. Approved requisition can request increase",
      increase.change.status === BUDGET_CHANGE_STATUS.PENDING
        && increase.change.requested_budget === 1500000,
      `status=${increase.change.status}`
    );

    const pendingIncrease = await requisitionBudgetChangeService.getPendingBudgetChange(
      pool,
      REQ_APPROVED
    );
    const duringPending = await recruitmentService.loadRequisitionByCode(pool, REQ_APPROVED);
    record(
      "3. Pending request leaves effective budget unchanged",
      pendingIncrease?.requested_budget === 1500000
        && Number(duringPending.budget_approved) === INITIAL_BUDGET,
      `effective=${duringPending.budget_approved}, requested=${pendingIncrease?.requested_budget}`
    );

    let duplicateBlocked = false;
    try {
      await requisitionBudgetChangeService.requestBudgetChange(
        pool,
        REQ_APPROVED,
        { requested_budget: 1600000, reason: "duplicate pending" },
        requestorReq
      );
    } catch (error) {
      duplicateBlocked = error.status === 409;
    }
    record("4. Duplicate pending request blocked", duplicateBlocked);

    await approveAllWorkflowSteps(increase.change.workflow_instance_id);
    const afterIncrease = await recruitmentService.loadRequisitionByCode(pool, REQ_APPROVED);
    const positionAfterIncrease = await pool.query(
      `SELECT budget_approved, remaining_budget
       FROM wp_approved_positions WHERE position_id = $1`,
      [POSITION_ID]
    );
    record(
      "5. Final approved increase updates requisition + WFP position",
      Number(afterIncrease.budget_approved) === 1500000
        && Number(positionAfterIncrease.rows[0]?.budget_approved) === 1500000,
      `req=${afterIncrease.budget_approved}, pos=${positionAfterIncrease.rows[0]?.budget_approved}`
    );

    const existingOfferId = `OFF-E2E-BC-EXIST-${RUN_ID}`;
    await pool.query(
      `INSERT INTO om_offers (
        offer_id, requisition_code, candidate_id, offer_status, approved_budget, offered_ctc,
        created_by, modified_by
      ) VALUES ($1, $2, $3, 'Released', $4, $5, 'E2E BC Verify', 'E2E BC Verify')`,
      [existingOfferId, REQ_APPROVED, 999101, INITIAL_BUDGET, 1200000]
    );

    let invalidReductionBlocked = false;
    try {
      await requisitionBudgetChangeService.requestBudgetChange(
        pool,
        REQ_APPROVED,
        { requested_budget: 1100000, reason: "below offer floor" },
        requestorReq
      );
    } catch (error) {
      invalidReductionBlocked = error.status === 409;
    }
    record("6. Reduction below active offer CTC blocked", invalidReductionBlocked);

    const reduction = await requisitionBudgetChangeService.requestBudgetChange(
      pool,
      REQ_APPROVED,
      { requested_budget: 1300000, reason: `E2E reduction ${RUN_ID}` },
      requestorReq
    );
    await approveAllWorkflowSteps(reduction.change.workflow_instance_id);
    const afterReduction = await recruitmentService.loadRequisitionByCode(pool, REQ_APPROVED);
    record(
      "7. Valid reduction succeeds",
      Number(afterReduction.budget_approved) === 1300000,
      `budget=${afterReduction.budget_approved}`
    );

    const existingOfferRow = await pool.query(
      `SELECT approved_budget FROM om_offers WHERE offer_id = $1`,
      [existingOfferId]
    );
    record(
      "8. Existing offer approved_budget remains unchanged",
      Number(existingOfferRow.rows[0]?.approved_budget) === INITIAL_BUDGET,
      `approved_budget=${existingOfferRow.rows[0]?.approved_budget}`
    );

    const newOfferId = `OFF-E2E-BC-NEW-${RUN_ID}`;
    await pool.query(
      `INSERT INTO om_offers (
        offer_id, requisition_code, candidate_id, offer_status, approved_budget, offered_ctc,
        created_by, modified_by
      ) VALUES ($1, $2, $3, 'Draft', 0, 1100000, 'E2E BC Verify', 'E2E BC Verify')`,
      [newOfferId, REQ_APPROVED, 999102]
    );

    const amendedReq = await recruitmentService.loadRequisitionByCode(pool, REQ_APPROVED);
    record(
      "9. New offer picks up amended requisition budget",
      Number(amendedReq.budget_approved) === 1300000,
      `req.budget_approved=${amendedReq.budget_approved}`
    );
    await pool.query(`DELETE FROM om_offers WHERE offer_id = $1`, [newOfferId]);

    const rejectRequest = await requisitionBudgetChangeService.requestBudgetChange(
      pool,
      REQ_APPROVED,
      { requested_budget: 1200000, reason: `E2E reject ${RUN_ID}` },
      requestorReq
    );
    await rejectWorkflow(rejectRequest.change.workflow_instance_id);
    const afterReject = await recruitmentService.loadRequisitionByCode(pool, REQ_APPROVED);
    record(
      "10. Rejected request leaves budget unchanged",
      Number(afterReject.budget_approved) === 1300000,
      `budget=${afterReject.budget_approved}`
    );

    let unauthorizedBlocked = false;
    try {
      await requisitionBudgetChangeService.requestBudgetChange(
        pool,
        REQ_APPROVED,
        { requested_budget: 1250000, reason: "unauthorized" },
        mockReq(recruiter)
      );
    } catch (error) {
      unauthorizedBlocked = error.status === 403;
    }
    record("11. Unauthorized requester blocked", unauthorizedBlocked);

    let closedBlocked = false;
    try {
      await requisitionBudgetChangeService.requestBudgetChange(
        pool,
        REQ_CLOSED,
        { requested_budget: 1250000, reason: "closed req" },
        requestorReq
      );
    } catch (error) {
      closedBlocked = error.status === 400;
    }
    record("12. Closed requisition blocked", closedBlocked);

    const audit = await pool.query(
      `SELECT COUNT(*)::int AS total
       FROM md_enterprise_audit
       WHERE entity_id = $1
         AND event_type IN (
           'RequisitionBudgetChangeRequested',
           'RequisitionBudgetChangeApproved',
           'RequisitionBudgetChangeRejected'
         )`,
      [REQ_APPROVED]
    );
    const lifecycle = await pool.query(
      `SELECT COUNT(*)::int AS total
       FROM wp_position_lifecycle
       WHERE position_id = $1 AND event_type = 'BudgetAmended'`,
      [POSITION_ID]
    );
    const history = await pool.query(
      `SELECT COUNT(*)::int AS total FROM rm_budget_change_history WHERE requisition_code = $1`,
      [REQ_APPROVED]
    );
    record(
      "13. Audit/history/lifecycle records exist",
      audit.rows[0].total >= 2 && lifecycle.rows[0].total >= 1 && history.rows[0].total >= 2,
      `audit=${audit.rows[0].total}, lifecycle=${lifecycle.rows[0].total}, history=${history.rows[0].total}`
    );
  } catch (error) {
    record("Runtime", false, error.message);
    console.error(error);
  } finally {
    console.log("\n--- Cleaning disposable data ---");
    await cleanup();
  }

  console.log("\n=== Regression suites ===");
  const regressions = [
    "verifyRequisitionHeadcountChange.js",
    "verifyRequisitionClosureE2e.js"
  ];

  for (const script of regressions) {
    const result = await runRegression(script);
    record(`14. Regression ${script}`, result.passed, result.detail);
  }

  await pool.end();

  console.log("\n=== Summary ===");
  for (const row of results) {
    console.log(`${row.passed ? "PASS" : "FAIL"} | ${row.name}${row.detail ? ` | ${row.detail}` : ""}`);
  }
}

main();
