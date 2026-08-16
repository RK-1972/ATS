/**
 * Verify OPTALYNX E2E demo infrastructure readiness.
 *
 * Usage (from ats-backend):
 *   node scripts/verifyE2eDemoReadiness.js
 */
require("dotenv").config();

const {
  loadManifest,
  createPool,
  verifyDemoInfrastructure,
  collectDemoScope,
  futureInterviewDate
} = require("../demo/e2eDemoLib");

async function main() {
  const manifest = loadManifest();
  const pool = createPool();

  console.log("OPTALYNX E2E Demo — readiness verification");
  console.log(`Scenario: ${manifest.scenario.title}`);

  try {
    const result = await verifyDemoInfrastructure(pool, manifest);
    const scope = await collectDemoScope(pool, manifest);

    console.log("\nInfrastructure checks:");
    for (const check of result.checks) {
      const prefix = check.ok ? "PASS" : "FAIL";
      const detail = check.detail ? ` (${check.detail})` : "";
      console.log(`  [${prefix}] ${check.label}${detail}`);
    }

    if (result.warnings.length > 0) {
      console.log("\nWarnings:");
      for (const warning of result.warnings) {
        const detail = warning.detail ? ` — ${warning.detail}` : "";
        console.log(`  [WARN] ${warning.label}${detail}`);
      }
    }

    console.log("\nExisting demo transactional footprint (informational):");
    console.log(JSON.stringify(scope, null, 2));

    console.log("\nSuggested interview date for recording:");
    console.log(
      `  ${futureInterviewDate(manifest.interview.scheduleDaysAhead)} ${manifest.interview.scheduleTime}`
    );

    if (!result.ok) {
      console.error(`\nReadiness verification failed (${result.failedCount} issue(s)).`);
      console.error("Run: node scripts/setupE2eDemoScenario.js");
      process.exit(1);
    }

    console.log("\nReadiness verification passed.");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error("E2E demo readiness verification failed:", error.message);
  process.exit(1);
});
