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
  const columns = await pool.query(`
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'cand_mstr'
    ORDER BY ordinal_position
  `);

  const constraints = await pool.query(`
    SELECT conname, pg_get_constraintdef(oid) AS definition
    FROM pg_constraint
    WHERE conrelid = 'public.cand_mstr'::regclass
  `);

  console.log("cand_mstr columns:", columns.rows.length);
  columns.rows.forEach((row) => {
    console.log(`  ${row.column_name} | ${row.data_type} | nullable=${row.is_nullable}`);
  });

  console.log("\nconstraints:");
  constraints.rows.forEach((row) => {
    console.log(`  ${row.conname}: ${row.definition}`);
  });

  await pool.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
