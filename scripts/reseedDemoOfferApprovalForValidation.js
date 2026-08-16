/**
 * Demo-only: re-point an existing demo offer's approval workflow to the
 * isolated [DEMO_E2E] Offer Approval route and demo approvers.
 *
 * Usage (from ats-backend):
 *   node scripts/reseedDemoOfferApprovalForValidation.js
 */
require("dotenv").config();

const {
  loadManifest,
  createPool,
  reseedDemoOfferApprovalWorkflow
} = require("../demo/e2eDemoLib");

async function main() {
  const manifest = loadManifest();
  const pool = createPool();

  console.log("OPTALYNX E2E Demo — reseed offer approval workflow");
  console.log(`Route: ${manifest.offerApproval?.routeName || "[DEMO_E2E] Offer Approval"}`);

  try {
    const result = await reseedDemoOfferApprovalWorkflow(pool, manifest);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error("Offer approval reseed failed:", error.message);
  process.exit(1);
});
