require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const REQUIRED_DB_CONFIG_KEYS = ["DB_HOST", "DB_PORT", "DB_USER", "DB_NAME"];

function assertDatabaseConfig() {
  const missing = REQUIRED_DB_CONFIG_KEYS.filter((key) => {
    const value = process.env[key];
    return value === undefined || value === null || String(value).trim() === "";
  });

  if (missing.length) {
    throw new Error(
      `Missing required database configuration: ${missing.join(", ")}`
    );
  }
}

function createPool() {
  return new Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
  });
}

async function assertEmployeeCodeColumnWidth(pool) {
  const col = await pool.query(
    `SELECT character_maximum_length
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'interview_panel_mstr'
       AND column_name = 'employee_code'`
  );

  if (!col.rows.length) {
    throw new Error(
      "public.interview_panel_mstr.employee_code column not found after migration"
    );
  }

  const maxLength = col.rows[0].character_maximum_length;

  if (maxLength !== 100) {
    throw new Error(
      `Expected interview_panel_mstr.employee_code character_maximum_length 100, got ${maxLength}`
    );
  }

  return maxLength;
}

let pool;

async function main() {
  assertDatabaseConfig();

  pool = createPool();

  try {
    const filePath = path.join(
      __dirname,
      "..",
      "migrations",
      "060_interview_panel_mstr_employee_code_extend.sql"
    );
    const sql = fs.readFileSync(filePath, "utf8");
    await pool.query(sql);

    const maxLength = await assertEmployeeCodeColumnWidth(pool);

    console.log(
      `✅ Applied 060_interview_panel_mstr_employee_code_extend.sql (employee_code max length: ${maxLength})`
    );
  } finally {
    await pool.end().catch(() => {});
    pool = undefined;
  }
}

main().catch(async (error) => {
  if (pool) {
    await pool.end().catch(() => {});
    pool = undefined;
  }

  console.error("Migration failed:", error.message);
  process.exit(1);
});
