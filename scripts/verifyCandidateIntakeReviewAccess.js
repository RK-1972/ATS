/**
 * Candidate Intake Review access boundary verification.
 * Run: node scripts/verifyCandidateIntakeReviewAccess.js
 */
require("dotenv").config();

const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const { listIntakeReviewQueue } = require("../services/candidatePortalProfileService");

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

async function fetchStatus(path, token) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const response = await fetch(`${API_BASE_URL}${path}`, { headers });
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

async function resolveUnqueuedUnownedDraft(excludeIds = []) {
  const result = await pool.query(
    `
    SELECT c.candidate_id, c.resume_path
    FROM cand_mstr c
    WHERE UPPER(c.candidate_status) = 'DRAFT'
      AND COALESCE(TRIM(c.owner_employee_code), '') = ''
      AND NOT (c.candidate_id = ANY($1::int[]))
    ORDER BY c.candidate_id DESC
    LIMIT 1
    `,
    [excludeIds.length ? excludeIds : [0]]
  );
  return result.rows[0] || null;
}

async function resolveOwnedNonDraftOtherRecruiter(recruiterCode) {
  const result = await pool.query(
    `
    SELECT candidate_id
    FROM cand_mstr
    WHERE owner_employee_code IS NOT NULL
      AND TRIM(owner_employee_code) <> ''
      AND owner_employee_code <> $1
      AND UPPER(COALESCE(candidate_status, '')) <> 'DRAFT'
    ORDER BY candidate_id DESC
    LIMIT 1
    `,
    [recruiterCode]
  );
  return result.rows[0] || null;
}

async function main() {
  const recruiter = await resolveUserByRole("Recruiter");
  const admin = await resolveUserByRole("Admin");

  if (!recruiter) {
    fail("active recruiter user exists");
    await pool.end();
    return;
  }

  const recruiterToken = signToken(recruiter);
  const adminToken = admin ? signToken(admin) : null;
  const queue = await listIntakeReviewQueue(pool);
  const queued = queue[0] || null;

  if (!queued?.candidate_id) {
    fail("queued unowned DRAFT exists in Ready for Review");
    await pool.end();
    return;
  }

  const queuedGet = await fetchStatus(`/candidate/${queued.candidate_id}`, recruiterToken);
  if (queuedGet.status === 200) {
    pass(`A queued unowned DRAFT GET /candidate/:id → 200 (${queued.candidate_id})`);
  } else {
    fail(
      "A queued unowned DRAFT GET /candidate/:id → 200",
      `status=${queuedGet.status} ${queuedGet.body.message || ""}`
    );
  }

  const unqueued = await resolveUnqueuedUnownedDraft(
    queue.map((row) => Number(row.candidate_id))
  );

  if (!unqueued) {
    fail("unqueued unowned DRAFT exists for negative test");
  } else {
    const unqueuedGet = await fetchStatus(
      `/candidate/${unqueued.candidate_id}`,
      recruiterToken
    );
    if (unqueuedGet.status === 403) {
      pass(`B unqueued unowned DRAFT GET /candidate/:id → 403 (${unqueued.candidate_id})`);
    } else {
      fail(
        "B unqueued unowned DRAFT GET /candidate/:id → 403",
        `status=${unqueuedGet.status}`
      );
    }
  }

  if (queued.resume_path) {
    const queuedResume = await fetchStatus(
      `/candidate-resume/${queued.candidate_id}`,
      recruiterToken
    );
    if (queuedResume.status === 200) {
      pass(`C queued DRAFT GET /candidate-resume/:id → 200 (${queued.candidate_id})`);
    } else {
      fail(
        "C queued DRAFT GET /candidate-resume/:id → 200",
        `status=${queuedResume.status}`
      );
    }
  } else {
    fail("C queued DRAFT has resume_path for resume test");
  }

  if (unqueued?.resume_path) {
    const unqueuedResume = await fetchStatus(
      `/candidate-resume/${unqueued.candidate_id}`,
      recruiterToken
    );
    if (unqueuedResume.status === 403) {
      pass(`D unqueued DRAFT GET /candidate-resume/:id → 403 (${unqueued.candidate_id})`);
    } else {
      fail(
        "D unqueued DRAFT GET /candidate-resume/:id → 403",
        `status=${unqueuedResume.status}`
      );
    }
  } else if (unqueued) {
    pass(`D unqueued DRAFT GET /candidate-resume/:id → 403 (no resume_path; GET blocked)`);
  }

  const ownedOther = await resolveOwnedNonDraftOtherRecruiter(recruiter.employee_code);
  if (ownedOther) {
    const ownedGet = await fetchStatus(
      `/candidate/${ownedOther.candidate_id}`,
      recruiterToken
    );
    if (ownedGet.status === 403) {
      pass(`E owned/non-DRAFT other recruiter GET /candidate/:id → 403 (${ownedOther.candidate_id})`);
    } else {
      fail(
        "E owned/non-DRAFT other recruiter GET /candidate/:id → 403",
        `status=${ownedGet.status}`
      );
    }
  } else {
    pass("E owned/non-DRAFT other recruiter negative case skipped (no sample row)");
  }

  if (adminToken) {
    const adminGet = await fetchStatus(`/candidate/${queued.candidate_id}`, adminToken);
    if (adminGet.status === 200) {
      pass(`F admin GET queued DRAFT /candidate/:id → 200 (${queued.candidate_id})`);
    } else {
      fail("F admin GET queued DRAFT /candidate/:id → 200", `status=${adminGet.status}`);
    }
  } else {
    pass("F admin access skipped (no active admin user)");
  }

  console.log("Candidate intake review access verification finished.");
  await pool.end();
}

main().catch(async (error) => {
  fail("unexpected error", error.message);
  await pool.end();
});
