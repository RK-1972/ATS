require("dotenv").config();

const { Pool } = require("pg");
const { isValidEntityType, ENTITY_TYPE_KEYS } = require("../masterData/entityTypes");
const masterDataService = require("../services/masterDataService");

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

async function main() {
  console.log("registry includes interview_stages:", ENTITY_TYPE_KEYS.includes("interview_stages"));
  console.log("isValidEntityType:", isValidEntityType("interview_stages"));
  console.log("resolveEntityType:", masterDataService.resolveEntityType("interview-stages"));

  const registry = await pool.query(
    "SELECT entity_type, domain_key, label, table_name FROM md_entity_types WHERE entity_type = $1",
    ["interview_stages"]
  );
  console.log("md_entity_types row:", registry.rows[0]);

  const view = await pool.query(
    "SELECT table_name FROM information_schema.views WHERE table_schema = 'public' AND table_name = $1",
    ["md_interview_stages"]
  );
  console.log("view exists:", view.rowCount > 0);

  const list = await masterDataService.listByEntityType(pool, "interview_stages");
  console.log("generic list API works, record count:", list.length);

  await pool.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
