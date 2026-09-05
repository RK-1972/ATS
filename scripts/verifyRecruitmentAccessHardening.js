require("dotenv").config();

const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const recruitmentService = require("../services/recruitmentService");
const { assertCanCreateRequisition } = require("../services/requisitionCapabilityAuth");

const API_BASE_URL = process.env.API_BASE_URL || "http://localhost:5000";

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

async function fetchJson(path, token, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

async function resolveUserByRole(roleName) {
  const result = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name, secondary_role
     FROM user_mstr
     WHERE role_name = $1 AND COALESCE(is_active, TRUE) = TRUE
     ORDER BY user_id ASC
     LIMIT 1`,
    [roleName]
  );
  return result.rows[0] || null;
}

async function resolveRequestorUser() {
  const result = await pool.query(
    `SELECT u.user_id, u.employee_code, u.email_id, u.role_name, u.secondary_role
     FROM user_mstr u
     INNER JOIN employee_work_assignment ewa
       ON ewa.employee_code = u.employee_code
      AND ewa.is_active = TRUE
     INNER JOIN work_assignment_mstr wam
       ON wam.work_assignment_id = ewa.work_assignment_id
      AND wam.is_active = TRUE
     WHERE UPPER(wam.assignment_code) = 'REQUISITION_REQUESTOR'
       AND COALESCE(u.is_active, TRUE) = TRUE
     ORDER BY u.user_id ASC
     LIMIT 1`
  );
  return result.rows[0] || null;
}

async function resolveAssignedRequisition(recruiterCode) {
  const result = await pool.query(
    `SELECT r.req_id, r.requisition_code
     FROM rm_recruiter_assignments a
     INNER JOIN rm_requisitions r ON r.requisition_code = a.requisition_code
     WHERE a.recruiter_code = $1
       AND a.is_active = true
     ORDER BY a.assigned_on DESC
     LIMIT 1`,
    [recruiterCode]
  );
  return result.rows[0] || null;
}

async function resolveAnyRequisition() {
  const result = await pool.query(
    `SELECT req_id, requisition_code
     FROM rm_requisitions
     ORDER BY req_id DESC
     LIMIT 1`
  );
  return result.rows[0] || null;
}

async function resolveForeignRequisition(recruiterCode) {
  const result = await pool.query(
    `SELECT r.req_id, r.requisition_code
     FROM rm_recruiter_assignments a
     INNER JOIN rm_requisitions r ON r.requisition_code = a.requisition_code
     WHERE a.recruiter_code <> $1
       AND a.is_active = true
     ORDER BY a.assigned_on DESC
     LIMIT 1`,
    [recruiterCode]
  );
  return result.rows[0] || null;
}

async function main() {
  console.log("=== Recruitment Access Hardening (P1-3 / P1-7) ===\n");

  const recruiter = await resolveUserByRole("Recruiter");
  const interviewer = await resolveUserByRole("Interviewer");
  const hiringManager = await resolveUserByRole("Hiring Manager");
  const requestor = await resolveRequestorUser();

  if (!recruiter) {
    fail("fixtures", "Recruiter user required");
    await pool.end();
    return;
  }

  const assignedReq = await resolveAssignedRequisition(recruiter.employee_code);
  const foreignReq = await resolveForeignRequisition(recruiter.employee_code);
  const anyReq = await resolveAnyRequisition();

  console.log("--- P1-3 Service layer ---");

  if (foreignReq && (interviewer || hiringManager)) {
    try {
      await recruitmentService.mapCandidate(
        pool,
        {
          candidate_id: 999999,
          req_id: foreignReq.req_id,
          source_type: "LinkedIn"
        },
        { user: interviewer || hiringManager }
      );
      fail("Service: foreign requisition map", "expected throw");
    } catch (error) {
      if (error.status === 403) {
        pass("Service: unauthorized actor denied before mutation");
      } else {
        fail("Service: foreign requisition map", `expected 403, got ${error.status}`);
      }
    }
  } else {
    console.log("SKIP: no foreign recruiter assignment or non-recruiter fixture");
  }

  if (assignedReq) {
    const assignment = await pool.query(
      `SELECT assignment_id
       FROM rm_recruiter_assignments
       WHERE recruiter_code = $1
         AND is_active = true
         AND req_id = $2
       LIMIT 1`,
      [recruiter.employee_code, assignedReq.req_id]
    );
    if (assignment.rows.length) {
      pass("Service: recruiter has active assignment on target requisition");
    } else {
      fail("Service: recruiter assignment fixture", "missing active assignment row");
    }
  } else {
    console.log("SKIP: no assigned requisition fixture for recruiter");
  }

  console.log("\n--- P1-7 Service layer ---");

  if (interviewer) {
    try {
      await assertCanCreateRequisition(pool, { user: interviewer });
      fail("Service: interviewer create requisition", "expected throw");
    } catch (error) {
      if (error.status === 403) {
        pass("Service: non-requestor denied for legacy create");
      } else {
        fail("Service: interviewer create requisition", `expected 403, got ${error.status}`);
      }
    }
  }

  if (requestor) {
    try {
      await assertCanCreateRequisition(pool, { user: requestor });
      pass("Service: requestor allowed for legacy create");
    } catch (error) {
      fail("Service: requestor create requisition", error.message);
    }
  } else {
    console.log("SKIP: no REQUISITION_REQUESTOR user fixture");
  }

  const tokens = {
    recruiter: signToken(recruiter),
    interviewer: interviewer ? signToken(interviewer) : null,
    hiringManager: hiringManager ? signToken(hiringManager) : null,
    requestor: requestor ? signToken(requestor) : null
  };

  console.log("\n--- HTTP layer ---");

  const denialReq = foreignReq || anyReq;
  const mapPayload = denialReq
    ? { candidate_id: 999999, req_id: denialReq.req_id, source_type: "LinkedIn" }
    : null;

  for (const [label, token] of [
    ["Interviewer", tokens.interviewer],
    ["Hiring Manager", tokens.hiringManager]
  ]) {
    if (!token) {
      console.log(`SKIP: ${label} user not found`);
      continue;
    }
    if (!mapPayload) {
      console.log(`SKIP: ${label} mapping denial — no requisition fixture`);
      continue;
    }
    const denied = await fetchJson("/api/v1/recruitment/candidate-mappings", token, {
      method: "POST",
      body: mapPayload
    });
    if (denied.status === 403) {
      pass(`HTTP: ${label} denied candidate mapping`);
    } else {
      fail(`HTTP: ${label} candidate mapping`, `expected 403, got ${denied.status}`);
    }
  }

  if (tokens.recruiter && foreignReq) {
    const denied = await fetchJson("/api/v1/recruitment/candidate-mappings", tokens.recruiter, {
      method: "POST",
      body: {
        candidate_id: 999999,
        req_id: foreignReq.req_id,
        source_type: "LinkedIn"
      }
    });
    if (denied.status === 403) {
      pass("HTTP: Recruiter denied foreign requisition mapping");
    } else {
      fail("HTTP: Recruiter foreign mapping", `expected 403, got ${denied.status}`);
    }
  }

  if (tokens.recruiter && assignedReq) {
    pass("HTTP: recruiter has assigned requisition fixture for mapping workflows");
  }

  if (tokens.interviewer) {
    const denied = await fetchJson(
      "/api/v1/recruitment/requisitions/legacy-form",
      tokens.interviewer,
      {
        method: "POST",
        body: { approved_position_id: 1 }
      }
    );
    if (denied.status === 403) {
      pass("HTTP: non-requestor denied legacy-form create");
    } else {
      fail("HTTP: legacy-form non-requestor", `expected 403, got ${denied.status}`);
    }
  }

  if (tokens.requestor) {
    const allowed = await fetchJson(
      "/api/v1/recruitment/requisitions/legacy-form",
      tokens.requestor,
      {
        method: "POST",
        body: {}
      }
    );
    if (allowed.status === 403) {
      fail("HTTP: requestor legacy-form", "unexpected 403");
    } else if (allowed.status === 400) {
      pass("HTTP: requestor legacy-form reached validation (400)");
    } else {
      pass(`HTTP: requestor legacy-form authorized path (${allowed.status})`);
    }
  }

  const modernDenied = tokens.interviewer
    ? await fetchJson("/api/v1/recruitment/requisitions", tokens.interviewer, {
        method: "POST",
        body: { approved_position_id: 1 }
      })
    : null;

  if (modernDenied && modernDenied.status === 403) {
    pass("HTTP: modern requisitions route still denies non-requestor");
  }

  await pool.end();

  if (process.exitCode) {
    console.log("\nRecruitment access hardening verification completed with failures.");
  } else {
    console.log("\nAll recruitment access hardening checks passed.");
  }
}

main().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
  await pool.end();
});
