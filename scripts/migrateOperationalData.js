require("dotenv").config();

const { Pool } = require("pg");
const {
  runOperationalMigration,
  validateOperationalMigration
} = require("../services/operationalMigrationService");

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

async function main() {
  try {
    console.log("Starting operational data migration...");
    const results = await runOperationalMigration(pool);
    console.log(JSON.stringify(results, null, 2));

    console.log("\nRunning validation...");
    const validation = await validateOperationalMigration(pool);
    console.log(JSON.stringify(validation, null, 2));

    if (!validation.allPass) {
      console.error("\n❌ Migration validation FAILED.");
      process.exit(1);
    }

    console.log("\n✅ Operational migration and validation PASSED.");
  } catch (error) {
    console.error("Migration failed:", error.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
