/**
 * Verifies approved-position consumption and workforce requisition queue classification.
 */
require("dotenv").config();
const { Pool } = require("pg");
const workforcePlanningService = require("../services/workforcePlanningService");
const recruitmentService = require("../services/recruitmentService");
const { REQUISITION_STATUS } = require("../constants/requisitionStatus");

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

async function resolveRequestorEmployeeCode(pool) {
  const result = await pool.query(
    `SELECT ewa.employee_code, u.email_id, u.full_name
     FROM employee_work_assignment ewa
     INNER JOIN work_assignment_mstr wam
       ON wam.work_assignment_id = ewa.work_assignment_id
     LEFT JOIN user_mstr u ON u.employee_code = ewa.employee_code
     WHERE ewa.is_active = TRUE
       AND wam.assignment_code = 'REQUISITION_REQUESTOR'
     ORDER BY ewa.employee_work_assignment_id
     LIMIT 1`
  );

  if (result.rows[0]?.employee_code) {
    return result.rows[0];
  }

  const fallback = await pool.query(
    `SELECT created_by AS employee_code, created_by AS email_id, created_by AS full_name
     FROM rm_requisitions
     WHERE created_by IS NOT NULL
     GROUP BY created_by
     ORDER BY COUNT(*) DESC
     LIMIT 1`
  );

  return fallback.rows[0] || null;
}

function mockReq(requestor) {
  const employeeCode = requestor?.employee_code || "IGS1001";
  return {
    user: {
      employee_code: employeeCode,
      role_name: "Recruiter",
      email_id: requestor?.email_id || `${String(employeeCode).toLowerCase()}@optalynx.local`,
      full_name: requestor?.full_name || employeeCode
    }
  };
}

async function main() {
  const failures = [];

  try {
    const requestor = await resolveRequestorEmployeeCode(pool);

    if (!requestor?.employee_code) {
      console.log("No REQUISITION_REQUESTOR user found — skipping queue authorization checks.");
      process.exitCode = 0;
      return;
    }

    const req = mockReq(requestor);
    const bundle = await workforcePlanningService.getWorkforceBundle(pool, req);
    const available = bundle.config.approved_positions || [];

    const linked = await pool.query(
      `SELECT approved_position_id, requisition_code, req_status, created_by
       FROM rm_requisitions
       WHERE approved_position_id IS NOT NULL`
    );

    for (const row of linked.rows) {
      const positionId = row.approved_position_id;
      const inAvailable = available.some((item) => item.id === positionId);

      if (inAvailable) {
        failures.push(
          `Position ${positionId} has requisition ${row.requisition_code} but still appears as available`
        );
      }
    }

    if (bundle.config.requisitions_raised?.length) {
      failures.push(
        "Workforce bundle must not expose requisitions_raised on Approved Positions catalogue"
      );
    }

    const approvedQueue = await workforcePlanningService.listWorkforceRequisitionQueue(
      pool,
      "approved",
      req
    );
    const clarificationQueue = await workforcePlanningService.listWorkforceRequisitionQueue(
      pool,
      "clarification",
      req
    );
    const rejectedQueue = await workforcePlanningService.listWorkforceRequisitionQueue(
      pool,
      "rejected",
      req
    );

    const expectedApproved = await pool.query(
      `SELECT COUNT(*)::int AS total
       FROM rm_requisitions
       WHERE created_by = ANY($1::text[])
         AND req_status = $2`,
      [
        [
          requestor.employee_code,
          requestor.email_id,
          requestor.full_name
        ].filter(Boolean),
        REQUISITION_STATUS.APPROVED
      ]
    );

    if (approvedQueue.rows.length !== expectedApproved.rows[0]?.total) {
      failures.push(
        `Approved queue returned ${approvedQueue.rows.length} rows but database has ${expectedApproved.rows[0]?.total} for requestor ${requestor.employee_code}`
      );
    }

    for (const row of approvedQueue.rows) {
      if (row.req_status !== REQUISITION_STATUS.APPROVED) {
        failures.push(
          `Approved queue contains non-approved requisition ${row.requisition_code}`
        );
      }
    }

    for (const row of clarificationQueue.rows) {
      if (row.req_status !== REQUISITION_STATUS.CLARIFICATION_REQUESTED) {
        failures.push(
          `Clarification queue contains unexpected status for ${row.requisition_code}`
        );
      }
    }

    for (const row of rejectedQueue.rows) {
      if (row.req_status !== REQUISITION_STATUS.REJECTED) {
        failures.push(
          `Rejected queue contains unexpected status for ${row.requisition_code}`
        );
      }
    }

    const queueCodes = new Set([
      ...approvedQueue.rows.map((row) => row.requisition_code),
      ...clarificationQueue.rows.map((row) => row.requisition_code),
      ...rejectedQueue.rows.map((row) => row.requisition_code)
    ]);

    for (const code of queueCodes) {
      const memberships = [
        approvedQueue.rows.some((row) => row.requisition_code === code),
        clarificationQueue.rows.some((row) => row.requisition_code === code),
        rejectedQueue.rows.some((row) => row.requisition_code === code)
      ].filter(Boolean).length;

      if (memberships > 1) {
        failures.push(`Requisition ${code} appears in multiple lifecycle queues`);
      }
    }

    if (rejectedQueue.rows.length || clarificationQueue.rows.length || approvedQueue.rows.length) {
      const sample =
        clarificationQueue.rows[0] ||
        rejectedQueue.rows[0] ||
        approvedQueue.rows[0];

      if (sample?.approved_position_id) {
        try {
          await recruitmentService.createFromApprovedPosition(
            pool,
            sample.approved_position_id,
            {},
            req
          );
          failures.push(
            `Duplicate create was not rejected for consumed position ${sample.approved_position_id}`
          );
        } catch (error) {
          if (error.status !== 409) {
            failures.push(
              `Expected HTTP 409 for duplicate create on ${sample.approved_position_id}, got ${error.status || "unknown"}`
            );
          }
        }
      }
    }

    console.log(`Available positions: ${available.length}`);
    console.log(
      `Queues — approved: ${approvedQueue.rows.length}, clarification: ${clarificationQueue.rows.length}, rejected: ${rejectedQueue.rows.length}`
    );
    console.log("\n--- Summary ---");
    console.log(`Failures: ${failures.length}`);

    if (failures.length) {
      failures.forEach((message) => console.error(`  ✗ ${message}`));
      process.exitCode = 1;
      return;
    }

    console.log("Approved position and requisition queue checks passed.");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
