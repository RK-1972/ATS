require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

async function main() {
  const sql = fs.readFileSync(
    path.join(
      __dirname,
      "..",
      "migrations",
      "042_approval_route_policy_multi_criteria.sql"
    ),
    "utf8"
  );

  await pool.query(sql);
  console.log("Applied 042_approval_route_policy_multi_criteria.sql");

  const columns = await pool.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_name = 'approval_route_policy'
       AND column_name IN ('designations', 'grades')
     ORDER BY column_name`
  );

  console.log("Columns:", columns.rows.map((row) => row.column_name).join(", "));
  await pool.end();
}

main().catch(async (error) => {
  console.error(error.message);
  await pool.end();
  process.exit(1);
});
