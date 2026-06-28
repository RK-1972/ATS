require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const offerManagementService = require("../services/offerManagementService");

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

async function main() {
  try {
    const seedPath = path.join(__dirname, "..", "seed", "offers.seed.json");
    const payload = JSON.parse(fs.readFileSync(seedPath, "utf8"));

    await offerManagementService.seedConfiguration(pool, payload, {
      name: "System Seed",
      role: "Admin"
    });

    console.log("✅ Offer management seeded.");
  } catch (error) {
    console.error("Seed failed:", error.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
