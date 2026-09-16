/**
 * TA Lead Team Oversight V1 verification.
 * Run: node scripts/verifyTaLeadTeamOversightV1.js
 */
require("dotenv").config();

const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const { spawn, spawnSync } = require("child_process");
const path = require("path");
const candidateAccessService = require("../services/candidateAccessService");
const taLeadOperationsService = require("../services/taLeadOperationsService");
const standardReportService = require("../services/standardReportService");
const reportBuilderMetadataRepository = require("../repositories/reportBuilderMetadataRepository");

let API_BASE_URL = process.env.API_BASE_URL || "http://localhost:5000";
let verifyServer = null;

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

function pass(label) {
  console.log(`PASS: ${label}`);
}

function fail(label, detail) {
  console.error(`FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
  process.exitCode = 1;
}

function skip(label, detail) {
  console.log(`SKIP: ${label}${detail ? ` — ${detail}` : ""}`);
}

function signToken(user) {
  return jwt.sign(
    {
      user_id: user.user_id,
      employee_code: user.employee_code,
      email_id: user.email_id,
      role_name: user.role_name,
      secondary_role: user.secondary_role || null
    },
    process.env.JWT_SECRET,
    { expiresIn: "1h"
    }
  );
}

function buildReq(user) {
  return {
    user: {
      user_id: user.user_id,
      employee_code: user.employee_code,
      email_id: user.email_id,
      role_name: user.role_name,
      secondary_role: user.secondary_role || null
    }
  };
}

async function fetchJson(routePath, token, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE_URL}${routePath}`, {
    ...options,
    headers
  });

  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

async function resolveUserByRole(roleName) {
  const result = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name, secondary_role
     FROM user_mstr
     WHERE role_name = $1
       AND COALESCE(is_active, TRUE) = TRUE
     ORDER BY user_id ASC
     LIMIT 1`,
    [roleName]
  );
  return result.rows[0] || null;
}

async function resolveTaLeadOperator() {
  const byRole = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name, secondary_role
     FROM user_mstr
     WHERE role_name IN ('TA Lead', 'TA Leader')
       AND COALESCE(is_active, TRUE) = TRUE
     ORDER BY user_id ASC
     LIMIT 1`
  );

  if (byRole.rows[0]) {
    return byRole.rows[0];
  }

  const byAssigner = await pool.query(
    `SELECT u.user_id, u.employee_code, u.email_id, u.role_name, u.secondary_role
     FROM user_mstr u
     INNER JOIN employee_work_assignment ewa
       ON ewa.employee_code = u.employee_code AND ewa.is_active = TRUE
     INNER JOIN work_assignment_mstr wam
       ON wam.work_assignment_id = ewa.work_assignment_id
      AND wam.assignment_code = 'REQUISITION_ASSIGNER'
      AND COALESCE(wam.is_active, TRUE) = TRUE
     WHERE COALESCE(u.is_active, TRUE) = TRUE
     ORDER BY u.user_id ASC
     LIMIT 1`
  );

  return byAssigner.rows[0] || null;
}

async function resolveUnauthorizedRecruiter() {
  const result = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name, secondary_role
     FROM user_mstr u
     WHERE u.role_name = 'Recruiter'
       AND COALESCE(u.is_active, TRUE) = TRUE
       AND NOT EXISTS (
         SELECT 1
         FROM employee_work_assignment ewa
         INNER JOIN work_assignment_mstr wam
           ON wam.work_assignment_id = ewa.work_assignment_id
         WHERE ewa.employee_code = u.employee_code
           AND ewa.is_active = TRUE
           AND wam.assignment_code = 'REQUISITION_ASSIGNER'
           AND COALESCE(wam.is_active, TRUE) = TRUE
       )
     ORDER BY u.user_id ASC
     LIMIT 1`
  );
  return result.rows[0] || null;
}

async function resolveAssignedRecruiterCode() {
  const result = await pool.query(
    `SELECT a.recruiter_code
     FROM rm_recruiter_assignments a
     WHERE a.is_active = TRUE
     GROUP BY a.recruiter_code
     ORDER BY COUNT(*) DESC
     LIMIT 1`
  );
  return result.rows[0]?.recruiter_code || null;
}

async function resolveForeignPipelineCandidate() {
  const result = await pool.query(
    `SELECT candidate_id
     FROM cand_mstr
     WHERE UPPER(COALESCE(candidate_container, 'PIPELINE')) = 'PIPELINE'
       AND COALESCE(owner_employee_code, '') <> ''
     ORDER BY candidate_id DESC
     LIMIT 1`
  );
  return result.rows[0]?.candidate_id || null;
}

async function startVerifyBackend() {
  const verifyPort = process.env.VERIFY_HTTP_PORT || "5099";
  API_BASE_URL = `http://localhost:${verifyPort}`;

  verifyServer = spawn("node", ["index.js"], {
    cwd: path.join(__dirname, ".."),
    env: {
      ...process.env,
      PORT: verifyPort
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  const started = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("verify backend startup timeout"));
    }, 20000);

    const onData = (chunk) => {
      const text = String(chunk);
      if (text.includes(`localhost:${verifyPort}`) || text.includes("ATS Backend Running")) {
        clearTimeout(timeout);
        verifyServer.stdout.off("data", onData);
        resolve(true);
      }
    };

    verifyServer.stdout.on("data", onData);
    verifyServer.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    verifyServer.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        clearTimeout(timeout);
        reject(new Error(`verify backend exited (${code})`));
      }
    });
  });

  return started;
}

async function stopVerifyBackend() {
  if (!verifyServer) {
    return;
  }

  verifyServer.kill("SIGTERM");
  verifyServer = null;
}

async function runRegression(scriptName) {
  const scriptPath = path.join(__dirname, scriptName);
  const result = spawnSync("node", [scriptPath], {
    cwd: path.join(__dirname, ".."),
    encoding: "utf8",
    env: process.env
  });
  const ok = result.status === 0;
  const detail = ok
    ? "ok"
    : (result.stderr || result.stdout || "failed").split("\n").slice(-3).join(" ");
  return { ok, detail };
}

async function resolveCandidatePipelineDatasetId() {
  const result = await pool.query(
    `SELECT dataset_id FROM rb_dataset WHERE code = 'CANDIDATE_PIPELINE' LIMIT 1`
  );
  return result.rows[0]?.dataset_id || null;
}

async function main() {
  console.log("=== TA Lead Team Oversight V1 Verification ===\n");

  const taLead = await resolveTaLeadOperator();
  const taLeader = await resolveUserByRole("TA Leader");
  const recruiter = await resolveUnauthorizedRecruiter();
  const hiringManager = await resolveUserByRole("Hiring Manager");
  const assignedRecruiterCode = await resolveAssignedRecruiterCode();
  const foreignCandidateId = await resolveForeignPipelineCandidate();

  if (!taLead) {
    fail("fixtures", "TA Lead/Leader or REQUISITION_ASSIGNER user required");
    await pool.end();
    return;
  }

  console.log("--- Service layer ---");

  try {
    const queues = await taLeadOperationsService.getAttentionQueues(pool, buildReq(taLead));
    if (Array.isArray(queues.without_recruiter) && Array.isArray(queues.closure_eligible)) {
      pass(`service: attention queues (unassigned=${queues.without_recruiter.length}, closure=${queues.closure_eligible.length})`);
    } else {
      fail("service: attention queues shape");
    }
  } catch (error) {
    fail("service: attention queues", error.message);
  }

  if (assignedRecruiterCode) {
    try {
      const summary = await taLeadOperationsService.getRecruiterOversightSummary(
        pool,
        buildReq(taLead),
        assignedRecruiterCode
      );
      const serialized = JSON.stringify(summary);
      const hasCandidatePii = /candidate_name|candidate_id|email_id|mobile_number/i.test(serialized);
      if (
        summary.recruiter?.recruiter_code === assignedRecruiterCode
        && typeof summary.active_candidates === "number"
        && summary.pipeline_stages
        && !hasCandidatePii
      ) {
        pass("service: recruiter oversight summary without candidate PII");
      } else {
        fail("service: recruiter oversight summary", hasCandidatePii ? "candidate PII leaked" : "shape");
      }
    } catch (error) {
      fail("service: recruiter oversight summary", error.message);
    }
  } else {
    skip("service: recruiter oversight summary", "no assigned recruiter fixture");
  }

  if (taLeader && taLeader.employee_code !== taLead.employee_code) {
    try {
      await taLeadOperationsService.getAttentionQueues(pool, buildReq(taLeader));
      pass("service: TA Leader attention queues");
    } catch (error) {
      fail("service: TA Leader attention queues", error.message);
    }
  }

  if (recruiter) {
    try {
      await taLeadOperationsService.getAttentionQueues(pool, buildReq(recruiter));
      fail("service: recruiter attention queues", "expected throw");
    } catch (error) {
      if (error.status === 403) {
        pass("service: recruiter denied attention queues");
      } else {
        fail("service: recruiter attention queues", error.message);
      }
    }
  }

  const candidatePipelineDatasetId = await resolveCandidatePipelineDatasetId();
  const canViewDataset = candidatePipelineDatasetId
    ? await reportBuilderMetadataRepository.hasDatasetViewPermission(
      pool,
      "TA Lead",
      candidatePipelineDatasetId
    )
    : false;

  if (canViewDataset) {
    pass("permission: TA Lead can view CANDIDATE_PIPELINE dataset");
  } else {
    fail(
      "permission: TA Lead CANDIDATE_PIPELINE",
      "run migrations/058_ta_lead_recruiter_workload_report_permission.sql"
    );
  }

  try {
    const reports = await standardReportService.listAuthorizedStandardReports(
      pool,
      buildReq(taLead)
    );
    const hasWorkload = (reports.reports || []).some(
      (row) => row.report_code === "RECRUITER_WORKLOAD"
    );
    if (hasWorkload) {
      pass("permission: TA Lead authorized for RECRUITER_WORKLOAD report");
    } else {
      fail("permission: RECRUITER_WORKLOAD report missing for TA Lead");
    }
  } catch (error) {
    fail("permission: standard reports", error.message);
  }

  if (taLead && foreignCandidateId) {
    try {
      await candidateAccessService.assertCandidateReadAccess(
        pool,
        buildReq(taLead),
        foreignCandidateId
      );
      fail("candidate boundary", "expected 403 for foreign owned pipeline candidate");
    } catch (error) {
      if (error.status === 403) {
        pass("candidate boundary: TA Lead denied foreign owned pipeline candidate");
      } else {
        fail("candidate boundary", error.message);
      }
    }
  }

  console.log("\n--- HTTP API ---");

  let httpReady = false;
  const probe = await fetchJson("/api/v1/ta-lead/attention-queues", signToken(taLead));

  if (probe.status === 404 || probe.status === 500) {
    try {
      await startVerifyBackend();
      httpReady = true;
      pass(`HTTP: spawned verify backend on ${API_BASE_URL}`);
    } catch (error) {
      skip("HTTP suite", `could not start verify backend — ${error.message}`);
    }
  } else {
    httpReady = true;
  }

  if (httpReady) {
    const taLeadToken = signToken(taLead);
    const queuesHttp = await fetchJson("/api/v1/ta-lead/attention-queues", taLeadToken);
    if (queuesHttp.status === 200 && queuesHttp.body?.success) {
      pass("HTTP: TA Lead attention queues (200)");
    } else {
      fail("HTTP: TA Lead attention queues", String(queuesHttp.status));
    }

    if (assignedRecruiterCode) {
      const recruiterHttp = await fetchJson(
        `/api/v1/ta-lead/recruiters/${encodeURIComponent(assignedRecruiterCode)}/summary`,
        taLeadToken
      );
      if (recruiterHttp.status === 200 && recruiterHttp.body?.success) {
        const payload = JSON.stringify(recruiterHttp.body.data || {});
        if (/candidate_name|candidate_id|email_id/i.test(payload)) {
          fail("HTTP: recruiter summary candidate boundary", "candidate PII in response");
        } else {
          pass("HTTP: recruiter oversight summary (200, no candidate PII)");
        }
      } else {
        fail("HTTP: recruiter oversight summary", String(recruiterHttp.status));
      }
    }

    if (taLeader && taLeader.employee_code !== taLead.employee_code) {
      const leaderQueues = await fetchJson(
        "/api/v1/ta-lead/attention-queues",
        signToken(taLeader)
      );
      if (leaderQueues.status === 200) {
        pass("HTTP: TA Leader attention queues (200)");
      } else {
        fail("HTTP: TA Leader attention queues", String(leaderQueues.status));
      }
    }

    if (recruiter) {
      const deniedQueues = await fetchJson(
        "/api/v1/ta-lead/attention-queues",
        signToken(recruiter)
      );
      if (deniedQueues.status === 403) {
        pass("HTTP: unauthorized recruiter denied attention queues (403)");
      } else {
        fail("HTTP: unauthorized recruiter attention queues", String(deniedQueues.status));
      }

      if (assignedRecruiterCode) {
        const deniedSummary = await fetchJson(
          `/api/v1/ta-lead/recruiters/${encodeURIComponent(assignedRecruiterCode)}/summary`,
          signToken(recruiter)
        );
        if (deniedSummary.status === 403) {
          pass("HTTP: unauthorized recruiter denied recruiter summary (403)");
        } else {
          fail("HTTP: unauthorized recruiter summary", String(deniedSummary.status));
        }
      }
    }

    if (hiringManager) {
      const deniedHm = await fetchJson(
        "/api/v1/ta-lead/attention-queues",
        signToken(hiringManager)
      );
      if (deniedHm.status === 403) {
        pass("HTTP: Hiring Manager denied attention queues (403)");
      } else {
        fail("HTTP: Hiring Manager attention queues", String(deniedHm.status));
      }
    }

    const reportsHttp = await fetchJson(
      "/api/v1/reports/standard-reports",
      taLeadToken
    );
    if (reportsHttp.status === 200) {
      const codes = (reportsHttp.body?.data?.reports || []).map((row) => row.report_code);
      if (codes.includes("RECRUITER_WORKLOAD")) {
        pass("HTTP: TA Lead standard reports include RECRUITER_WORKLOAD");
      } else {
        fail("HTTP: RECRUITER_WORKLOAD missing from standard reports");
      }
    } else {
      fail("HTTP: standard reports", String(reportsHttp.status));
    }

    const hct = await fetchJson("/api/v1/hiring-control-tower/kpis", taLeadToken);
    if (hct.status === 403) {
      pass("HTTP: TA Lead still blocked from HCT (403)");
    } else {
      fail("HTTP: HCT access", String(hct.status));
    }
  }

  console.log("\n--- Regression ---");
  const regression = await runRegression("verifyTaLeadWorkspace.js");
  if (regression.ok) {
    pass("Regression verifyTaLeadWorkspace.js");
  } else {
    fail("Regression verifyTaLeadWorkspace.js", regression.detail);
  }

  console.log("\nTeam Oversight V1 verification finished.");
  await stopVerifyBackend();
  await pool.end();
}

main().catch(async (error) => {
  fail("unexpected error", error.message);
  await stopVerifyBackend();
  await pool.end();
});
