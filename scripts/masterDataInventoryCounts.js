require("dotenv").config();
const { Pool } = require("pg");
const { ENTITY_TYPE_KEYS } = require("../masterData/entityTypes");

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

async function main() {
  const rows = await pool.query(
    `SELECT entity_type, COUNT(*)::int AS count
     FROM md_records WHERE is_deleted = FALSE
     GROUP BY entity_type ORDER BY entity_type`
  );
  const countMap = Object.fromEntries(rows.rows.map((r) => [r.entity_type, r.count]));
  const inventory = ENTITY_TYPE_KEYS.map((entityType) => ({
    entityType,
    currentCount: countMap[entityType] || 0
  }));
  console.log(JSON.stringify({ totalRecords: rows.rows.reduce((s, r) => s + r.count, 0), inventory }, null, 2));
  await pool.end();
}

main().catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });
