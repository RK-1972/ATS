/**
 * Wave 6 — portal review queue + dashboard review_queue authorization.
 * Run: node scripts/verifyPortalReviewQueueAuthorization.js
 */
require("dotenv").config();

const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const recruitmentService = require("../services/recruitmentService");
const {
  assertPortalIntakeReviewQueueAccess
} = require("../services/candidateAccessService");

function resolveLocalApiBaseUrl() {
  if (process.env.VERIFY_HTTP_API_BASE_URL) {
    return String(process.env.VERIFY_HTTP_API_BASE_URL).replace(/\/$/, "");
  }
  for (const value of [process.env.BACKEND_API_URL, process.env.API_BASE_URL]) {
    const url = String(value || "").trim();
    if (url.includes(":5000")) {
      return url.replace(/\/$/, "");
    }
  }
  return "http://localhost:5000";
}

const API_BASE_URL = resolveLocalApiBaseUrl();

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

function signEmployee(user) {
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

function signCandidate(account) {
  return jwt.sign(
    {
      account_type: "candidate",
      portal_account_id: account.portal_account_id,
      candidate_id: account.candidate_id,
      email_id: account.email_id,
      full_name: account.full_name || "Candidate"
    },
    process.env.JWT_SECRET,
    { expiresIn: "8h" }
  );
}

async function fetchJson(path, token, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const response = await fetch(`${API_BASE_URL}${path}`, { headers });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

async function resolveUserByRole(roleName) {
  const result = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name, secondary_role, full_name
     FROM user_mstr
     WHERE role_name = $1 AND COALESCE(is_active, TRUE) = TRUE
     ORDER BY user_id ASC
     LIMIT 1`,
    [roleName]
  );
  return result.rows[0] || null;
}

async function resolvePortalCandidateToken() {
  const row = await pool.query(
    `SELECT a.portal_account_id, a.candidate_id, a.email_id, a.full_name
     FROM candidate_portal_account a
     WHERE COALESCE(a.is_active, TRUE) = TRUE
     ORDER BY a.portal_account_id DESC
     LIMIT 1`
  );
  const account = row.rows[0];
  if (!account) {
    return null;
  }
  return signCandidate(account);
}

async function main() {
  console.log("=== Portal Review Queue Authorization ===\n");

  const admin = await resolveUserByRole("Admin");
  const recruiter = await resolveUserByRole("Recruiter");
  const hm = await resolveUserByRole("Hiring Manager");
  const interviewer = await resolveUserByRole("Interviewer");

  if (!admin || !recruiter) {
    fail("fixtures", "Admin and Recruiter required");
    await pool.end();
    return;
  }

  try {
    assertPortalIntakeReviewQueueAccess({ user: admin });
    pass("service: Admin allowed");
  } catch (error) {
    fail("service: Admin allowed", error.message);
  }

  try {
    assertPortalIntakeReviewQueueAccess({ user: recruiter });
    pass("service: Recruiter allowed");
  } catch (error) {
    fail("service: Recruiter allowed", error.message);
  }

  if (hm) {
    try {
      assertPortalIntakeReviewQueueAccess({ user: hm });
      fail("service: Hiring Manager denied");
    } catch (error) {
      if (error.status === 403) {
        pass("service: Hiring Manager denied (403)");
      } else {
        fail("service: Hiring Manager denied", `status=${error.status}`);
      }
    }
  } else {
    skip("service: Hiring Manager", "no user");
  }

  if (interviewer) {
    try {
      assertPortalIntakeReviewQueueAccess({ user: interviewer });
      fail("service: Interviewer denied");
    } catch (error) {
      if (error.status === 403) {
        pass("service: Interviewer denied (403)");
      } else {
        fail("service: Interviewer denied", `status=${error.status}`);
      }
    }
  } else {
    skip("service: Interviewer", "no user");
  }

  const adminToken = signEmployee(admin);
  const recruiterToken = signEmployee(recruiter);
  const hmToken = hm ? signEmployee(hm) : null;
  const interviewerToken = interviewer ? signEmployee(interviewer) : null;
  const candidateToken = await resolvePortalCandidateToken();

  const unauthQueue = await fetchJson("/candidate-intake/portal-review-queue", null);
  if (unauthQueue.status === 401) {
    pass("HTTP: unauthenticated portal-review-queue (401)");
  } else {
    fail("HTTP: unauthenticated portal-review-queue", `status=${unauthQueue.status}`);
  }

  if (candidateToken) {
    const candQueue = await fetchJson(
      "/candidate-intake/portal-review-queue",
      candidateToken
    );
    if (candQueue.status === 403) {
      pass("HTTP: candidate token portal-review-queue (403)");
    } else {
      fail("HTTP: candidate token portal-review-queue", `status=${candQueue.status}`);
    }
  } else {
    skip("HTTP: candidate token", "no portal account");
  }

  const adminQueue = await fetchJson(
    "/candidate-intake/portal-review-queue",
    adminToken
  );
  if (adminQueue.status === 200 && adminQueue.body?.success) {
    pass("HTTP: Admin portal-review-queue (200)");
  } else {
    fail("HTTP: Admin portal-review-queue", `status=${adminQueue.status}`);
  }

  const recruiterQueue = await fetchJson(
    "/candidate-intake/portal-review-queue",
    recruiterToken
  );
  if (recruiterQueue.status === 200 && recruiterQueue.body?.success) {
    pass("HTTP: Recruiter portal-review-queue (200)");
  } else {
    fail("HTTP: Recruiter portal-review-queue", `status=${recruiterQueue.status}`);
  }

  if (hmToken) {
    const hmQueue = await fetchJson(
      "/candidate-intake/portal-review-queue",
      hmToken
    );
    if (hmQueue.status === 403) {
      pass("HTTP: Hiring Manager portal-review-queue (403)");
    } else {
      fail("HTTP: Hiring Manager portal-review-queue", `status=${hmQueue.status}`);
    }
  }

  if (interviewerToken) {
    const ivQueue = await fetchJson(
      "/candidate-intake/portal-review-queue",
      interviewerToken
    );
    if (ivQueue.status === 403) {
      pass("HTTP: Interviewer portal-review-queue (403)");
    } else {
      fail("HTTP: Interviewer portal-review-queue", `status=${ivQueue.status}`);
    }
  }

  const adminDash = await fetchJson("/candidate-intake/dashboard", adminToken);
  if (
    adminDash.status === 200
    && Array.isArray(adminDash.body?.dashboard?.review_queue)
  ) {
    pass("HTTP: Admin dashboard includes review_queue array");
  } else {
    fail("HTTP: Admin dashboard review_queue", `status=${adminDash.status}`);
  }

  const recruiterDash = await fetchJson("/candidate-intake/dashboard", recruiterToken);
  if (
    recruiterDash.status === 200
    && Array.isArray(recruiterDash.body?.dashboard?.review_queue)
  ) {
    pass("HTTP: Recruiter dashboard includes review_queue array");
  } else {
    fail("HTTP: Recruiter dashboard review_queue", `status=${recruiterDash.status}`);
  }

  if (hmToken) {
    const hmDash = await fetchJson("/candidate-intake/dashboard", hmToken);
    const queue = hmDash.body?.dashboard?.review_queue;
    if (
      hmDash.status === 200
      && Array.isArray(queue)
      && queue.length === 0
    ) {
      pass("HTTP: Hiring Manager dashboard review_queue empty");
    } else {
      fail(
        "HTTP: Hiring Manager dashboard review_queue empty",
        `status=${hmDash.status} len=${Array.isArray(queue) ? queue.length : "n/a"}`
      );
    }
  }

  if (interviewerToken) {
    const ivDash = await fetchJson("/candidate-intake/dashboard", interviewerToken);
    const queue = ivDash.body?.dashboard?.review_queue;
    if (
      ivDash.status === 200
      && Array.isArray(queue)
      && queue.length === 0
    ) {
      pass("HTTP: Interviewer dashboard review_queue empty");
    } else {
      fail(
        "HTTP: Interviewer dashboard review_queue empty",
        `status=${ivDash.status} len=${Array.isArray(queue) ? queue.length : "n/a"}`
      );
    }
  }

  const openList = await recruitmentService.listOpenRequisitionsForCandidatePortal(pool);
  const leaked = openList.filter((row) =>
    /^REQ-SEC-IVW-/i.test(row.requisition_code || "")
  );

  if (leaked.length === 0) {
    pass("open requisitions exclude REQ-SEC-IVW-* QA rows");
  } else {
    fail(
      "open requisitions exclude REQ-SEC-IVW-* QA rows",
      leaked.map((r) => r.requisition_code).join(", ")
    );
  }

  console.log("\nPortal review queue authorization verification finished.");
  await pool.end();
}

main().catch(async (error) => {
  fail("unexpected error", error.message);
  await pool.end();
});
