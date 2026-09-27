/**
 * LOCAL MASTER QA — execution orchestrator (harness).
 * Usage: node scripts/executeLocalMasterQa.js
 */
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const REPORT_PATH = path.join(ROOT, "local-master-qa-report.json");

const MODULE_PLAN = [
  {
    module: "Auth & session",
    coverage: "Wave1 access + login API spot",
    scripts: [{ id: "auth-login-negative", inline: "authLoginNegative" }]
  },
  {
    module: "Waves 1–4 core",
    coverage: "runWaves1to4Regression",
    scripts: [{ id: "waves1-4", file: "runWaves1to4Regression.js" }]
  },
  {
    module: "Offers (Wave 5)",
    coverage: "runWave5Regression",
    scripts: [{ id: "wave5", file: "runWave5Regression.js" }]
  },
  {
    module: "Candidate portal (Wave 6)",
    coverage: "Portal API cluster",
    scripts: [
      { id: "w6-review-queue", file: "verifyPortalReviewQueueAuthorization.js" },
      { id: "w6-open-reqs", file: "verifyPhase6b1CandidatePortalOpenRequisitions.js" },
      { id: "w6-apply", file: "verifyPhase6b2CandidatePortalApply.js" },
      { id: "w6-apps", file: "verifyPhase6b3CandidatePortalApplications.js" },
      { id: "w6-handoff", file: "verifyPhase6c7PortalApplicationHandoff.js" },
      { id: "w6-portal-auth", file: "verifyCandidatePortalAuth.js" }
    ]
  },
  {
    module: "TA Lead",
    coverage: "Gap — not in wave 1–5 bundle",
    scripts: [
      { id: "ta-lead-workspace", file: "verifyTaLeadWorkspace.js" },
      { id: "ta-lead-oversight", file: "verifyTaLeadTeamOversightV1.js" }
    ]
  },
  {
    module: "Hiring Control Tower",
    coverage: "Gap — HCT verifies",
    scripts: [
      { id: "hct-kpis", file: "verifyHctKpis.js" },
      { id: "hct-lifecycle", file: "verifyHctLifecycle.js" },
      { id: "hct-inspector", file: "verifyHctStageInspector.js" }
    ]
  },
  {
    module: "AI & Resume Match",
    coverage: "Gap — not in wave bundles",
    scripts: [
      { id: "ai-review", file: "verifyAiCandidateReviewV1.js" },
      { id: "resume-match", file: "verifyResumeMatchV1.js" }
    ]
  },
  {
    module: "Reports",
    coverage: "Standard reports + recruiter filter",
    scripts: [
      { id: "reports-standard", file: "verifyStandardReportsApi.js" },
      { id: "reports-recruiters", file: "verifyReportFilterOptionsRecruiters.js" }
    ]
  },
  {
    module: "Recruiter dashboard",
    coverage: "Gap",
    scripts: [{ id: "recruiter-dashboard", file: "verifyRecruiterDashboard.js" }]
  },
  {
    module: "Governance (Wave 7 sample)",
    coverage: "User provisioning boundaries",
    scripts: [{ id: "user-provisioning", file: "verifyUserProvisioning.js" }]
  }
];

const report = {
  capturedAt: new Date().toISOString(),
  target: { api: "http://localhost:5000", frontend: "http://localhost:5173" },
  modules: [],
  summary: { pass: 0, fail: 0, blocked: 0 }
};

function classifyFailure(scriptId, exitCode, stderrTail) {
  if (stderrTail.includes("ECONNREFUSED") || stderrTail.includes("fetch failed")) {
    return "NETWORK-RUNNER";
  }
  if (stderrTail.includes("Fixture") || stderrTail.includes("seed")) {
    return "FIXTURE";
  }
  return "PRODUCT";
}

async function authLoginNegative() {
  const base = process.env.API_BASE_URL || "http://localhost:5000";
  const cases = [
    { label: "missing password", body: { email_id: "demo.admin@optalynx.demo" }, expect: 400 },
    { label: "invalid user", body: { email_id: "no.user@example.com", password: "x" }, expect: 401 }
  ];
  const results = [];
  for (const c of cases) {
    const res = await fetch(`${base}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(c.body)
    });
    results.push({
      case: c.label,
      status: res.status,
      pass: res.status === c.expect
    });
  }
  const pass = results.every((r) => r.pass);
  return { pass, detail: results };
}

function runFile(file) {
  const result = spawnSync(process.execPath, [path.join("scripts", file)], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      API_BASE_URL: "http://localhost:5000",
      BACKEND_API_URL: "http://localhost:5000"
    },
    timeout: 600000
  });
  const stderrTail = (result.stderr || "").slice(-800);
  const stdoutTail = (result.stdout || "").slice(-1200);
  const pass = result.status === 0;
  return {
    pass,
    exitCode: result.status,
    stdoutTail,
    stderrTail,
    classification: pass ? null : classifyFailure(file, result.status, stderrTail + stdoutTail)
  };
}

async function main() {
  console.log("=== LOCAL MASTER QA execution ===\n");

  let health = 0;
  try {
    health = (await fetch("http://localhost:5000/health-test")).status;
  } catch (_) {
    health = 0;
  }
  if (health !== 200) {
    console.error("BLOCKED: backend not healthy on :5000");
    report.blocked = "backend health-test not 200";
    fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
    process.exit(2);
  }

  for (const mod of MODULE_PLAN) {
    const modEntry = {
      module: mod.module,
      coverage: mod.coverage,
      executions: []
    };

    for (const script of mod.scripts) {
      console.log(`\n>>> [${mod.module}] ${script.id}`);
      let result;
      if (script.inline === "authLoginNegative") {
        result = await authLoginNegative();
        result = {
          pass: result.pass,
          exitCode: result.pass ? 0 : 1,
          detail: result.detail,
          classification: result.pass ? null : "PRODUCT"
        };
      } else {
        result = runFile(script.file);
      }
      modEntry.executions.push({
        id: script.id,
        script: script.file || script.inline,
        ...result
      });
      if (result.pass) report.summary.pass += 1;
      else report.summary.fail += 1;
      console.log(result.pass ? "PASS" : `FAIL (${result.classification || "unknown"})`);
    }

    modEntry.modulePass = modEntry.executions.every((e) => e.pass);
    report.modules.push(modEntry);
  }

  report.overallPass = report.modules.every((m) => m.modulePass);
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(`\nWrote ${REPORT_PATH}`);
  console.log(
    `Summary: ${report.summary.pass} passed checks, ${report.summary.fail} failed; overall=${report.overallPass ? "PASS" : "NOT_PASS"}`
  );
  process.exit(report.overallPass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
