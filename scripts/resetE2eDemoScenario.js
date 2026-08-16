/**
 * Safe reset of OPTALYNX E2E demo transactional data only.
 * Preserves demo users, approval routes, work assignments, and interviewer panel.
 *
 * Usage (from ats-backend):
 *   node scripts/resetE2eDemoScenario.js           # dry-run (preview counts)
 *   node scripts/resetE2eDemoScenario.js --execute # delete demo transactional data
 */
require("dotenv").config();

const {
  loadManifest,
  createPool,
  resetDemoTransactionalData
} = require("../demo/e2eDemoLib");

async function main() {
  const execute = process.argv.includes("--execute");
  const manifest = loadManifest();
  const pool = createPool();

  console.log("OPTALYNX E2E Demo — reset transactional data");
  console.log(`Mode: ${execute ? "EXECUTE" : "DRY-RUN"}`);
  console.log(`Marker: ${manifest.marker}`);

  try {
    const result = await resetDemoTransactionalData(pool, manifest, {
      dryRun: !execute
    });

    console.log("\nScope:");
    console.log(JSON.stringify(result.scope, null, 2));

    console.log("\nActions:");
    for (const action of result.actions) {
      console.log(`  - ${action.label}: ${action.count}`);
    }

    if (!execute) {
      console.log("\nNo data was deleted. Re-run with --execute to apply.");
    } else {
      console.log("\nDemo transactional reset complete.");
      console.log("Infrastructure (users/routes/panel) preserved.");
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error("E2E demo reset failed:", error.message);
  process.exit(1);
});
