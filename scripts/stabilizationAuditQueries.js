require("dotenv").config();

const { Pool } = require("pg");

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

async function main() {
  console.log("=== PRIORITY 1: interview_types in md_records ===");
  const md = await pool.query(
    `SELECT code, name, status, version_status
     FROM md_records
     WHERE entity_type = 'interview_types' AND is_deleted = FALSE
     ORDER BY name`
  );
  console.log(JSON.stringify(md.rows, null, 2));

  console.log("\n=== md_records entity counts ===");
  const counts = await pool.query(
    `SELECT entity_type, COUNT(*)::int AS count
     FROM md_records WHERE is_deleted = FALSE
     GROUP BY entity_type ORDER BY entity_type`
  );
  console.log(JSON.stringify(counts.rows, null, 2));

  const br = await pool.query("SELECT COUNT(*)::int AS count FROM br_rules");
  console.log("\nbr_rules count:", br.rows[0].count);
  const pc = await pool.query("SELECT id FROM pc_config_state");
  console.log("pc_config_state rows:", pc.rows.length);

  console.log("\n=== PRIORITY 2: Recruiter Cockpit SQL row counts (IGS0506) ===");
  const employeeCode = "IGS0506";
  const today = todayIso();
  const ranges = [
    ["Today", today, today],
    ["Last 7 Days", addDays(today, -6), today],
    ["Last 30 Days", addDays(today, -29), today],
    ["Custom Apr 2026", "2026-04-01", "2026-04-30"]
  ];

  for (const [label, fromDate, toDate] of ranges) {
    const pipelineSql = `
      SELECT COUNT(*)::int AS count
      FROM rm_candidate_mappings m
      INNER JOIN rm_recruiter_assignments a ON a.requisition_code = m.requisition_code
      WHERE a.recruiter_code = $1 AND a.is_active = true AND m.is_active = true
        AND DATE(m.applied_on) >= $2::date AND DATE(m.applied_on) <= $3::date`;

    const interviewsSql = `
      SELECT COUNT(*)::int AS count
      FROM im_interviews i
      INNER JOIN rm_recruiter_assignments a ON a.requisition_code = i.requisition_code
      WHERE a.recruiter_code = $1 AND a.is_active = true
        AND i.interview_date >= $2::date AND i.interview_date <= $3::date`;

    const historySql = `
      SELECT COUNT(*)::int AS count
      FROM rm_pipeline_history h
      INNER JOIN rm_recruiter_assignments a ON a.requisition_code = h.requisition_code
      WHERE a.recruiter_code = $1 AND a.is_active = true
        AND DATE(h.created_on) >= $2::date AND DATE(h.created_on) <= $3::date`;

    const params = [employeeCode, fromDate, toDate];
    const [p, i, h] = await Promise.all([
      pool.query(pipelineSql, params),
      pool.query(interviewsSql, params),
      pool.query(historySql, params)
    ]);

    console.log(`\n--- ${label} ---`);
    console.log("Parameters:", { employeeCode, fromDate, toDate });
    console.log("Pipeline entered (applied_on):", p.rows[0].count);
    console.log("Interviews (interview_date):", i.rows[0].count);
    console.log("Pipeline history events:", h.rows[0].count);
  }

  await pool.end();
}

main().catch(async (error) => {
  console.error(error);
  await pool.end();
  process.exit(1);
});
