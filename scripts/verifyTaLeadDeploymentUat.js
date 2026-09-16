/**
 * Deployment/UAT verification against live backend on port 5000.
 * Run: node scripts/verifyTaLeadDeploymentUat.js
 */
require("dotenv").config();

const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const candidateAccessService = require("../services/candidateAccessService");

const API_BASE_URL = "http://localhost:5000";

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
    { expiresIn: "1h" }
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

async function fetchJson(routePath, token) {
  const response = await fetch(`${API_BASE_URL}${routePath}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {}
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

async function resolveTaLeadOperator() {
  const byRole = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name, secondary_role
     FROM user_mstr
     WHERE role_name IN ('TA Lead', 'TA Leader')
       AND COALESCE(is_active, TRUE) = TRUE
     ORDER BY user_id ASC LIMIT 1`
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
     ORDER BY u.user_id ASC LIMIT 1`
  );
  return byAssigner.rows[0] || null;
}

async function resolveUserByRole(roleName) {
  const result = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name, secondary_role
     FROM user_mstr WHERE role_name = $1 AND COALESCE(is_active, TRUE) = TRUE
     ORDER BY user_id ASC LIMIT 1`,
    [roleName]
  );
  return result.rows[0] || null;
}

async function resolveUnauthorizedRecruiter() {
  const result = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name, secondary_role
     FROM user_mstr u
     WHERE u.role_name = 'Recruiter'
       AND COALESCE(u.is_active, TRUE) = TRUE
       AND NOT EXISTS (
         SELECT 1 FROM employee_work_assignment ewa
         INNER JOIN work_assignment_mstr wam ON wam.work_assignment_id = ewa.work_assignment_id
         WHERE ewa.employee_code = u.employee_code AND ewa.is_active = TRUE
           AND wam.assignment_code = 'REQUISITION_ASSIGNER'
           AND COALESCE(wam.is_active, TRUE) = TRUE
       )
     ORDER BY u.user_id ASC LIMIT 1`
  );
  return result.rows[0] || null;
}

async function resolveAssignedRecruiterCode() {
  const result = await pool.query(
    `SELECT recruiter_code FROM rm_recruiter_assignments
     WHERE is_active = TRUE GROUP BY recruiter_code
     ORDER BY COUNT(*) DESC LIMIT 1`
  );
  return result.rows[0]?.recruiter_code || null;
}

async function resolveForeignPipelineCandidate() {
  const result = await pool.query(
    `SELECT candidate_id FROM cand_mstr
     WHERE UPPER(COALESCE(candidate_container, 'PIPELINE')) = 'PIPELINE'
       AND COALESCE(owner_employee_code, '') <> ''
     ORDER BY candidate_id DESC LIMIT 1`
  );
  return result.rows[0]?.candidate_id || null;
}

async function main() {
  console.log("=== TA Lead Deployment UAT (port 5000) ===\n");

  const health = await fetchJson("/api/v1/ta-lead/operations-summary", null);
  if (health.status === 401 || health.status === 403) {
    pass(`live backend reachable on ${API_BASE_URL} (auth enforced)`);
  } else if (health.status === 404) {
    fail("live backend routes", "TA Lead routes not loaded — restart required");
    await pool.end();
    return;
  } else {
    pass(`live backend reachable on ${API_BASE_URL}`);
  }

  const operator = await resolveTaLeadOperator();
  const recruiter = await resolveUnauthorizedRecruiter();
  const hm = await resolveUserByRole("Hiring Manager");
  const recruiterCode = await resolveAssignedRecruiterCode();
  const foreignCandidateId = await resolveForeignPipelineCandidate();

  if (!operator) {
    fail("fixtures", "TA Lead operator required");
    await pool.end();
    return;
  }

  const token = signToken(operator);

  const summary = await fetchJson("/api/v1/ta-lead/operations-summary", token);
  if (summary.status === 200 && summary.body?.success) {
    pass("/ta-lead data: operations-summary (200)");
    if (Array.isArray(summary.body.data?.recruiter_workload)) {
      pass("/ta-lead data: recruiter workload present");
    } else {
      fail("/ta-lead data: recruiter workload missing");
    }
  } else {
    fail("/ta-lead data: operations-summary", String(summary.status));
  }

  const queues = await fetchJson("/api/v1/ta-lead/attention-queues", token);
  if (queues.status === 200 && queues.body?.success) {
    pass("attention queues load (200)");
    const unassigned = queues.body.data?.without_recruiter || [];
    if (unassigned.length > 0) {
      pass(`attention queue: unassigned requisitions (${unassigned.length})`);
    } else {
      pass("attention queue: unassigned list empty (valid)");
    }
  } else {
    fail("attention queues", String(queues.status));
  }

  if (recruiterCode) {
    const drilldown = await fetchJson(
      `/api/v1/ta-lead/recruiters/${encodeURIComponent(recruiterCode)}/summary`,
      token
    );
    if (drilldown.status === 200 && drilldown.body?.success) {
      const payload = JSON.stringify(drilldown.body.data || {});
      if (/candidate_name|candidate_id|email_id/i.test(payload)) {
        fail("recruiter drill-down", "candidate PII in response");
      } else {
        pass("recruiter workload drill-down (200, no candidate PII)");
      }
    } else {
      fail("recruiter drill-down", String(drilldown.status));
    }
  }

  const mgmt = await fetchJson("/api/v1/recruitment/requisitions", token);
  if (mgmt.status === 200) {
    pass("assignment deep-link auth: management requisitions (200)");
  } else {
    fail("assignment deep-link auth", String(mgmt.status));
  }

  const reports = await fetchJson("/api/v1/reports/standard-reports", token);
  if (reports.status === 200) {
    const codes = (reports.body?.data?.reports || []).map((r) => r.report_code);
    if (codes.includes("RECRUITER_WORKLOAD")) {
      pass("RECRUITER_WORKLOAD report authorized for TA operator");
      const reportDef = await fetchJson(
        "/api/v1/reports/standard-reports/RECRUITER_WORKLOAD",
        token
      );
      if (reportDef.status === 200) {
        pass("RECRUITER_WORKLOAD report definition (200)");
      } else {
        fail("RECRUITER_WORKLOAD definition", String(reportDef.status));
      }
    } else {
      fail("RECRUITER_WORKLOAD report", "not in authorized list");
    }
  } else {
    fail("standard reports", String(reports.status));
  }

  if (recruiter) {
    const denied = await fetchJson("/api/v1/ta-lead/operations-summary", signToken(recruiter));
    if (denied.status === 403) {
      pass("unauthorized Recruiter denied (403)");
    } else {
      fail("unauthorized Recruiter", String(denied.status));
    }
  }

  if (hm) {
    const deniedHm = await fetchJson("/api/v1/ta-lead/attention-queues", signToken(hm));
    if (deniedHm.status === 403) {
      pass("unauthorized Hiring Manager denied (403)");
    } else {
      fail("unauthorized Hiring Manager", String(deniedHm.status));
    }
  }

  const hct = await fetchJson("/api/v1/hiring-control-tower/kpis", token);
  if (hct.status === 403) {
    pass("HCT remains Admin-only for TA operator (403)");
  } else {
    fail("HCT access", String(hct.status));
  }

  if (foreignCandidateId) {
    try {
      await candidateAccessService.assertCandidateReadAccess(
        pool,
        buildReq(operator),
        foreignCandidateId
      );
      fail("candidate-access boundary", "expected 403");
    } catch (error) {
      if (error.status === 403) {
        pass("candidate-access boundary unchanged (403)");
      } else {
        fail("candidate-access boundary", error.message);
      }
    }
  }

  console.log("\nDeployment UAT finished.");
  await pool.end();
}

main().catch(async (error) => {
  fail("unexpected", error.message);
  await pool.end();
});
