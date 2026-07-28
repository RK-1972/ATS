/**
 * One-time alignment: wp_approved_positions used free-text workforce labels
 * (Delivery, Engineering, L5, L4) that are not present in md_records.
 * Map each row to an existing Master Data department name + grade code.
 * Does NOT insert master-data rows.
 */
require("dotenv").config();
const { Pool } = require("pg");

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

/** Proven existing md_records values (see db investigation). */
const ALIGNMENT = [
  {
    position_id: "AP-2026-0089",
    department: "Project Management Office",
    grade: "G5"
  },
  {
    position_id: "AP-2026-0076",
    department: "IT Infrastructure",
    grade: "G5"
  },
  {
    position_id: "AP-2026-0062",
    department: "Testing",
    grade: "G5"
  },
  {
    position_id: "AP-2026-0054",
    department: "IT Infrastructure",
    grade: "G4"
  }
];

async function assertMasterExists(client, entityType, field, value) {
  const result = await client.query(
    `SELECT 1
     FROM md_records
     WHERE entity_type = $1
       AND is_deleted = FALSE
       AND (LOWER(name) = LOWER($2) OR LOWER(code) = LOWER($2))
     LIMIT 1`,
    [entityType, value]
  );
  if (!result.rows.length) {
    throw new Error(`Master data missing ${entityType}.${field}=${value}`);
  }
}

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    for (const row of ALIGNMENT) {
      await assertMasterExists(client, "departments", "name", row.department);
      await assertMasterExists(client, "grades", "code", row.grade);

      const updated = await client.query(
        `UPDATE wp_approved_positions
         SET department = $2,
             grade = $3,
             modified_on = NOW()
         WHERE position_id = $1
         RETURNING position_id, department, grade, position_title, status`,
        [row.position_id, row.department, row.grade]
      );

      if (!updated.rows.length) {
        throw new Error(`Approved position not found: ${row.position_id}`);
      }

      console.log("Aligned", updated.rows[0]);
    }

    await client.query("COMMIT");
    console.log("Approved positions aligned to existing Master Data.");
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
