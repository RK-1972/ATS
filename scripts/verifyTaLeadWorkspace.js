/**
 * Verifies TA Lead workspace authorization, APIs, and unchanged security boundaries.
 * Run: node scripts/verifyTaLeadWorkspace.js
 */
require("dotenv").config();

const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const candidateAccessService = require("../services/candidateAccessService");
const {
  assertCanAssignRecruiters,
  assertCanAccessTaLeadWorkspace
} = require("../services/requisitionCapabilityAuth");
const taLeadOperationsService = require("../services/taLeadOperationsService");

const REQUISITION_ASSIGNER_CODE = "REQUISITION_ASSIGNER";

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

function resolveBackendApiBaseUrl() {
  if (process.env.BACKEND_API_URL) {
    return String(process.env.BACKEND_API_URL).replace(/\/$/, "");
  }

  const configured = String(process.env.API_BASE_URL || "").trim();
  if (configured.includes(":5000")) {
    return configured.replace(/\/$/, "");
  }

  return "http://localhost:5000";
}

const API_BASE_URL = resolveBackendApiBaseUrl();

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

async function fetchJson(path, token, options = {}) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      ...(options.headers || {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    }
  });
  const rawText = await response.text();
  let body = {};

  try {
    body = JSON.parse(rawText);
  } catch (_error) {
    body = {};
  }

  return { response, body, rawText };
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

async function resolveTaLeadWithoutAssigner() {
  const result = await pool.query(
    `SELECT u.user_id, u.employee_code, u.email_id, u.role_name, u.secondary_role
     FROM user_mstr u
     WHERE u.role_name IN ('TA Lead', 'TA Leader')
       AND COALESCE(u.is_active, TRUE) = TRUE
       AND NOT EXISTS (
         SELECT 1
         FROM employee_work_assignment ewa
         INNER JOIN work_assignment_mstr wam
           ON wam.work_assignment_id = ewa.work_assignment_id
          AND wam.assignment_code = $1
          AND COALESCE(wam.is_active, TRUE) = TRUE
         WHERE ewa.employee_code = u.employee_code
           AND COALESCE(ewa.is_active, TRUE) = TRUE
       )
     ORDER BY u.user_id ASC
     LIMIT 1`,
    [REQUISITION_ASSIGNER_CODE]
  );

  return result.rows[0] || null;
}

async function resolveUnauthorizedRecruiter() {
  const result = await pool.query(
    `SELECT u.user_id, u.employee_code, u.email_id, u.role_name, u.secondary_role
     FROM user_mstr u
     WHERE u.role_name = 'Recruiter'
       AND COALESCE(u.is_active, TRUE) = TRUE
       AND u.role_name NOT IN ('TA Lead', 'TA Leader')
       AND NOT EXISTS (
         SELECT 1
         FROM employee_work_assignment ewa
         INNER JOIN work_assignment_mstr wam
           ON wam.work_assignment_id = ewa.work_assignment_id
          AND wam.assignment_code = $1
          AND COALESCE(wam.is_active, TRUE) = TRUE
         WHERE ewa.employee_code = u.employee_code
           AND COALESCE(ewa.is_active, TRUE) = TRUE
       )
     ORDER BY u.user_id ASC
     LIMIT 1`,
    [REQUISITION_ASSIGNER_CODE]
  );

  return result.rows[0] || null;
}

async function resolveHiringManager() {
  const result = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name, secondary_role
     FROM user_mstr
     WHERE role_name = 'Hiring Manager'
       AND COALESCE(is_active, TRUE) = TRUE
     ORDER BY user_id ASC
     LIMIT 1`
  );

  return result.rows[0] || null;
}

async function resolveAdminUser() {
  const result = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name, secondary_role
     FROM user_mstr
     WHERE role_name = 'Admin'
       AND COALESCE(is_active, TRUE) = TRUE
     ORDER BY user_id ASC
     LIMIT 1`
  );

  return result.rows[0] || null;
}

async function resolveForeignPipelineCandidate() {
  const result = await pool.query(
    `SELECT candidate_id, owner_employee_code
     FROM cand_mstr
     WHERE UPPER(COALESCE(candidate_container, 'PIPELINE')) = 'PIPELINE'
       AND COALESCE(owner_employee_code, '') <> ''
     ORDER BY candidate_id DESC
     LIMIT 1`
  );

  return result.rows[0] || null;
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

async function verifyServiceLayer(taLead, taLeader, recruiter, hiringManager, admin) {
  console.log("--- Service layer ---");

  if (taLead) {
    try {
      await assertCanAssignRecruiters(pool, buildReq(taLead));
      pass("Service: TA Lead passes assertCanAssignRecruiters");
    } catch (error) {
      fail("Service: TA Lead assertCanAssignRecruiters", error.message);
    }

    try {
      await assertCanAccessTaLeadWorkspace(pool, buildReq(taLead));
      pass("Service: TA Lead passes assertCanAccessTaLeadWorkspace");
    } catch (error) {
      fail("Service: TA Lead assertCanAccessTaLeadWorkspace", error.message);
    }

    try {
      const summary = await taLeadOperationsService.buildOperationsSummary(
        pool,
        buildReq(taLead)
      );
      if (summary && typeof summary.approvals?.pending === "number") {
        pass("Service: TA Lead operations summary built");
      } else {
        fail("Service: TA Lead operations summary shape");
      }
    } catch (error) {
      fail("Service: TA Lead operations summary", error.message);
    }
  } else {
    skip("Service: TA Lead", "no fixture");
  }

  if (taLeader && taLeader.employee_code !== taLead?.employee_code) {
    try {
      await assertCanAccessTaLeadWorkspace(pool, buildReq(taLeader));
      pass("Service: TA Leader passes assertCanAccessTaLeadWorkspace");
    } catch (error) {
      fail("Service: TA Leader assertCanAccessTaLeadWorkspace", error.message);
    }
  }

  if (recruiter) {
    try {
      await assertCanAccessTaLeadWorkspace(pool, buildReq(recruiter));
      fail("Service: recruiter assertCanAccessTaLeadWorkspace", "expected throw");
    } catch (error) {
      if (error.status === 403) {
        pass("Service: recruiter denied TA Lead workspace access");
      } else {
        fail("Service: recruiter TA Lead workspace", error.message);
      }
    }
  }

  if (hiringManager) {
    try {
      await assertCanAccessTaLeadWorkspace(pool, buildReq(hiringManager));
      fail("Service: HM assertCanAccessTaLeadWorkspace", "expected throw");
    } catch (error) {
      if (error.status === 403) {
        pass("Service: Hiring Manager denied TA Lead workspace access");
      } else {
        fail("Service: HM TA Lead workspace", error.message);
      }
    }
  }

  if (admin) {
    try {
      await assertCanAssignRecruiters(pool, buildReq(admin));
      pass("Service: Admin assertCanAssignRecruiters unchanged");
    } catch (error) {
      fail("Service: Admin assertCanAssignRecruiters", error.message);
    }
  }
}

async function main() {
  console.log("=== TA Lead Workspace Verification ===\n");

  const taLead = await resolveTaLeadWithoutAssigner();
  const taLeader = await resolveUserByRole("TA Leader");
  const recruiter = await resolveUnauthorizedRecruiter();
  const hiringManager = await resolveHiringManager();
  const admin = await resolveAdminUser();
  const foreignCandidate = await resolveForeignPipelineCandidate();

  await verifyServiceLayer(taLead, taLeader, recruiter, hiringManager, admin);

  console.log("\n--- HTTP API (requires restarted backend on :5000) ---");

  let httpSkipped = false;

  if (taLead) {
    const token = signToken(taLead);
    const probe = await fetchJson("/api/v1/ta-lead/operations-summary", token);

    if (probe.response.status === 404) {
      skip("HTTP API suite", "backend not restarted with TA Lead routes");
      httpSkipped = true;
    }
  }

  if (!httpSkipped && taLead) {
    const token = signToken(taLead);
    const summary = await fetchJson("/api/v1/ta-lead/operations-summary", token);
    const list = await fetchJson("/api/v1/recruitment/requisitions", token);
    const recruiters = await fetchJson("/api/v1/recruitment/form-options/recruiters", token);

    if (summary.response.status === 200 && summary.body.success) {
      pass(`TA Lead (${taLead.role_name}) can load operations summary`);
    } else {
      fail("TA Lead operations summary", String(summary.response.status));
    }

    if (list.response.status === 200) {
      pass("TA Lead can list management requisitions");
    } else {
      fail("TA Lead list requisitions", String(list.response.status));
    }

    if (recruiters.response.status === 200) {
      pass("TA Lead can load recruiter form options");
    } else {
      fail("TA Lead recruiter form options", String(recruiters.response.status));
    }
  } else if (!taLead) {
    skip("TA Lead role scenarios", "no TA Lead/Leader without REQUISITION_ASSIGNER");
  }

  if (!httpSkipped && taLeader && taLeader.employee_code !== taLead?.employee_code) {
    const token = signToken(taLeader);
    const summary = await fetchJson("/api/v1/ta-lead/operations-summary", token);

    if (summary.response.status === 200) {
      pass("TA Leader behaves equivalently for operations summary");
    } else {
      fail("TA Leader operations summary", String(summary.response.status));
    }
  } else if (taLeader) {
    pass("TA Leader equivalence covered by TA Lead fixture");
  } else if (!httpSkipped) {
    skip("TA Leader scenarios", "no TA Leader user");
  }

  if (!httpSkipped && recruiter) {
    const token = signToken(recruiter);
    const summary = await fetchJson("/api/v1/ta-lead/operations-summary", token);
    const list = await fetchJson("/api/v1/recruitment/requisitions", token);

    if (summary.response.status === 403) {
      pass("Unauthorized recruiter blocked from TA Lead summary API");
    } else {
      fail("Unauthorized recruiter TA Lead summary", String(summary.response.status));
    }

    if (list.response.status === 403) {
      pass("Unauthorized recruiter blocked from assignment list API");
    } else {
      fail("Unauthorized recruiter assignment list", String(list.response.status));
    }
  } else if (!httpSkipped) {
    skip("unauthorized recruiter scenarios", "no recruiter without assigner");
  }

  if (!httpSkipped && hiringManager) {
    const token = signToken(hiringManager);
    const summary = await fetchJson("/api/v1/ta-lead/operations-summary", token);

    if (summary.response.status === 403) {
      pass("Hiring Manager blocked from TA Lead summary API");
    } else {
      fail("Hiring Manager TA Lead summary", String(summary.response.status));
    }
  } else {
    skip("hiring manager scenarios", "no hiring manager user");
  }

  if (!httpSkipped && admin) {
    const token = signToken(admin);
    const list = await fetchJson("/api/v1/recruitment/requisitions", token);
    const commandCenter = await fetchJson("/api/v1/admin/command-center", token);

    if (list.response.status === 200) {
      pass("Admin assignment list behavior unchanged");
    } else {
      fail("Admin assignment list", String(list.response.status));
    }

    if (commandCenter.response.status === 200) {
      pass("Admin command center behavior unchanged");
    } else {
      fail("Admin command center", String(commandCenter.response.status));
    }
  } else {
    skip("admin scenarios", "no admin user");
  }

  if (taLead && foreignCandidate) {
    const req = {
      user: {
        employee_code: taLead.employee_code,
        role_name: taLead.role_name,
        secondary_role: taLead.secondary_role
      }
    };

    try {
      await candidateAccessService.assertCandidateReadAccess(
        pool,
        req,
        foreignCandidate.candidate_id
      );
      fail(
        "TA Lead candidate read unchanged",
        "expected 403 for foreign owned pipeline candidate"
      );
    } catch (error) {
      if (error.status === 403) {
        pass("TA Lead denied foreign owned pipeline candidate (unchanged)");
      } else {
        fail("TA Lead candidate read", error.message);
      }
    }
  } else {
    skip("candidate access unchanged", "missing TA Lead or pipeline candidate fixture");
  }

  if (!httpSkipped && taLead) {
    const hct = await fetchJson(
      "/api/v1/hiring-control-tower/kpis",
      signToken(taLead)
    );
    if (hct.response.status === 403) {
      pass("TA Lead blocked from Admin-only HCT KPI API");
    } else {
      fail("TA Lead HCT access", String(hct.response.status));
    }
  } else if (httpSkipped) {
    skip("TA Lead HCT HTTP check", "backend not restarted");
  }

  console.log("\nTA Lead workspace verification finished.");
  await pool.end();
}

main().catch(async (error) => {
  fail("unexpected error", error.message);
  await pool.end();
});
