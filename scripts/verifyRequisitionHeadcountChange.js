/**
 * Verification for governed requisition headcount changes.
 * Run: node scripts/verifyRequisitionHeadcountChange.js
 */
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const recruitmentService = require("../services/recruitmentService");
const requisitionHeadcountChangeService = require("../services/requisitionHeadcountChangeService");
const workflowService = require("../services/workflowService");
const { REQUISITION_STATUS } = require("../constants/requisitionStatus");
const { HEADCOUNT_CHANGE_STATUS } = require("../constants/headcountChangeStatus");
const { getFulfillmentForRequisition } = require("../services/requisitionFulfillmentService");

const RUN_ID = Date.now();
const REQ_OPEN = `REQ-E2E-HC-OPEN-${RUN_ID}`;
const REQ_APPROVED = `REQ-E2E-HC-APP-${RUN_ID}`;

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

async function insertRequisition(code, status, headcount, approvalRouteId, createdBy) {
  const reqId = await allocateReqId();
  const owner = createdBy || "E2E HC Verify";
  await pool.query(
    `INSERT INTO rm_requisitions (
      requisition_code, req_id, position_title, department, headcount, req_status,
      budget_approved, created_by, modified_by, approval_route_id
    ) VALUES ($1, $2, $3, 'E2E Headcount QA', $4, $5, 1000000, $6, $6, $7)`,
    [code, reqId, `E2E Headcount ${code}`, headcount, status, owner, approvalRouteId]
  );

  if (await tableExists("req_mstr")) {
    await pool.query(
      `INSERT INTO req_mstr (
        req_id, req_code, client_name, project_name, job_title, job_description,
        openings_count, req_status, created_by
      ) VALUES ($1, $2, 'E2E', 'E2E HC QA', $3, 'E2E disposable requisition', $4, $5, 'E2E HC Verify')
      ON CONFLICT (req_id) DO NOTHING`,
      [reqId, code.replace(/^REQ-/, "REQ"), `E2E Headcount ${code}`, headcount, status]
    );
  }

  return reqId;
}

async function assignRecruiter(code, recruiterCode, adminReq) {
  await recruitmentService.assignRecruiter(pool, code, recruiterCode, adminReq);
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
  const codes = [REQ_OPEN, REQ_APPROVED];
  const workflows = await pool.query(
    `SELECT workflow_instance_id
     FROM rm_headcount_change_history
     WHERE requisition_code = ANY($1::text[])
       AND workflow_instance_id IS NOT NULL`,
    [codes]
  );
  const instanceIds = workflows.rows.map((row) => row.workflow_instance_id).filter(Boolean);
  if (instanceIds.length) {
    await pool.query(`DELETE FROM wf_assignments WHERE task_id IN (
      SELECT task_id FROM wf_tasks WHERE instance_id = ANY($1::text[])
    )`, [instanceIds]);
    await pool.query(`DELETE FROM wf_tasks WHERE instance_id = ANY($1::text[])`, [instanceIds]);
    await pool.query(`DELETE FROM wf_instances WHERE instance_id = ANY($1::text[])`, [instanceIds]);
  }
  await pool.query(
    `DELETE FROM rm_headcount_change_history WHERE requisition_code = ANY($1::text[])`,
    [codes]
  );
  await pool.query(`DELETE FROM rm_recruiter_assignments WHERE requisition_code = ANY($1::text[])`, [codes]);
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
}

async function ensureHeadcountChangeMigration() {
  if (await tableExists("rm_headcount_change_history")) {
    return true;
  }

  const migrationPath = path.join(
    __dirname,
    "..",
    "migrations",
    "056_rm_headcount_change_history.sql"
  );
  const sql = fs.readFileSync(migrationPath, "utf8");
  await pool.query(sql);
  return await tableExists("rm_headcount_change_history");
}

async function main() {
  console.log("=== Requisition Headcount Change Verification ===\n");

  const migrationOk = await ensureHeadcountChangeMigration();
  record("Migration 056 table present", migrationOk);
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
  const admin = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name, full_name
     FROM user_mstr WHERE role_name = 'Admin' LIMIT 1`
  ).then((r) => r.rows[0]);

  if (!requestor || !approvalRouteId || !recruiter || !admin) {
    record("Fixtures available", false, "requestor/route/recruiter/admin missing");
    await pool.end();
    return;
  }

  const requestorReq = mockReq(requestor);
  const adminReq = mockReq(admin);

  try {
    await insertRequisition(
      REQ_OPEN,
      REQUISITION_STATUS.OPEN,
      2,
      approvalRouteId,
      requestor.full_name || requestor.email_id
    );
    await insertRequisition(
      REQ_APPROVED,
      REQUISITION_STATUS.APPROVED,
      3,
      approvalRouteId,
      requestor.full_name || requestor.email_id
    );
    await assignRecruiter(REQ_APPROVED, recruiter.employee_code, adminReq);

    const assignmentsBefore = await pool.query(
      `SELECT COUNT(*)::int AS total FROM rm_recruiter_assignments
       WHERE requisition_code = $1 AND is_active = TRUE`,
      [REQ_APPROVED]
    );

    await recruitmentService.updateRequisition(
      pool,
      REQ_OPEN,
      { openings_count: 4 },
      requestorReq
    );
    const openRow = await recruitmentService.loadRequisitionByCode(pool, REQ_OPEN);
    record("Pre-approval headcount edit", openRow.headcount === 4, `headcount=${openRow.headcount}`);

    let approvedEditBlocked = false;
    try {
      await recruitmentService.updateRequisition(
        pool,
        REQ_APPROVED,
        { openings_count: 5 },
        requestorReq
      );
    } catch (error) {
      approvedEditBlocked = error.status === 400;
    }
    record("Approved direct headcount edit blocked", approvedEditBlocked);

    const increase = await requisitionHeadcountChangeService.requestHeadcountChange(
      pool,
      REQ_APPROVED,
      { requested_headcount: 5, reason: `E2E increase ${RUN_ID}` },
      requestorReq
    );
    const pendingIncrease = await requisitionHeadcountChangeService.getPendingHeadcountChange(
      pool,
      REQ_APPROVED
    );
    const duringPending = await recruitmentService.loadRequisitionByCode(pool, REQ_APPROVED);
    record(
      "Increase request created and pending immutability",
      increase.change.status === HEADCOUNT_CHANGE_STATUS.PENDING
        && pendingIncrease?.requested_headcount === 5
        && duringPending.headcount === 3,
      `effective=${duringPending.headcount}, requested=${pendingIncrease?.requested_headcount}`
    );

    let concurrentBlocked = false;
    try {
      await requisitionHeadcountChangeService.requestHeadcountChange(
        pool,
        REQ_APPROVED,
        { requested_headcount: 6, reason: "duplicate pending" },
        requestorReq
      );
    } catch (error) {
      concurrentBlocked = error.status === 409;
    }
    record("Concurrent pending change blocked", concurrentBlocked);

    await approveAllWorkflowSteps(increase.change.workflow_instance_id);
    const afterIncrease = await recruitmentService.loadRequisitionByCode(pool, REQ_APPROVED);
    const approvedHistory = await pool.query(
      `SELECT status, old_headcount, requested_headcount, approved_by
       FROM rm_headcount_change_history
       WHERE change_id = $1`,
      [increase.change.change_id]
    );
    record(
      "Approved increase applies new headcount",
      afterIncrease.headcount === 5
        && approvedHistory.rows[0]?.status === HEADCOUNT_CHANGE_STATUS.APPROVED,
      `headcount=${afterIncrease.headcount}`
    );

    const assignmentsAfter = await pool.query(
      `SELECT COUNT(*)::int AS total FROM rm_recruiter_assignments
       WHERE requisition_code = $1 AND is_active = TRUE`,
      [REQ_APPROVED]
    );
    record(
      "Recruiter assignment preserved",
      assignmentsAfter.rows[0].total === assignmentsBefore.rows[0].total,
      `before=${assignmentsBefore.rows[0].total}, after=${assignmentsAfter.rows[0].total}`
    );

    const reduction = await requisitionHeadcountChangeService.requestHeadcountChange(
      pool,
      REQ_APPROVED,
      { requested_headcount: 4, reason: `E2E reduction ${RUN_ID}` },
      requestorReq
    );
    await rejectWorkflow(reduction.change.workflow_instance_id);
    const afterReject = await recruitmentService.loadRequisitionByCode(pool, REQ_APPROVED);
    const rejectedHistory = await pool.query(
      `SELECT status FROM rm_headcount_change_history WHERE change_id = $1`,
      [reduction.change.change_id]
    );
    record(
      "Rejected reduction leaves effective headcount unchanged",
      afterReject.headcount === 5
        && rejectedHistory.rows[0]?.status === HEADCOUNT_CHANGE_STATUS.REJECTED,
      `headcount=${afterReject.headcount}`
    );

    await pool.query(
      `INSERT INTO om_offers (
        offer_id, requisition_code, candidate_id, offer_status, offered_ctc,
        created_by, modified_by
      ) VALUES ($1, $2, $3, 'Accepted', 1000000, 'E2E HC Verify', 'E2E HC Verify'),
             ($4, $2, $5, 'Accepted', 1000000, 'E2E HC Verify', 'E2E HC Verify')`,
      [
        `OFF-E2E-HC-A-${RUN_ID}`,
        REQ_APPROVED,
        999001,
        `OFF-E2E-HC-B-${RUN_ID}`,
        999002
      ]
    );

    let invalidReductionBlocked = false;
    try {
      await requisitionHeadcountChangeService.requestHeadcountChange(
        pool,
        REQ_APPROVED,
        { requested_headcount: 1, reason: "below capacity" },
        requestorReq
      );
    } catch (error) {
      invalidReductionBlocked = error.status === 409;
    }
    record("Invalid reduction below reserved/filled blocked", invalidReductionBlocked);
    await pool.query(
      `DELETE FROM om_offers WHERE offer_id = ANY($1::text[])`,
      [[`OFF-E2E-HC-A-${RUN_ID}`, `OFF-E2E-HC-B-${RUN_ID}`]]
    );

    const audit = await pool.query(
      `SELECT COUNT(*)::int AS total
       FROM md_enterprise_audit
       WHERE entity_id = $1
         AND event_type IN (
           'RequisitionHeadcountChangeRequested',
           'RequisitionHeadcountChangeApproved',
           'RequisitionHeadcountChangeRejected'
         )`,
      [REQ_APPROVED]
    );
    record("Audit/history captured", audit.rows[0].total >= 2, `audit_rows=${audit.rows[0].total}`);

    const fulfillment = await getFulfillmentForRequisition(pool, afterIncrease);
    record(
      "Fulfillment uses updated required headcount",
      fulfillment.required_headcount === 5,
      JSON.stringify(fulfillment)
    );

    let unauthorizedBlocked = false;
    try {
      await requisitionHeadcountChangeService.requestHeadcountChange(
        pool,
        REQ_APPROVED,
        { requested_headcount: 6, reason: "unauthorized" },
        mockReq(recruiter)
      );
    } catch (error) {
      unauthorizedBlocked = error.status === 403;
    }
    record("Unauthorized requestor blocked", unauthorizedBlocked);
  } catch (error) {
    record("Runtime", false, error.message);
    console.error(error);
  } finally {
    console.log("\n--- Cleaning disposable data ---");
    await cleanup();
    await pool.end();
  }

  console.log("\n=== Summary ===");
  for (const row of results) {
    console.log(`${row.passed ? "PASS" : "FAIL"} | ${row.name}${row.detail ? ` | ${row.detail}` : ""}`);
  }
}

main();
