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
    path.join(__dirname, "..", "migrations", "041_offer_commercial_fields.sql"),
    "utf8"
  );

  await pool.query(sql);
  console.log("Applied 041_offer_commercial_fields.sql");

  const columns = await pool.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_name = 'om_offers'
       AND column_name IN (
         'expected_joining_date',
         'variable_pay',
         'variable_pay_frequency',
         'joining_bonus',
         'joining_bonus_frequency'
       )
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
