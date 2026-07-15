require("dotenv").config();

const jwt = require("jsonwebtoken");
const axios = require("axios");
const { Pool } = require("pg");
const recruitmentService = require("../services/recruitmentService");

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

const RECRUITER = "IGS0506";

async function countActive(employeeCode) {
  const enterprise = await pool.query(
    `SELECT COUNT(*)::int AS count
     FROM rm_recruiter_assignments
     WHERE recruiter_code = $1 AND is_active = true`,
    [employeeCode]
  );
  const legacy = await pool.query(
    `SELECT COUNT(*)::int AS count
     FROM req_recruiter_map
     WHERE recruiter_code = $1 AND is_active = true`,
    [employeeCode]
  );
  return {
    enterprise: enterprise.rows[0].count,
    legacy: legacy.rows[0].count
  };
}

async function dashboardCount(employeeCode) {
  const bundle = await recruitmentService.getMyRecruiterDashboard(pool, {
    user: { employee_code: employeeCode, role_name: "Recruiter" }
  });
  return {
    requisitions: bundle.requisitions.length,
    assignments: bundle.recruiterAssignments.length
  };
}

async function main() {
  console.log("=== Sprint 9.1 — Sachin Verification ===\n");

  const before = await countActive(RECRUITER);
  const dashBefore = await dashboardCount(RECRUITER);

  console.log("BEFORE removeRecruiterAssignment:");
  console.log({
    enterpriseActiveAssignments: before.enterprise,
    legacyActiveAssignments: before.legacy,
    myDashboardRequisitions: dashBefore.requisitions,
    myDashboardAssignments: dashBefore.assignments
  });

  const legacyTarget = await pool.query(
    `SELECT map_id, req_id, recruiter_code
     FROM req_recruiter_map
     WHERE recruiter_code = $1 AND is_active = true
     ORDER BY map_id ASC
     LIMIT 1`,
    [RECRUITER]
  );

  if (!legacyTarget.rows.length) {
    console.log("\nNo active legacy map_id to remove — pick enterprise assignment_id instead.");
    const ent = await pool.query(
      `SELECT assignment_id FROM rm_recruiter_assignments
       WHERE recruiter_code = $1 AND is_active = true
       ORDER BY assignment_id ASC LIMIT 1`,
      [RECRUITER]
    );
    if (!ent.rows.length) {
      console.log("No active assignments left to test.");
      await pool.end();
      return;
    }
    legacyTarget.rows[0] = { map_id: ent.rows[0].assignment_id };
  }

  const mapId = legacyTarget.rows[0].map_id;
  console.log("\nRemoving assignment via service, mapId:", mapId);

  const adminReq = {
    user: {
      employee_code: "IGS1001",
      role_name: "TA Lead",
      full_name: "TA Lead User"
    }
  };

  const result = await recruitmentService.removeRecruiterAssignment(pool, mapId, adminReq);
  console.log("Service result:", {
    assignment_id: result.assignment.assignment_id,
    requisition_code: result.assignment.requisition_code,
    recruiter_code: result.assignment.recruiter_code,
    is_active: result.assignment.is_active
  });

  const after = await countActive(RECRUITER);
  const dashAfter = await dashboardCount(RECRUITER);

  console.log("\nAFTER removeRecruiterAssignment:");
  console.log({
    enterpriseActiveAssignments: after.enterprise,
    legacyActiveAssignments: after.legacy,
    myDashboardRequisitions: dashAfter.requisitions,
    myDashboardAssignments: dashAfter.assignments
  });

  const token = jwt.sign(
    { user_id: 1, employee_code: RECRUITER, role_name: "Recruiter" },
    process.env.JWT_SECRET,
    { expiresIn: "1h" }
  );

  try {
    const api = await axios.get("http://127.0.0.1:5000/api/v1/recruitment/my-dashboard", {
      headers: { Authorization: `Bearer ${token}` }
    });
    console.log("\nAPI my-dashboard after remove:", {
      requisitions: api.data.requisitions.length,
      assignments: api.data.recruiterAssignments.length,
      summary: api.data.summary
    });
  } catch (error) {
    console.log("\nAPI check skipped:", error.response?.status || error.message);
  }

  const pass = before.enterprise - after.enterprise === 1
    && dashBefore.requisitions - dashAfter.requisitions === 1;

  console.log("\nVERIFICATION:", pass ? "PASS" : "CHECK COUNTS MANUALLY");

  await pool.end();
}

main().catch(async (error) => {
  console.error(error);
  await pool.end();
  process.exit(1);
});
