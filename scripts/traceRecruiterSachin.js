require("dotenv").config();

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
  console.log("=== STEP 0: Find Sachin in users ===");
  const users = await pool.query(
    `SELECT user_id, employee_code, full_name, role_name, email_id
     FROM user_mstr
     WHERE LOWER(COALESCE(full_name, '')) LIKE '%sachin%'
        OR LOWER(COALESCE(employee_code, '')) LIKE '%sachin%'
        OR LOWER(COALESCE(email_id, '')) LIKE '%sachin%'`
  );
  console.log("Input: name LIKE %sachin%");
  console.log("Output rows:", users.rows.length);
  console.log(JSON.stringify(users.rows, null, 2));

  const sachin = users.rows[0];
  if (!sachin) {
    console.log("\nNo Sachin user found — listing all recruiters in assignments:");
    const allRecruiters = await pool.query(
      `SELECT DISTINCT recruiter_code FROM rm_recruiter_assignments ORDER BY recruiter_code`
    );
    console.log(allRecruiters.rows);
    const legacyRecruiters = await pool.query(
      `SELECT DISTINCT recruiter_code, recruiter_id FROM req_recruiter_map LIMIT 20`
    );
    console.log("Legacy req_recruiter_map codes:", legacyRecruiters.rows);
    const pipelineRecruiters = await pool.query(
      `SELECT DISTINCT recruiter_id FROM rm_candidate_mappings WHERE is_active = true`
    );
    console.log("Pipeline recruiter_id values:", pipelineRecruiters.rows);
  }

  const employeeCode = sachin?.employee_code;

  console.log("\n=== STEP 8: getRecruitmentBundle SQL (full bundle, no user filter) ===");
  const bundle = await recruitmentService.getRecruitmentBundle(pool);
  console.log("requisitions:", bundle.requisitions.length);
  console.log("recruiterAssignments:", bundle.recruiterAssignments.length);
  console.log("pipeline:", bundle.pipeline.length);
  console.log("summary:", bundle.summary);

  if (employeeCode) {
    console.log("\n=== STEP 9: Sachin assignment match ===");
    console.log("employee_code from users:", employeeCode);

    const enterpriseAssignments = bundle.recruiterAssignments.filter(
      (row) => row.recruiter_code === employeeCode
    );
    console.log("Enterprise assignments matching employee_code:", enterpriseAssignments.length);
    console.log(JSON.stringify(enterpriseAssignments, null, 2));

    const legacyMatch = await pool.query(
      `SELECT * FROM req_recruiter_map WHERE recruiter_code = $1 AND is_active = true`,
      [employeeCode]
    );
    console.log("Legacy req_recruiter_map rows for employee_code:", legacyMatch.rows.length);

    const pipelineByCode = bundle.pipeline.filter(
      (row) => row.recruiter_id === employeeCode
        || row.recruiter_id === sachin.full_name
    );
    console.log("Pipeline rows where recruiter_id matches employee_code or first_name:", pipelineByCode.length);

    const distinctRecruiterIds = [...new Set(bundle.pipeline.map((r) => r.recruiter_id))];
    console.log("Distinct recruiter_id in pipeline:", distinctRecruiterIds);
  }

  console.log("\n=== All recruiter_code values in rm_recruiter_assignments ===");
  const codes = await pool.query(
    `SELECT recruiter_code, COUNT(*) AS cnt
     FROM rm_recruiter_assignments
     WHERE is_active = true
     GROUP BY recruiter_code
     ORDER BY recruiter_code`
  );
  console.log(JSON.stringify(codes.rows, null, 2));

  console.log("\n=== Sample pipeline recruiter_id values ===");
  const samplePipeline = await pool.query(
    `SELECT map_id, recruiter_id, requisition_code, stage_name
     FROM rm_candidate_mappings
     WHERE is_active = true
     LIMIT 10`
  );
  console.log(JSON.stringify(samplePipeline.rows, null, 2));

  await pool.end();
}

main().catch(async (error) => {
  console.error(error);
  await pool.end();
  process.exit(1);
});
