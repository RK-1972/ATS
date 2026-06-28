require("dotenv").config();
const { Pool } = require("pg");

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

async function main() {
  const tables = [
    "req_mstr",
    "candidate_req_map",
    "req_recruiter_map",
    "interview_schedule_trn",
    "interview_feedback_hdr",
    "interview_feedback_dtl"
  ];

  for (const table of tables) {
    const result = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1
       ORDER BY ordinal_position`,
      [table]
    );
    console.log(`\n=== ${table} ===`);
    console.log(result.rows.map((row) => row.column_name).join(", "));
  }

  const sample = await pool.query("SELECT * FROM req_mstr LIMIT 1");
  console.log("\nSample req_mstr row keys:", Object.keys(sample.rows[0] || {}));

  await pool.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
