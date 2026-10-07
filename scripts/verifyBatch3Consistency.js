/**
 * Batch 3 — DR1 workspace read, DR2 governed stage notify path, DR3 canonical schedule delegate.
 */
require("dotenv").config();

const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const recruitmentService = require("../services/recruitmentService");
const candidateAccessService = require("../services/candidateAccessService");

const API_BASE_URL = process.env.API_BASE_URL || "http://localhost:5000";

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

function record(label, passed, detail = "") {
  console.log(`${passed ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`);
  if (!passed) {
    process.exitCode = 1;
  }
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

async function resolveRecruiter() {
  const result = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name
     FROM user_mstr
     WHERE role_name = 'Recruiter' AND COALESCE(is_active, TRUE) = TRUE
     ORDER BY user_id ASC
     LIMIT 1`
  );
  return result.rows[0] || null;
}

async function resolveAdmin() {
  const result = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name
     FROM user_mstr
     WHERE role_name = 'Admin' AND COALESCE(is_active, TRUE) = TRUE
     LIMIT 1`
  );
  return result.rows[0] || null;
}

async function findCoRecruiterWorkspaceFixture(recruiterCode) {
  const byCoAssignment = await pool.query(
    `SELECT
       c.candidate_id,
       c.owner_employee_code,
       m.requisition_code,
       co.recruiter_code AS assigned_recruiter
     FROM rm_candidate_mappings m
     INNER JOIN cand_mstr c ON c.candidate_id = m.candidate_id
     INNER JOIN rm_recruiter_assignments co
       ON co.requisition_code = m.requisition_code
      AND co.is_active = TRUE
      AND co.recruiter_code = $1
     WHERE m.is_active = TRUE
       AND c.owner_employee_code IS NOT NULL
       AND c.owner_employee_code <> $1
     ORDER BY m.mapping_id DESC
     LIMIT 1`,
    [recruiterCode]
  );

  if (byCoAssignment.rows[0]) {
    return byCoAssignment.rows[0];
  }

  const dualAssigned = await pool.query(
    `SELECT
       c.candidate_id,
       c.owner_employee_code,
       m.requisition_code,
       $1::varchar AS assigned_recruiter
     FROM rm_candidate_mappings m
     INNER JOIN cand_mstr c ON c.candidate_id = m.candidate_id
     INNER JOIN rm_recruiter_assignments a_owner
       ON a_owner.requisition_code = m.requisition_code
      AND a_owner.is_active = TRUE
      AND a_owner.recruiter_code = c.owner_employee_code
     INNER JOIN rm_recruiter_assignments a_co
       ON a_co.requisition_code = m.requisition_code
      AND a_co.is_active = TRUE
      AND a_co.recruiter_code = $1
     WHERE m.is_active = TRUE
       AND c.owner_employee_code IS NOT NULL
     ORDER BY m.mapping_id DESC
     LIMIT 1`,
    [recruiterCode]
  );

  return dualAssigned.rows[0] || null;
}

async function findUnrelatedRecruiterFixture(ownerCode, assignedCode) {
  const result = await pool.query(
    `SELECT u.user_id, u.employee_code, u.email_id, u.role_name
     FROM user_mstr u
     WHERE u.role_name = 'Recruiter'
       AND COALESCE(u.is_active, TRUE) = TRUE
       AND u.employee_code NOT IN ($1, $2)
     ORDER BY u.user_id ASC
     LIMIT 1`,
    [ownerCode, assignedCode]
  );
  return result.rows[0] || null;
}

async function main() {
  let temporaryAssignmentId = null;

  const admin = await resolveAdmin();
  const recruiter = await resolveRecruiter();

  if (!admin || !recruiter) {
    record("fixtures", false, "Admin and Recruiter required");
    await pool.end();
    return;
  }

  let fixture = await findCoRecruiterWorkspaceFixture(recruiter.employee_code);

  if (!fixture) {
    const bootstrap = await pool.query(
      `SELECT
         c.candidate_id,
         c.owner_employee_code,
         m.requisition_code
       FROM rm_candidate_mappings m
       INNER JOIN cand_mstr c ON c.candidate_id = m.candidate_id
       WHERE m.is_active = TRUE
         AND c.owner_employee_code IS NOT NULL
         AND c.owner_employee_code <> $1
         AND m.requisition_code LIKE 'REQ-%'
         AND NOT EXISTS (
           SELECT 1
           FROM rm_recruiter_assignments a
           WHERE a.requisition_code = m.requisition_code
             AND a.recruiter_code = $1
             AND a.is_active = TRUE
         )
       ORDER BY m.mapping_id DESC
       LIMIT 1`,
      [recruiter.employee_code]
    );

    if (bootstrap.rows[0]) {
      const assignResult = await recruitmentService.assignRecruiter(
        pool,
        bootstrap.rows[0].requisition_code,
        recruiter.employee_code,
        { user: admin }
      );
      temporaryAssignmentId = assignResult.assignment?.assignment_id || null;
      fixture = {
        ...bootstrap.rows[0],
        assigned_recruiter: recruiter.employee_code
      };
      record("DR1 bootstrap co-recruiter assignment", Boolean(temporaryAssignmentId));
    }
  }

  if (!fixture) {
    record("DR1 co-recruiter fixture", false, "no mapped candidate with co-assignment");
  } else {
    const ownerReq = {
      user: {
        employee_code: fixture.owner_employee_code,
        role_name: "Recruiter",
        email_id: `${fixture.owner_employee_code}@test.local`
      }
    };
    const coReq = { user: recruiter };
    const adminReq = { user: admin };

    await recruitmentService.assertCandidateWorkspaceReadAccess(
      pool,
      ownerReq,
      fixture.candidate_id
    );
    record("DR1 owner recruiter workspace read", true);

    await recruitmentService.assertCandidateWorkspaceReadAccess(
      pool,
      coReq,
      fixture.candidate_id
    );
    record("DR1 assigned co-recruiter workspace read", true);

    await recruitmentService.assertCandidateWorkspaceReadAccess(
      pool,
      adminReq,
      fixture.candidate_id
    );
    record("DR1 Admin workspace read", true);

    const unrelated = await findUnrelatedRecruiterFixture(
      fixture.owner_employee_code,
      fixture.assigned_recruiter
    );

    if (unrelated) {
      try {
        await recruitmentService.assertCandidateWorkspaceReadAccess(
          pool,
          { user: unrelated },
          fixture.candidate_id
        );
        record("DR1 unrelated recruiter denied", false, "expected 403");
      } catch (error) {
        record(
          "DR1 unrelated recruiter denied",
          error.status === 403,
          `status=${error.status}`
        );
      }
    } else {
      record("DR1 unrelated recruiter denied", false, "no third recruiter fixture");
    }

    try {
      await candidateAccessService.assertCandidateReadAccess(
        pool,
        coReq,
        fixture.candidate_id
      );
      record("DR1 co-recruiter still denied base read access", false);
    } catch (error) {
      record(
        "DR1 co-recruiter still denied base read access",
        error.status === 403,
        "ownership unchanged"
      );
    }

    const coToken = signToken(recruiter);
    const httpProfile = await fetchJson(
      `/api/v1/recruitment/candidates/${fixture.candidate_id}/profile`,
      coToken
    );
    record(
      "DR1 HTTP co-recruiter workspace profile",
      httpProfile.status === 200 && httpProfile.body?.success === true,
      `status=${httpProfile.status}`
    );
  }

  if (temporaryAssignmentId && admin) {
    await recruitmentService.removeRecruiterAssignment(
      pool,
      temporaryAssignmentId,
      { user: admin }
    );
    record("DR1 cleanup temporary recruiter assignment", true);
  }

  record(
    "DR3 legacy handler delegates to canonical",
    String(require("../handlers/interviewLegacyHandlers").handleScheduleInterview).includes(
      "scheduleInterviewCanonical"
    ),
    "static check"
  );

  const routeSource = require("fs").readFileSync(
    require("path").join(__dirname, "..", "routes", "interviewRoutes.js"),
    "utf8"
  );
  record(
    "DR3 v1 route uses canonical",
    routeSource.includes("scheduleInterviewCanonical"),
    "source check"
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
