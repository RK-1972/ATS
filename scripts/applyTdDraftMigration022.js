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
  const filePath = path.join(__dirname, "..", "migrations", "022_td_draft_mstr.sql");
  const sql = fs.readFileSync(filePath, "utf8");
  await pool.query(sql);
  const check = await pool.query(
    `SELECT to_regclass('public.td_draft_mstr') AS reg`
  );
  console.log("Applied 022_td_draft_mstr.sql");
  console.log("td_draft_mstr:", check.rows[0].reg);
}

main()
  .catch((e) => {
    console.error(e.message);
    process.exit(1);
  })
  .finally(() => pool.end());
