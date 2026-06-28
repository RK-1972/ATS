require("dotenv").config();

const { Pool } = require("pg");
const { validateOperationalMigration } = require("../services/operationalMigrationService");

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

async function main() {
  try {
    const validation = await validateOperationalMigration(pool);
    console.log(JSON.stringify(validation, null, 2));
    process.exit(validation.allPass ? 0 : 1);
  } catch (error) {
    console.error("Validation failed:", error.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
