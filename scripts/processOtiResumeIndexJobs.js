/**
 * Operational entry point for OTI Phase 2 resume indexing jobs.
 *
 * Schedule via cron or a process supervisor (no Redis/BullMQ in Phase 2), e.g.:
 *   node scripts/processOtiResumeIndexJobs.js
 *
 * Requires DB env vars and migration 073 applied in the target environment.
 */

require("dotenv").config();

const { Pool } = require("pg");
const otiResumeIndexService = require("../services/oti/otiResumeIndexService");

async function main() {
  const limit = Number(process.env.OTI_INDEX_JOB_BATCH || 10);
  const pool = new Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
  });

  try {
    const processed = await otiResumeIndexService.processPendingIndexJobs(pool, { limit });
    console.log(
      JSON.stringify({
        success: true,
        processed_count: processed.length,
        processed
      })
    );
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error("OTI resume index job runner failed:", error.message);
  process.exitCode = 1;
});
