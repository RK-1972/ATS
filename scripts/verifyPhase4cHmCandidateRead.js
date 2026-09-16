/**
 * Phase 4C — HM read-only candidate access verification.
 * Run: node scripts/verifyPhase4cHmCandidateRead.js
 */
require("dotenv").config();

const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const hiringManagerIdentityService = require("../services/hiringManagerIdentityService");
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
    { expiresIn: "1h" }
  );
}

function mockReq(user) {
  return { user };
}

function assertNoDuplicateMapIds(rows, label) {
  const seen = new Set();

  for (const row of rows) {
    if (row.map_id === null || row.map_id === undefined) {
      continue;
    }

    if (seen.has(row.map_id)) {
      fail(label, `duplicate map_id=${row.map_id}`);
      return;
    }

    seen.add(row.map_id);
  }

  pass(label);
}

async function fetchJson(path, token) {
  const headers = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE_URL}${path}`, { headers });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

async function resolveUsersByRole(roleName) {
  const result = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name, secondary_role
     FROM user_mstr
     WHERE role_name = $1 AND COALESCE(is_active, TRUE) = TRUE
     ORDER BY user_id ASC`,
    [roleName]
  );

  return result.rows;
}

async function main() {
  console.log("=== Phase 4C HM Read-Only Candidate Access ===\n");

  const hmUsers = await resolveUsersByRole("Hiring Manager");
  const recruiters = await resolveUsersByRole("Recruiter");
  const admins = await resolveUsersByRole("Admin");

  if (!hmUsers.length) {
    fail("fixtures", "no Hiring Manager users");
    await pool.end();
    return;
  }

  const boundHmRows = await pool.query(
    `SELECT hiring_manager_id, hiring_manager_name, employee_code
     FROM hiring_manager_mstr
     WHERE is_active = TRUE
       AND employee_code IS NOT NULL`
  );

  const primaryHmUser =
    hmUsers.find((user) =>
      boundHmRows.rows.some((row) => row.employee_code === user.employee_code)
    ) || null;
  const otherHmUser =
    hmUsers.find((user) => user.employee_code !== primaryHmUser?.employee_code) ||
    hmUsers[1] ||
    null;
  const otherBoundHmUser = hmUsers.find(
    (user) =>
      user.employee_code !== primaryHmUser?.employee_code &&
      boundHmRows.rows.some((row) => row.employee_code === user.employee_code)
  );

  if (!primaryHmUser) {
    fail("fixtures", "no bound Hiring Manager user");
    await pool.end();
    return;
  }

  const primaryBinding = await hiringManagerIdentityService.resolveBoundHiringManager(
    pool,
    mockReq(primaryHmUser)
  );
  pass(
    `bound HM resolved (${primaryHmUser.employee_code} -> ${primaryBinding.hiring_manager_code})`
  );

  const ownedRequisitions = await hiringManagerIdentityService.listMyHmRequisitions(
    pool,
    mockReq(primaryHmUser)
  );
  const ownedCodes = new Set(
    ownedRequisitions.map((row) => row.requisition_code).filter(Boolean)
  );

  const candidates = await hiringManagerIdentityService.listMyHmCandidates(
    pool,
    mockReq(primaryHmUser)
  );

  if (candidates.length > 0) {
    pass(`bound HM sees ${candidates.length} candidate mapping(s)`);
  } else {
    skip("bound HM candidate visibility", "no rm_candidate_mappings for owned requisitions");
  }

  assertNoDuplicateMapIds(candidates, "no duplicate map_id in HM candidate list");

  const leakedScope = candidates.filter(
    (row) => row.requisition_code && !ownedCodes.has(row.requisition_code)
  );

  if (leakedScope.length > 0) {
    fail(
      "HM candidates scoped to owned requisitions",
      leakedScope[0].requisition_code
    );
  } else if (candidates.length > 0) {
    pass("HM candidates scoped to owned requisitions");
  }

  const enterpriseCount = await pool.query(
    `SELECT COUNT(*)::int AS total
     FROM rm_candidate_mappings m
     WHERE m.is_active = TRUE
       AND (
         m.requisition_code = ANY($1::varchar[])
         OR (m.req_id IS NOT NULL AND m.req_id = ANY($2::int[]))
       )`,
    [
      Array.from(ownedCodes),
      ownedRequisitions.map((row) => row.req_id).filter(Boolean)
    ]
  );

  if (enterpriseCount.rows[0]?.total > 0) {
    pass(`enterprise rm_candidate_mappings in scope (${enterpriseCount.rows[0].total})`);
  } else if (candidates.length === 0) {
    skip("enterprise rm_candidate_mappings in scope", "no mappings in fixture");
  } else {
    fail("enterprise rm_candidate_mappings in scope", "expected enterprise rows");
  }

  if (ownedRequisitions[0]?.requisition_code) {
    const filtered = await hiringManagerIdentityService.listMyHmCandidates(
      pool,
      mockReq(primaryHmUser),
      { requisition_code: ownedRequisitions[0].requisition_code }
    );
    const outOfScope = filtered.filter(
      (row) => row.requisition_code !== ownedRequisitions[0].requisition_code
    );

    if (outOfScope.length > 0) {
      fail("requisition filter scoped correctly");
    } else {
      pass(`requisition filter scoped (${ownedRequisitions[0].requisition_code})`);
    }
  } else {
    skip("requisition filter scoped", "no owned requisition code fixture");
  }

  const foreignReq = await pool.query(
    `SELECT requisition_code, req_id
     FROM rm_requisitions
     WHERE requisition_code IS NOT NULL
       AND NOT (
         hiring_manager_id = $1
         OR (
           hiring_manager_id IS NULL
           AND LOWER(TRIM(COALESCE(hiring_manager, ''))) = LOWER($2)
         )
       )
     LIMIT 1`,
    [primaryBinding.hiring_manager_id, primaryBinding.hiring_manager_name]
  );

  if (foreignReq.rows[0]?.requisition_code) {
    try {
      await hiringManagerIdentityService.listMyHmCandidates(
        pool,
        mockReq(primaryHmUser),
        { requisition_code: foreignReq.rows[0].requisition_code }
      );
      fail("foreign requisition filter rejected", "expected throw");
    } catch (error) {
      if (error.status === 404) {
        pass("foreign requisition filter rejected (404)");
      } else {
        fail("foreign requisition filter rejected", `status=${error.status}`);
      }
    }
  } else {
    skip("foreign requisition filter rejected", "no foreign requisition fixture");
  }

  if (otherBoundHmUser) {
    const otherCandidates = await hiringManagerIdentityService.listMyHmCandidates(
      pool,
      mockReq(otherBoundHmUser)
    );
    const primaryMapIds = new Set(candidates.map((row) => row.map_id));
    const overlap = otherCandidates.filter((row) => primaryMapIds.has(row.map_id));

    if (overlap.length > 0) {
      fail("second bound HM isolation", `overlap map_id=${overlap[0].map_id}`);
    } else {
      pass("second bound HM cannot see primary HM candidate mappings");
    }
  } else if (otherHmUser) {
    try {
      await hiringManagerIdentityService.listMyHmCandidates(
        pool,
        mockReq(otherHmUser)
      );
      fail("unbound HM rejected", "expected throw");
    } catch (error) {
      if (error.status === 403) {
        pass(`unbound HM rejected (403, ${otherHmUser.employee_code})`);
      } else {
        fail("unbound HM rejected", `status=${error.status}`);
      }
    }
  } else {
    skip("second HM isolation", "no second HM user fixture");
  }

  const recruiter = recruiters[0];
  if (recruiter) {
    try {
      await hiringManagerIdentityService.listMyHmCandidates(
        pool,
        mockReq(recruiter)
      );
      fail("recruiter rejected on HM candidate endpoint", "expected throw");
    } catch (error) {
      if (error.status === 403) {
        pass("recruiter rejected on HM candidate endpoint (403)");
      } else {
        fail("recruiter rejected on HM candidate endpoint", `status=${error.status}`);
      }
    }

    const recruiterList = await candidateAccessService.listAuthorizedCandidateMasters(
      pool,
      mockReq(recruiter)
    );

    if (Array.isArray(recruiterList)) {
      pass("recruiter candidate access service unchanged");
    } else {
      fail("recruiter candidate access service unchanged");
    }
  } else {
    skip("recruiter checks", "no recruiter user");
  }

  const admin = admins[0];
  if (admin) {
    try {
      await hiringManagerIdentityService.listMyHmCandidates(
        pool,
        mockReq(admin)
      );
      fail("unbound admin rejected on HM candidate endpoint", "expected throw");
    } catch (error) {
      if (error.status === 403) {
        pass("unbound admin rejected on HM candidate endpoint (403)");
      } else {
        fail("unbound admin rejected on HM candidate endpoint", `status=${error.status}`);
      }
    }

    const adminList = await candidateAccessService.listAuthorizedCandidateMasters(
      pool,
      mockReq(admin)
    );

    if (Array.isArray(adminList) && adminList.length >= 0) {
      pass("admin candidate access service unchanged");
    } else {
      fail("admin candidate access service unchanged");
    }
  } else {
    skip("admin checks", "no admin user");
  }

  const primaryToken = signToken(primaryHmUser);
  const recruiterToken = recruiter ? signToken(recruiter) : null;
  const otherToken = otherBoundHmUser
    ? signToken(otherBoundHmUser)
    : otherHmUser
      ? signToken(otherHmUser)
      : null;

  const primaryHttp = await fetchJson(
    "/api/v1/recruitment/my-hm-candidates",
    primaryToken
  );

  if (primaryHttp.status === 200 && Array.isArray(primaryHttp.body?.data)) {
    pass(`HTTP primary HM my-hm-candidates (200, count=${primaryHttp.body.data.length})`);
    assertNoDuplicateMapIds(
      primaryHttp.body.data,
      "HTTP response has no duplicate map_id"
    );
  } else {
    fail("HTTP primary HM my-hm-candidates", `status=${primaryHttp.status}`);
  }

  if (foreignReq.rows[0]?.requisition_code) {
    const foreignHttp = await fetchJson(
      `/api/v1/recruitment/my-hm-candidates?requisition_code=${encodeURIComponent(foreignReq.rows[0].requisition_code)}`,
      primaryToken
    );

    if (foreignHttp.status === 404) {
      pass("HTTP foreign requisition filter rejected (404)");
    } else {
      fail("HTTP foreign requisition filter rejected", `status=${foreignHttp.status}`);
    }
  }

  if (recruiterToken) {
    const recruiterHttp = await fetchJson(
      "/api/v1/recruitment/my-hm-candidates",
      recruiterToken
    );

    if (recruiterHttp.status === 403) {
      pass("HTTP recruiter denied (403)");
    } else {
      fail("HTTP recruiter denied", `status=${recruiterHttp.status}`);
    }

    const recruiterLegacyHttp = await fetchJson(
      "/my-candidates-list",
      recruiterToken
    );

    if (recruiterLegacyHttp.status === 200) {
      pass("HTTP recruiter /my-candidates-list unchanged (200)");
    } else {
      fail("HTTP recruiter /my-candidates-list unchanged", `status=${recruiterLegacyHttp.status}`);
    }
  }

  if (otherToken) {
    const otherHttp = await fetchJson(
      "/api/v1/recruitment/my-hm-candidates",
      otherToken
    );

    if (otherBoundHmUser) {
      if (otherHttp.status === 200 && Array.isArray(otherHttp.body?.data)) {
        const primaryMapIds = new Set(
          (primaryHttp.body?.data || []).map((row) => row.map_id)
        );
        const overlap = otherHttp.body.data.filter((row) =>
          primaryMapIds.has(row.map_id)
        );

        if (overlap.length > 0) {
          fail("HTTP second HM overlap", `map_id=${overlap[0].map_id}`);
        } else {
          pass("HTTP second bound HM list does not overlap primary HM");
        }
      } else {
        fail("HTTP second bound HM my-hm-candidates", `status=${otherHttp.status}`);
      }
    } else if (otherHttp.status === 403) {
      pass("HTTP unbound HM denied (403)");
    } else {
      fail("HTTP unbound HM denied", `status=${otherHttp.status}`);
    }
  }

  if (process.exitCode) {
    console.log("\nPhase 4C HM candidate verification completed with failures.");
  } else {
    console.log("\nAll Phase 4C HM candidate checks passed.");
  }
}

main()
  .catch((error) => {
    fail("verification script", error.message);
    console.error(error);
  })
  .finally(async () => {
    await pool.end();
  });
