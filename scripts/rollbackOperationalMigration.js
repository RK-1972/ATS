require("dotenv").config();

const { Pool } = require("pg");
const { rollbackOperationalMigration } = require("../services/operationalMigrationService");

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

async function main() {
  try {
    console.log("Rolling back operational migration (enterprise migrated rows only)...");
    const result = await rollbackOperationalMigration(pool);
    console.log(JSON.stringify(result, null, 2));
    console.log("\nSet OPERATIONAL_SOR=legacy in environment to restore legacy read path.");
    console.log("✅ Rollback complete.");
  } catch (error) {
    console.error("Rollback failed:", error.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
