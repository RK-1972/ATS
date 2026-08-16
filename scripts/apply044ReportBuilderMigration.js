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
  const filePath = path.join(__dirname, "..", "migrations", "044_report_builder_schema.sql");
  const sql = fs.readFileSync(filePath, "utf8");
  await pool.query(sql);
  console.log("Applied 044_report_builder_schema.sql");
  await pool.end();
}

main().catch((error) => {
  console.error("Migration failed:", error.message);
  process.exit(1);
});
