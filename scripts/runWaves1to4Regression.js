/**
 * Cross-wave backend regression (Waves 1–4 verification scripts).
 * Usage: node scripts/runWaves1to4Regression.js
 */
const { spawnSync } = require("child_process");
const path = require("path");

const SCRIPTS = [
  { wave: 1, file: "verifyCandidateAccessHardening.js" },
  { wave: 1, file: "verifyRecruitmentAccessHardening.js" },
  { wave: 1, file: "verifyWorkflowClarificationAccessHardening.js" },
  { wave: 2, file: "verifyTalentDemandDraftLifecycle.js" },
  { wave: 2, file: "verifyCandidatePortalPublication.js" },
  { wave: 2, file: "verifyRequisitionFulfillmentClosure.js" },
  { wave: 2, file: "verifyPhase1bRequisitionSorConsolidation.js" },
  { wave: 3, file: "verifyCandidatePoolSegregation.js" },
  { wave: 3, file: "verifyPhase7dMyPipelineRead.js" },
  { wave: 3, file: "verifyClassicCandidateRetirement.js" },
  { wave: 3, file: "verifyPhase7bCandidateProfileRead.js" },
  { wave: 4, file: "verifyInterviewManagementSecurityFixes.js" },
  { wave: 4, file: "verifyInterviewFeedbackAccessHardening.js" },
  { wave: 4, file: "verifyPhase3cMyInterviewsSorConsolidation.js" }
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
  console.log("=== OPTALYNX Waves 1–4 backend regression ===\n");

  let failed = 0;

  for (const entry of SCRIPTS) {
    console.log(`\n>>> Wave ${entry.wave}: ${entry.file}`);
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
