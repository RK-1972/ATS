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

async function runMigration(fileName) {
  const filePath = path.join(__dirname, "..", "migrations", fileName);
  const sql = fs.readFileSync(filePath, "utf8");
  await pool.query(sql);
  console.log(`✅ Applied ${fileName}`);
}

async function runAllMigrations() {
  const migrationsDir = path.join(__dirname, "..", "migrations");
  const files = fs
    .readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();

  for (const file of files) {
    await runMigration(file);
  }
}

async function main() {
  try {
    await runAllMigrations();
    console.log("All migrations applied.");
  } catch (error) {
    console.error("Migration failed:", error.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
