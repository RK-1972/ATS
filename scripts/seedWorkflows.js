require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const workflowService = require("../services/workflowService");

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

async function main() {
  try {
    const seedPath = path.join(__dirname, "..", "seed", "workflows.seed.json");
    const instancePath = path.join(__dirname, "..", "seed", "workflowInstance.seed.json");
    const payload = JSON.parse(fs.readFileSync(seedPath, "utf8"));
    const primaryInstance = JSON.parse(fs.readFileSync(instancePath, "utf8"));

    await workflowService.seedConfiguration(pool, payload, primaryInstance, {
      name: "System Seed",
      role: "Admin"
    });

    console.log("✅ Workflow engine seeded.");
  } catch (error) {
    console.error("Seed failed:", error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
