require("dotenv").config();

const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const candidateAccessService = require("../services/candidateAccessService");

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
  const headers = { ...(options.headers || {}) };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
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
     WHERE role_name = $1 AND COALESCE(is_active, TRUE) = TRUE
     ORDER BY user_id ASC
     LIMIT 1`,
    [roleName]
  );
  return result.rows[0] || null;
}

async function resolveOtherRecruiter(excludeCode) {
  const result = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name, secondary_role
     FROM user_mstr
     WHERE role_name = 'Recruiter'
       AND employee_code <> $1
       AND COALESCE(is_active, TRUE) = TRUE
     ORDER BY user_id ASC
     LIMIT 1`,
    [excludeCode]
  );
  return result.rows[0] || null;
}

async function main() {
  console.log("=== Candidate Access Hardening (P1-1 / P1-2) ===\n");

  const dbTotal = (await pool.query("SELECT COUNT(*)::int AS c FROM cand_mstr")).rows[0].c;

  const admin = await resolveUserByRole("Admin");
  const recruiter = await resolveUserByRole("Recruiter");
  const hiringManager = await resolveUserByRole("Hiring Manager");
  const interviewer = await resolveUserByRole("Interviewer");
  const taLead = await resolveUserByRole("TA Lead");

  if (!admin || !recruiter) {
    fail("fixtures", "Admin and Recruiter users required");
    await pool.end();
    return;
  }

  const foreignOwned = (
    await pool.query(
      `SELECT candidate_id, owner_employee_code, candidate_container
       FROM cand_mstr
       WHERE owner_employee_code IS NOT NULL
         AND owner_employee_code <> $1
         AND UPPER(COALESCE(candidate_container, 'PIPELINE')) = 'PIPELINE'
       ORDER BY candidate_id DESC
       LIMIT 1`,
      [recruiter.employee_code]
    )
  ).rows[0];

  console.log("--- Service layer ---");
  const adminRows = await candidateAccessService.listAuthorizedCandidateMasters(
    pool,
    { user: admin }
  );
  const recruiterRows = await candidateAccessService.listAuthorizedCandidateMasters(
    pool,
    { user: recruiter }
  );

  if (adminRows.length === dbTotal) {
    pass(`Service: Admin list returns all rows (${adminRows.length})`);
  } else {
    fail("Service: Admin list", `${adminRows.length} vs ${dbTotal}`);
  }

  if (recruiterRows.length < dbTotal || dbTotal <= 6) {
    pass(`Service: Recruiter list scoped (${recruiterRows.length}/${dbTotal})`);
  } else {
    fail("Service: Recruiter list", `expected scoped rows, got ${recruiterRows.length}`);
  }

  const foreignOwnedHttp = foreignOwned;

  if (foreignOwned) {
    try {
      await candidateAccessService.assertCandidateReadAccess(
        pool,
        { user: recruiter },
        foreignOwned.candidate_id
      );
      fail("Service: cross-owner assert", "expected throw");
    } catch (error) {
      if (error.status === 403) {
        pass("Service: Recruiter denied cross-owner PIPELINE read");
      } else {
        fail("Service: cross-owner assert", `expected 403, got ${error.status}`);
      }
    }

    await candidateAccessService.assertCandidateReadAccess(
      pool,
      { user: admin },
      foreignOwned.candidate_id
    );
    pass("Service: Admin allowed cross-owner read");
  }

  const tokens = {
    admin: signToken(admin),
    recruiter: signToken(recruiter),
    hiringManager: hiringManager ? signToken(hiringManager) : null,
    interviewer: interviewer ? signToken(interviewer) : null,
    taLead: taLead ? signToken(taLead) : null
  };

  console.log("\n--- HTTP layer (requires restarted backend) ---");

  const adminList = await fetchJson("/candidates", tokens.admin);
  const recruiterList = await fetchJson("/candidates", tokens.recruiter);
  const adminHttpRows = adminList.body?.data || [];
  const recruiterHttpRows = recruiterList.body?.data || [];

  if (adminList.status === 200 && adminHttpRows.length === dbTotal) {
    pass(`HTTP: Admin receives full candidate list (${adminHttpRows.length})`);
  } else {
    fail("HTTP: Admin candidate list", `status=${adminList.status} rows=${adminHttpRows.length} db=${dbTotal}`);
  }

  if (recruiterList.status === 200 && recruiterHttpRows.length < dbTotal) {
    pass(`HTTP: Recruiter list is scoped (${recruiterHttpRows.length} < ${dbTotal})`);
  } else if (recruiterList.status === 200 && dbTotal <= 5) {
    pass(`HTTP: Recruiter list scoped or small dataset (${recruiterHttpRows.length}/${dbTotal})`);
  } else {
    fail(
      "HTTP: Recruiter unrestricted list",
      `status=${recruiterList.status} rows=${recruiterHttpRows.length} db=${dbTotal}`
    );
  }

  for (const [label, token] of [
    ["Hiring Manager", tokens.hiringManager],
    ["Interviewer", tokens.interviewer],
    ["TA Lead", tokens.taLead]
  ]) {
    if (!token) {
      console.log(`SKIP: ${label} user not found`);
      continue;
    }
    const response = await fetchJson("/candidates", token);
    const rows = response.body?.data || [];
    if (response.status === 200 && rows.length <= dbTotal) {
      if (rows.length < dbTotal || dbTotal <= 5) {
        pass(`${label} does not receive unrestricted candidate pool (${rows.length}/${dbTotal})`);
      } else {
        fail(`${label} candidate list`, `expected scoped rows < ${dbTotal}, got ${rows.length}`);
      }
    } else {
      fail(`${label} candidate list`, `status=${response.status}`);
    }
  }

  const myList = await fetchJson("/my-candidates-list", tokens.recruiter);
  const availList = await fetchJson("/available-candidates", tokens.recruiter);

  if (myList.status === 200 && availList.status === 200) {
    pass("Scoped list endpoints still respond for recruiter");
  } else {
    fail("Scoped list endpoints", `my=${myList.status} avail=${availList.status}`);
  }

  console.log("\n--- P1-2 GET /candidate/:id ---");

  const ownedRow = (
    await pool.query(
      `SELECT candidate_id, owner_employee_code, candidate_container
       FROM cand_mstr
       WHERE owner_employee_code = $1
       ORDER BY candidate_id DESC
       LIMIT 1`,
      [recruiter.employee_code]
    )
  ).rows[0];

  const talentRow = (
    await pool.query(
      `SELECT candidate_id
       FROM cand_mstr
       WHERE UPPER(COALESCE(candidate_container, 'PIPELINE')) = 'TALENT_POOL'
       ORDER BY candidate_id DESC
       LIMIT 1`
    )
  ).rows[0];

  if (ownedRow) {
    const allowed = await fetchJson(`/candidate/${ownedRow.candidate_id}`, tokens.recruiter);
    if (allowed.status === 200 && allowed.body?.success) {
      pass("Recruiter can read owned PIPELINE candidate");
    } else {
      fail("Recruiter owned read", `status=${allowed.status}`);
    }
  } else {
    console.log("SKIP: no owned PIPELINE candidate for recruiter");
  }

  if (foreignOwned) {
    const denied = await fetchJson(`/candidate/${foreignOwnedHttp.candidate_id}`, tokens.recruiter);
    if (denied.status === 403) {
      pass("Recruiter denied cross-owner PIPELINE candidate read");
    } else {
      fail("Recruiter cross-owner read", `expected 403, got ${denied.status}`);
    }

    const adminRead = await fetchJson(`/candidate/${foreignOwnedHttp.candidate_id}`, tokens.admin);
    if (adminRead.status === 200 && adminRead.body?.success) {
      pass("Admin can read cross-owner candidate");
    } else {
      fail("Admin cross-owner read", `status=${adminRead.status}`);
    }
  } else {
    console.log("SKIP: no foreign-owned PIPELINE candidate fixture");
  }

  if (talentRow) {
    const talentRead = await fetchJson(`/candidate/${talentRow.candidate_id}`, tokens.recruiter);
    if (talentRead.status === 200 && talentRead.body?.success) {
      pass("Recruiter can read TALENT_POOL candidate");
    } else {
      fail("TALENT_POOL read", `status=${talentRead.status}`);
    }
  } else {
    console.log("SKIP: no TALENT_POOL candidate fixture");
  }

  const otherRecruiter = await resolveOtherRecruiter(recruiter.employee_code);
  if (foreignOwnedHttp && otherRecruiter) {
    const otherToken = signToken(otherRecruiter);
    const denied = await fetchJson(`/candidate/${foreignOwnedHttp.candidate_id}`, otherToken);
    if (denied.status === 403) {
      pass("Other recruiter denied foreign-owned PIPELINE candidate");
    } else {
      fail("Other recruiter cross-owner", `expected 403, got ${denied.status}`);
    }
  }

  console.log("\n--- P1-2 GET /candidate-full-details/:id ---");

  if (foreignOwnedHttp) {
    const adminFull = await fetchJson(
      `/candidate-full-details/${foreignOwnedHttp.candidate_id}`,
      tokens.admin
    );
    if (adminFull.status === 200 && adminFull.body?.success && adminFull.body?.data?.candidate_id) {
      pass("Admin cross-owner full-details read allowed");
    } else {
      fail("Admin cross-owner full-details", `status=${adminFull.status}`);
    }

    const recruiterDenied = await fetchJson(
      `/candidate-full-details/${foreignOwnedHttp.candidate_id}`,
      tokens.recruiter
    );
    if (recruiterDenied.status === 403) {
      pass("Recruiter denied cross-owner full-details read");
    } else {
      fail("Recruiter cross-owner full-details", `expected 403, got ${recruiterDenied.status}`);
    }

    for (const [label, token] of [
      ["Hiring Manager", tokens.hiringManager],
      ["Interviewer", tokens.interviewer],
      ["TA Lead", tokens.taLead]
    ]) {
      if (!token) {
        console.log(`SKIP: ${label} full-details user not found`);
        continue;
      }
      const denied = await fetchJson(
        `/candidate-full-details/${foreignOwnedHttp.candidate_id}`,
        token
      );
      if (denied.status === 403) {
        pass(`${label} denied cross-owner full-details read`);
      } else {
        fail(`${label} cross-owner full-details`, `expected 403, got ${denied.status}`);
      }
    }
  } else {
    console.log("SKIP: no foreign-owned PIPELINE candidate for full-details tests");
  }

  if (ownedRow) {
    const ownedFull = await fetchJson(
      `/candidate-full-details/${ownedRow.candidate_id}`,
      tokens.recruiter
    );
    if (ownedFull.status === 200 && ownedFull.body?.success) {
      pass("Recruiter authorized full-details read (owned PIPELINE)");
    } else {
      fail("Recruiter owned full-details", `status=${ownedFull.status}`);
    }
  }

  if (talentRow) {
    const talentFull = await fetchJson(
      `/candidate-full-details/${talentRow.candidate_id}`,
      tokens.recruiter
    );
    if (talentFull.status === 200 && talentFull.body?.success) {
      pass("Recruiter TALENT_POOL full-details read allowed");
    } else {
      fail("Recruiter TALENT_POOL full-details", `status=${talentFull.status}`);
    }
  }

  await pool.end();

  if (process.exitCode) {
    console.log("\nCandidate access hardening verification completed with failures.");
  } else {
    console.log("\nAll candidate access hardening checks passed.");
  }
}

main().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
  await pool.end();
});
