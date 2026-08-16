/**
 * Idempotent setup for OPTALYNX E2E demo infrastructure.
 * Creates isolated demo users, work assignments, approval routes, and interviewer panel.
 * Does NOT create budget/requisition/candidate transactional data — those are created via real UI.
 *
 * Usage (from ats-backend):
 *   node scripts/setupE2eDemoScenario.js
 */
require("dotenv").config();

const {
  loadManifest,
  createPool,
  resolveDemoPassword,
  indexUsers,
  ensureDemoUser,
  ensureEmployeeWorkAssignment,
  ensureDemoApprovalRoute,
  ensureDemoInterviewerPanel,
  suspendSystemOfferRoutePoliciesForDemo,
  ensureDemoOfferApprovalRoutePolicy
} = require("../demo/e2eDemoLib");

async function main() {
  const manifest = loadManifest();
  const pool = createPool();
  const password = resolveDemoPassword(manifest);
  const { byKey } = indexUsers(manifest);

  console.log("OPTALYNX E2E Demo — setup infrastructure");
  console.log(`Namespace: ${manifest.namespace} | Marker: ${manifest.marker}`);

  const summary = {
    users: [],
    workAssignments: [],
    approvalRoutes: [],
    interviewPanel: null
  };

  try {
    for (const account of manifest.users.accounts) {
      const result = await ensureDemoUser(pool, account, password);
      summary.users.push({
        employeeCode: account.employeeCode,
        created: result.created
      });

      for (const assignmentCode of account.workAssignments || []) {
        const assignmentResult = await ensureEmployeeWorkAssignment(
          pool,
          account.employeeCode,
          assignmentCode
        );
        summary.workAssignments.push({
          employeeCode: account.employeeCode,
          assignmentCode,
          created: assignmentResult.created
        });
      }
    }

    for (const routeConfig of manifest.approvalRoutes) {
      const routeResult = await ensureDemoApprovalRoute(pool, routeConfig, byKey);
      summary.approvalRoutes.push(routeResult);
    }

    summary.suspendedSystemOfferRoutePolicies =
      await suspendSystemOfferRoutePoliciesForDemo(pool, manifest);
    summary.demoOfferApprovalPolicy = await ensureDemoOfferApprovalRoutePolicy(
      pool,
      manifest,
      byKey
    );

    summary.interviewPanel = await ensureDemoInterviewerPanel(pool, manifest, byKey);

    console.log("\nSetup complete.");
    console.log(JSON.stringify(summary, null, 2));
    console.log("\nNext steps:");
    console.log("  1. node scripts/verifyE2eDemoReadiness.js");
    console.log("  2. Run demo via real UI (see demo/README.md)");
    console.log(`  3. Password: env ${manifest.users.passwordEnvVar} or manifest default`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error("E2E demo setup failed:", error.message);
  process.exit(1);
});
