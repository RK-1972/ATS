/**
 * Wave 5 backend regression runner.
 * Usage: node scripts/runWave5Regression.js
 */
const { spawnSync } = require("child_process");
const path = require("path");

const SCRIPTS = [
  { id: "W5-core", file: "verifyWave5OffersExecution.js" },
  { id: "W5-workspace", file: "verifyOfferManagementWorkspaceV1.js" },
  { id: "W5-access", file: "verifyOfferApiAccessHardening.js" },
  { id: "W5-letter-access", file: "verifyOfferLetterAccessHardening.js" },
  { id: "W5-commercial", file: "verifyOfferCommercialFields.js" },
  { id: "W5-letter", file: "verifyOfferLetterV1.js" },
  { id: "W5-fulfillment", file: "verifyRequisitionFulfillmentClosure.js" }
];

function runScript(relativePath) {
  const scriptPath = path.join(__dirname, relativePath);
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: path.join(__dirname, ".."),
    stdio: "inherit",
    env: process.env
  });
  return result.status === 0;
}

function main() {
  console.log("=== OPTALYNX Wave 5 backend regression ===\n");

  let failed = 0;

  for (const entry of SCRIPTS) {
    console.log(`\n>>> ${entry.id}: ${entry.file}`);
    const ok = runScript(entry.file);
    if (!ok) {
      failed += 1;
      console.error(`FAILED: ${entry.file}`);
    } else {
      console.log(`PASSED: ${entry.file}`);
    }
  }

  console.log(`\n=== Summary: ${SCRIPTS.length - failed}/${SCRIPTS.length} passed ===`);
  if (failed) {
    process.exitCode = 1;
  }
}

main();
