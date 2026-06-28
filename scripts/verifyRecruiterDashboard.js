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

async function main() {
  const employeeCode = "IGS0506";
  const req = { user: { employee_code: employeeCode, role_name: "Recruiter", user_id: 10 } };

  console.log("=== SQL / Service: getMyRecruiterDashboard ===");
  const bundle = await recruitmentService.getMyRecruiterDashboard(pool, req);
  console.log({
    employee_code: bundle.employee_code,
    requisitions: bundle.requisitions.length,
    recruiterAssignments: bundle.recruiterAssignments.length,
    pipeline: bundle.pipeline.length,
    interviews: bundle.interviews.length,
    tasks: bundle.tasks.length,
    summary: bundle.summary
  });

  const otherRecruiter = await pool.query(
    `SELECT COUNT(*)::int AS count
     FROM rm_recruiter_assignments
     WHERE recruiter_code <> $1 AND is_active = true`,
    [employeeCode]
  );

  console.log("\n=== Isolation check ===");
  console.log("Other recruiter active assignments in DB:", otherRecruiter.rows[0].count);
  console.log("Returned assignment recruiter codes:", [
    ...new Set(bundle.recruiterAssignments.map((row) => row.recruiter_code))
  ]);

  const token = jwt.sign(
    { user_id: 10, employee_code: employeeCode, role_name: "Recruiter" },
    process.env.JWT_SECRET,
    { expiresIn: "8h" }
  );

  console.log("\n=== API: GET /api/v1/recruitment/my-dashboard ===");
  try {
    const response = await axios.get("http://localhost:5000/api/v1/recruitment/my-dashboard", {
      headers: { Authorization: `Bearer ${token}` }
    });

    console.log({
      status: response.status,
      requisitions: response.data.requisitions.length,
      pipeline: response.data.pipeline.length,
      interviews: response.data.interviews.length,
      tasks: response.data.tasks.length,
      summary: response.data.summary
    });
  } catch (error) {
    console.error("API request failed:", error.response?.status, error.response?.data || error.message);
  }

  const fullBundle = await recruitmentService.getRecruitmentBundle(pool);
  console.log("\n=== Enterprise-wide bundle (must NOT be used by workspace) ===");
  console.log({
    requisitions: fullBundle.requisitions.length,
    pipeline: fullBundle.pipeline.length
  });

  const pendingTasks = await pool.query(
    "SELECT task_id, module, assignee, assignee_role, business_object_id, business_object_type FROM et_tasks WHERE status = 'Pending'"
  );
  console.log("\n=== Pending tasks in DB ===");
  console.log(JSON.stringify(pendingTasks.rows, null, 2));

  await pool.end();
}

main().catch(async (error) => {
  console.error(error.response?.data || error.message);
  await pool.end();
  process.exit(1);
});
