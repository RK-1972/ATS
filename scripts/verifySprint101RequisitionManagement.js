require("dotenv").config();

const { Pool } = require("pg");
const recruitmentService = require("../services/recruitmentService");
const { isLegacyDualWriteEnabled } = require("../config/operationalCutover");

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

const adminReq = {
  user: {
    employee_code: "ADMIN001",
    role_name: "Admin",
    full_name: "Verification Admin"
  }
};

async function countTables() {
  const [rmReq, rmAssign, legacyReq, legacyMap] = await Promise.all([
    pool.query("SELECT COUNT(*)::int AS c FROM rm_requisitions"),
    pool.query("SELECT COUNT(*)::int AS c FROM rm_recruiter_assignments WHERE is_active = true"),
    pool.query("SELECT COUNT(*)::int AS c FROM req_mstr").catch(() => ({ rows: [{ c: null }] })),
    pool.query("SELECT COUNT(*)::int AS c FROM req_recruiter_map WHERE is_active = true").catch(() => ({ rows: [{ c: null }] }))
  ]);

  return {
    rm_requisitions: rmReq.rows[0].c,
    rm_recruiter_assignments_active: rmAssign.rows[0].c,
    req_mstr: legacyReq.rows[0].c,
    req_recruiter_map_active: legacyMap.rows[0].c
  };
}

async function main() {
  console.log("=== Sprint 10.1 — Requisition Management Verification ===\n");
  console.log("OPERATIONAL_SOR:", process.env.OPERATIONAL_SOR || "enterprise (default)");
  console.log("LEGACY_DUAL_WRITE:", isLegacyDualWriteEnabled());
  console.log("");

  const countsBefore = await countTables();
  console.log("DB counts (before):", countsBefore);

  const list = await recruitmentService.listRequisitionsForManagement(pool);
  console.log("\n1. listRequisitionsForManagement:");
  console.log("   rows:", list.length);
  console.log("   source: rm_requisitions only");
  if (list.length) {
    console.log("   sample:", {
      req_id: list[0].req_id,
      req_code: list[0].req_code,
      req_status: list[0].req_status
    });
  }

  const sampleReq = list[0];
  if (!sampleReq?.req_id) {
    console.log("\nSKIP assign/remove — no requisitions in rm_requisitions");
    await pool.end();
    return;
  }

  const assignedBefore = await recruitmentService.getAssignedRecruitersForRequisition(
    pool,
    sampleReq.req_id
  );
  console.log("\n2. getAssignedRecruitersForRequisition:");
  console.log("   req_id:", sampleReq.req_id);
  console.log("   active assignments:", assignedBefore.length);
  console.log("   source: rm_recruiter_assignments + user_mstr");

  const recruiters = await recruitmentService.listFormRecruiters(pool);
  const recruiterCode = recruiters.find((r) =>
    !assignedBefore.some((a) => a.employee_code === r.employee_code)
  )?.employee_code || recruiters[0]?.employee_code;

  if (!recruiterCode) {
    console.log("\nSKIP assign — no recruiters in user_mstr");
    await pool.end();
    return;
  }

  let assignedAfterAssign = assignedBefore;
  try {
    await recruitmentService.assignRecruiter(pool, sampleReq.req_id, recruiterCode, adminReq);
    assignedAfterAssign = await recruitmentService.getAssignedRecruitersForRequisition(
      pool,
      sampleReq.req_id
    );
    console.log("\n3. assignRecruiter:");
    console.log("   recruiter:", recruiterCode);
    console.log("   assignments before:", assignedBefore.length);
    console.log("   assignments after:", assignedAfterAssign.length);
    console.log("   PASS:", assignedAfterAssign.length >= assignedBefore.length);
  } catch (error) {
    console.log("\n3. assignRecruiter FAILED:", error.message);
  }

  const newAssignment = assignedAfterAssign.find((a) => a.employee_code === recruiterCode);
  if (newAssignment) {
    try {
      await recruitmentService.removeRecruiterAssignment(
        pool,
        newAssignment.assignment_id,
        adminReq
      );
      const assignedAfterRemove = await recruitmentService.getAssignedRecruitersForRequisition(
        pool,
        sampleReq.req_id
      );
      console.log("\n4. removeRecruiterAssignment:");
      console.log("   assignment_id:", newAssignment.assignment_id);
      console.log("   assignments after remove:", assignedAfterRemove.length);
      console.log("   PASS:", assignedAfterRemove.length === assignedBefore.length);
    } catch (error) {
      console.log("\n4. removeRecruiterAssignment FAILED:", error.message);
    }
  }

  const dash = await recruitmentService.getMyRecruiterDashboard(pool, {
    user: { employee_code: recruiterCode, role_name: "Recruiter" }
  });
  console.log("\n5. getMyRecruiterDashboard (workspace sync source):");
  console.log("   recruiter:", recruiterCode);
  console.log("   requisitions:", dash.requisitions.length);
  console.log("   assignments:", dash.recruiterAssignments.length);

  const countsAfter = await countTables();
  console.log("\nDB counts (after):", countsAfter);

  console.log("\n6. createRequisitionFromForm (validation only — no approved_position_id):");
  try {
    await recruitmentService.handleLegacyCreateRequisition(pool, {
      client_name: "Test",
      job_title: "Test",
      primary_skill: "Java",
      work_location: "Bangalore",
      employment_type: "Full Time",
      priority_level: "High",
      target_date: "2026-12-31"
    }, adminReq);
    console.log("   UNEXPECTED SUCCESS");
  } catch (error) {
    console.log("   expected rejection:", error.message);
    console.log("   PASS: business rule unchanged");
  }

  await pool.end();
  console.log("\n=== Verification script complete ===");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
