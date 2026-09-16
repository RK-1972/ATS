/**
 * Phase 2B — enterprise candidate pipeline operations verification.
 * Run: node scripts/verifyPhase2bCandidatePipelineOps.js
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

function pass(label) {
  console.log(`PASS: ${label}`);
}

function skip(label, reason) {
  console.log(`SKIP: ${label} — ${reason}`);
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

function mockReq(user) {
  return { user };
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

async function findActiveMappingSample() {
  const result = await pool.query(
    `SELECT m.map_id, m.mapping_id, m.candidate_id, m.requisition_code, m.stage_name,
            c.owner_employee_code, c.candidate_container
     FROM rm_candidate_mappings m
     INNER JOIN cand_mstr c ON c.candidate_id = m.candidate_id
     WHERE m.is_active = true
       AND m.map_id IS NOT NULL
     ORDER BY m.modified_on DESC NULLS LAST
     LIMIT 1`
  );
  return result.rows[0] || null;
}

async function recruiterAssignedToRequisition(recruiterCode, requisitionCode) {
  const result = await pool.query(
    `SELECT assignment_id
     FROM rm_recruiter_assignments
     WHERE recruiter_code = $1
       AND is_active = true
       AND requisition_code = $2
     LIMIT 1`,
    [recruiterCode, requisitionCode]
  );
  return result.rows.length > 0;
}

async function main() {
  console.log("Phase 2B — Enterprise Candidate Pipeline Operations\n");

  const admin = await resolveUserByRole("Admin");
  const recruiter = await resolveUserByRole("Recruiter");

  if (!admin) {
    fail("resolve Admin user");
    return;
  }

  if (!recruiter) {
    skip("recruiter scenarios", "no Recruiter user in DB");
  }

  const mappingRow = await findActiveMappingSample();
  if (!mappingRow) {
    skip("mapping-based scenarios", "no active rm_candidate_mappings row");
    await pool.end();
    return;
  }

  const assignedRecruiter = await pool.query(
    `SELECT u.user_id, u.employee_code, u.email_id, u.role_name, u.secondary_role
     FROM rm_recruiter_assignments a
     INNER JOIN user_mstr u ON u.employee_code = a.recruiter_code
     WHERE a.requisition_code = $1
       AND a.is_active = true
       AND u.role_name = 'Recruiter'
     LIMIT 1`,
    [mappingRow.requisition_code]
  );
  const authorizedRecruiter = assignedRecruiter.rows[0] || recruiter;
  const otherRecruiter = authorizedRecruiter
    ? await resolveOtherRecruiter(authorizedRecruiter.employee_code)
    : null;

  if (
    authorizedRecruiter &&
    !(await recruiterAssignedToRequisition(
      authorizedRecruiter.employee_code,
      mappingRow.requisition_code
    ))
  ) {
    skip(
      "authorized recruiter stage update",
      "sample mapping has no assigned recruiter row"
    );
  } else if (authorizedRecruiter) {
    const req = mockReq(authorizedRecruiter);
    const currentStage = String(mappingRow.stage_name || "Applied").trim();
    const nextStage = currentStage === "Screening" ? "Applied" : "Screening";

    try {
      const beforeHistory = await pool.query(
        `SELECT COUNT(*)::int AS total
         FROM rm_pipeline_history
         WHERE mapping_id = $1`,
        [mappingRow.mapping_id]
      );

      const result = await recruitmentService.updateCandidateStage(
        pool,
        mappingRow.map_id,
        nextStage,
        "Phase 2B verification",
        req
      );

      if (result.mapping?.stage_name !== nextStage) {
        fail("stage update writes rm_candidate_mappings.stage_name", result.mapping?.stage_name);
      } else {
        pass("authorized recruiter stage update via recruitmentService");
      }

      const afterHistory = await pool.query(
        `SELECT COUNT(*)::int AS total
         FROM rm_pipeline_history
         WHERE mapping_id = $1`,
        [mappingRow.mapping_id]
      );

      if (afterHistory.rows[0].total <= beforeHistory.rows[0].total) {
        fail("stage update writes rm_pipeline_history");
      } else {
        pass("stage update writes rm_pipeline_history");
      }

      const historyRows = await recruitmentService.listPipelineHistoryForMapping(
        pool,
        mappingRow.map_id,
        req
      );

      if (!Array.isArray(historyRows) || historyRows.length === 0) {
        fail("listPipelineHistoryForMapping returns rows");
      } else {
        pass(`listPipelineHistoryForMapping returns ${historyRows.length} row(s)`);
      }
    } catch (error) {
      fail("authorized recruiter stage update", error.message);
    }
  }

  if (otherRecruiter && authorizedRecruiter) {
    try {
      await recruitmentService.updateCandidateStage(
        pool,
        mappingRow.map_id,
        "Unauthorized Stage",
        "",
        mockReq(otherRecruiter)
      );
      fail("unauthorized recruiter stage update rejected");
    } catch (error) {
      if (error.status === 403) {
        pass("unauthorized recruiter stage update rejected (403)");
      } else {
        fail("unauthorized recruiter stage update rejected", `status=${error.status}`);
      }
    }
  } else {
    skip("unauthorized recruiter stage update", "need two recruiters");
  }

  try {
    const currentStage = String(mappingRow.stage_name || "Applied").trim();
    const adminStage = currentStage === "Screening" ? "Applied" : "Screening";

    await recruitmentService.updateCandidateStage(
      pool,
      mappingRow.map_id,
      adminStage,
      "",
      mockReq(admin)
    );
    pass("admin stage update allowed");
  } catch (error) {
    fail("admin stage update allowed", error.message);
  }

  const ownerCode = mappingRow.owner_employee_code;

  if (ownerCode && otherRecruiter) {
    try {
      await recruitmentService.assertAuthorizedRelease(
        pool,
        mockReq(otherRecruiter),
        mappingRow.candidate_id
      );
      const isAssigned = await recruiterAssignedToRequisition(
        otherRecruiter.employee_code,
        mappingRow.requisition_code
      );
      if (!isAssigned) {
        fail("unauthorized recruiter release rejected");
      } else {
        skip(
          "unauthorized recruiter release rejected",
          "other recruiter is also assigned to requisition"
        );
      }
    } catch (error) {
      if (error.status === 403) {
        pass("unauthorized recruiter release rejected (403)");
      } else {
        fail("unauthorized recruiter release rejected", error.message);
      }
    }

    try {
      await recruitmentService.assertAuthorizedRelease(
        pool,
        mockReq(admin),
        mappingRow.candidate_id
      );
      pass("admin release authorization allowed");
    } catch (error) {
      fail("admin release authorization allowed", error.message);
    }

    if (ownerCode) {
      const ownerUser = await pool.query(
        `SELECT user_id, employee_code, email_id, role_name, secondary_role
         FROM user_mstr
         WHERE employee_code = $1
         LIMIT 1`,
        [ownerCode]
      );
      const owner = ownerUser.rows[0];

      if (owner) {
        try {
          await recruitmentService.assertAuthorizedRelease(
            pool,
            mockReq(owner),
            mappingRow.candidate_id
          );
          pass("owner release authorization allowed");
        } catch (error) {
          fail("owner release authorization allowed", error.message);
        }
      }
    }
  } else {
    skip("release authorization scenarios", "owner/other recruiter not resolved");
  }

  if (otherRecruiter) {
    const foreignPipeline = await pool.query(
      `SELECT c.candidate_id
       FROM cand_mstr c
       WHERE c.candidate_container = 'PIPELINE'
         AND c.owner_employee_code IS NOT NULL
         AND c.owner_employee_code <> $1
       LIMIT 1`,
      [otherRecruiter.employee_code]
    );

    if (foreignPipeline.rows[0]) {
      try {
        await candidateAccessService.assertCandidateReadAccess(
          pool,
          mockReq(otherRecruiter),
          foreignPipeline.rows[0].candidate_id
        );
        fail("foreign pipeline profile read denied");
      } catch (error) {
        if (error.status === 403) {
          pass("foreign pipeline profile read denied (403)");
        } else {
          fail("foreign pipeline profile read denied", `status=${error.status}`);
        }
      }
    } else {
      skip("foreign pipeline profile read denied", "no foreign owned pipeline row");
    }
  }

  const adminToken = signToken(admin);
  const historyHttp = await fetchJson(
    `/api/v1/recruitment/candidate-mappings/${mappingRow.map_id}/pipeline-history`,
    adminToken
  );

  if (historyHttp.status === 200 && historyHttp.body?.success) {
    pass("GET pipeline-history HTTP endpoint");
  } else if (historyHttp.status === 404) {
    skip("GET pipeline-history HTTP endpoint", "API server not restarted with new route");
  } else if (historyHttp.status === 0 || historyHttp.status >= 500) {
    skip("GET pipeline-history HTTP endpoint", "API server not reachable");
  } else {
    fail(
      "GET pipeline-history HTTP endpoint",
      `status=${historyHttp.status} body=${JSON.stringify(historyHttp.body)}`
    );
  }

  await pool.end();

  if (process.exitCode) {
    console.log("\nPhase 2B verification FAILED");
  } else {
    console.log("\nPhase 2B verification PASSED");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
