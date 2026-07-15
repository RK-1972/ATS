require("dotenv").config();

const { Pool } = require("pg");
const recruitmentService = require("../services/recruitmentService");

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

const RECRUITER = "IGS0506";

async function countEnterprise() {
  const r = await pool.query(
    `SELECT assignment_id, requisition_code, req_id, is_active
     FROM rm_recruiter_assignments
     WHERE recruiter_code = $1
     ORDER BY assignment_id`,
    [RECRUITER]
  );
  const active = r.rows.filter((row) => row.is_active);
  return { rows: r.rows, activeCount: active.length };
}

async function countLegacy() {
  const r = await pool.query(
    `SELECT map_id, req_id, recruiter_code, is_active
     FROM req_recruiter_map
     WHERE recruiter_code = $1
     ORDER BY map_id`,
    [RECRUITER]
  );
  const active = r.rows.filter((row) => row.is_active);
  return { rows: r.rows, activeCount: active.length };
}

async function dashboardCount(req) {
  const bundle = await recruitmentService.getMyRecruiterDashboard(pool, req);
  return {
    requisitions: bundle.requisitions.length,
    assignments: bundle.recruiterAssignments.length,
    pipeline: bundle.pipeline.length,
    requisitionCodes: bundle.requisitions.map((r) => r.requisition_code)
  };
}

function simulateSelector(recruitment) {
  const requisitions = recruitment?.requisitions || [];
  const pipeline = recruitment?.pipeline || [];
  return {
    myRequisitionsKpi: requisitions.length,
    myCandidatesKpi: pipeline.length,
    requisitionCodes: requisitions.map((r) => r.requisition_code)
  };
}

async function main() {
  const req = { user: { employee_code: RECRUITER, role_name: "Recruiter" } };

  console.log("=".repeat(60));
  console.log("STEP 1 — DELETE /remove-recruiter/:mapId (code analysis)");
  console.log("=".repeat(60));
  console.log({
    endpoint: "DELETE /remove-recruiter/:mapId",
    payload: "mapId in URL path only (legacy req_recruiter_map.map_id)",
    jwtEmployee: "req.user from JWT (not used in DELETE handler body)",
    sqlExecuted: "UPDATE req_recruiter_map SET is_active = false WHERE map_id = $1",
    enterpriseTableUpdated: false,
    response: "{ success: true, message: 'Recruiter Removed Successfully', data: legacy row }",
    frontendAfterDelete: "RequisitionPage.fetchAssignedRecruiters() only — NOT refreshRecruitment()"
  });

  console.log("\n" + "=".repeat(60));
  console.log("STEP 2 — Database state (current)");
  console.log("=".repeat(60));

  const enterprise = await countEnterprise();
  const legacy = await countLegacy();

  console.log("\nrm_recruiter_assignments (Enterprise SoR — my-dashboard reads this):");
  console.log(JSON.stringify(enterprise.rows, null, 2));
  console.log("Active count:", enterprise.activeCount);

  console.log("\nreq_recruiter_map (Legacy — DELETE updates this):");
  console.log(JSON.stringify(legacy.rows, null, 2));
  console.log("Active count:", legacy.activeCount);

  const drift = legacy.rows.filter((l) => {
    const ent = enterprise.rows.find(
      (e) => e.req_id === l.req_id && e.requisition_code
    );
    return l.is_active !== (ent?.is_active ?? l.is_active);
  });
  if (drift.length) {
    console.log("\n⚠ Legacy vs Enterprise is_active DRIFT detected:");
    console.log(JSON.stringify(drift, null, 2));
  }

  console.log("\n" + "=".repeat(60));
  console.log("STEP 2b — Simulate DELETE on first active legacy map_id");
  console.log("(read-only simulation — no DB write)");
  console.log("=".repeat(60));

  const targetLegacy = legacy.rows.find((r) => r.is_active);
  if (targetLegacy) {
    console.log("Would DELETE map_id:", targetLegacy.map_id, "req_id:", targetLegacy.req_id);
    console.log("Legacy active after simulated delete:", legacy.activeCount - 1);
    console.log("Enterprise active after simulated delete (unchanged):", enterprise.activeCount);
  }

  console.log("\n" + "=".repeat(60));
  console.log("STEP 3 — my-dashboard / repository (current)");
  console.log("=".repeat(60));

  const dash = await dashboardCount(req);
  console.log({
    endpoint: "GET /api/v1/recruitment/my-dashboard",
    refreshRecruitmentCallsThis: "recruitmentRepository.getRecruiterWorkspaceBundle()",
    rowsReturned: dash
  });

  console.log("\n" + "=".repeat(60));
  console.log("STEP 4 — Enterprise Store (logical state)");
  console.log("=".repeat(60));
  console.log({
    beforeDelete_refreshOnMount: {
      "recruitment.recruiterAssignments.length": dash.assignments,
      "recruitment.requisitions.length": dash.requisitions
    },
    afterDelete_withoutRefresh: {
      note: "RequisitionPage does NOT call refreshRecruitment() or enterprise store update",
      storeUnchanged: true,
      "recruitment.recruiterAssignments.length": dash.assignments
    },
    afterDelete_withManualRefresh: {
      note: "Even if user clicks Refresh on Recruiter Workspace, my-dashboard re-queries enterprise table",
      "recruitment.recruiterAssignments.length": dash.assignments,
      reason: "rm_recruiter_assignments still has 4 active rows"
    }
  });

  console.log("\n" + "=".repeat(60));
  console.log("STEP 5 — Recruiter Selectors (post-fix architecture)");
  console.log("=".repeat(60));

  const bundle = await recruitmentService.getMyRecruiterDashboard(pool, req);
  const selectorBefore = simulateSelector({
    requisitions: bundle.requisitions,
    pipeline: bundle.pipeline
  });
  console.log("BEFORE delete (current live data):");
  console.log(selectorBefore);
  console.log("\nAFTER legacy DELETE + refresh (simulated — enterprise unchanged):");
  console.log(selectorBefore);
  console.log("Note: myAssignmentCodes filtering removed; KPI = requisitions.length directly");

  console.log("\n" + "=".repeat(60));
  console.log("STEP 6 — KPI 'My Requisitions' calculation");
  console.log("=".repeat(60));
  console.log(`
File: ats-frontend/src/enterprise/recruiterSelectors.js

  const requisitions = recruitment?.requisitions || [];   // from store, loaded via my-dashboard
  ...
  executiveMetrics[requisitions KPI]:
    value: requisitions.length

No assignment-level filter in selector (backend pre-filters).
Raw assignments in store: ${dash.assignments}
Filtered assignments in selector: N/A (not used for KPI)
Final KPI: ${dash.requisitions}
  `);

  console.log("=".repeat(60));
  console.log("STEP 7 — React rendering");
  console.log("=".repeat(60));
  console.log({
    RecruiterWorkspacePage: "useEffect(() => refreshRecruitment(), [refreshRecruitment]) on mount only",
    RequisitionPage_deleteHandler: "Does not dispatch to Recruiter Workspace store",
    wouldReRender: "Only if recruitment store reference changes — it does NOT after DELETE from RequisitionPage",
    manualRefreshButton: "Calls refreshRecruitment() but API still returns stale enterprise count if DB unchanged"
  });

  console.log("\n" + "=".repeat(60));
  console.log("STEP 8 — ROOT CAUSE");
  console.log("=".repeat(60));
  console.log(`
☑ database not updated (Enterprise SoR)
  DELETE /remove-recruiter/:mapId writes ONLY req_recruiter_map.is_active = false
  rm_recruiter_assignments is NEVER updated

☐ API cache — no cache layer; my-dashboard queries DB live

☐ repository cache — getRecruiterWorkspaceBundle() always HTTP GET; no cache

☐ Zustand state — stale because (a) no refresh triggered from delete UI, AND
  (b) even refresh would read unchanged enterprise rows

☐ selector memoization — selector would recalc if store changed; store does not change

☐ React rendering — would update if store changed; it does not

☐ stale query — my-dashboard SQL correct but reads enterprise table left at 4 active

☐ backend transaction — DELETE succeeds on legacy only; not a transaction rollback issue

EXACT LAYER WHERE COUNT REMAINS 4:
  Primary: Database — rm_recruiter_assignments.is_active still true (Enterprise SoR not updated)
  Secondary: No store refresh wired from RequisitionPage DELETE handler
  `);

  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  await pool.end();
  process.exit(1);
});
