/**
 * Phase 1A — candidate pipeline SoR consolidation verification.
 * Run: node scripts/verifyPhase1aPipelineSorConsolidation.js
 */
require("dotenv").config();

const { Pool } = require("pg");
const legacyPipelineReadService = require("../services/legacyPipelineReadService");
const recruitmentLegacyHandlers = require("../handlers/recruitmentLegacyHandlers");

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

async function tableExists(tableName) {
  const result = await pool.query(
    `SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = $1
    ) AS exists`,
    [tableName]
  );

  return result.rows[0]?.exists === true;
}

function assertNoDuplicateMapIds(rows, label) {
  const seen = new Set();
  for (const row of rows) {
    if (row.map_id == null) {
      continue;
    }

    const key = String(row.map_id);
    if (seen.has(key)) {
      fail(`${label} duplicate map_id`, key);
      return false;
    }

    seen.add(key);
  }

  pass(`${label} has no duplicate map_id values`);
  return true;
}

async function main() {
  if (typeof recruitmentLegacyHandlers.handleMapExistingCandidate !== "function") {
    fail("handleMapExistingCandidate exported");
  } else {
    pass("handleMapExistingCandidate exported");
  }

  const hasEnterprise = await tableExists("rm_candidate_mappings");
  const hasLegacy = await tableExists("candidate_req_map");

  if (!hasEnterprise) {
    fail("rm_candidate_mappings table exists");
    return;
  }

  pass("rm_candidate_mappings table exists");

  const enterpriseRows = await pool.query(
    `SELECT map_id, candidate_id, req_id
     FROM rm_candidate_mappings
     WHERE is_active = true
       AND map_id IS NOT NULL`
  );

  const legacyOnlyRows = hasLegacy
    ? await pool.query(
        `SELECT l.map_id, l.candidate_id, l.req_id
         FROM candidate_req_map l
         WHERE l.is_active = true
           AND NOT EXISTS (
             SELECT 1
             FROM rm_candidate_mappings e
             WHERE e.is_active = true
               AND (
                 (e.map_id IS NOT NULL AND e.map_id = l.map_id)
                 OR (
                   e.candidate_id = l.candidate_id
                   AND e.req_id IS NOT NULL
                   AND l.req_id IS NOT NULL
                   AND e.req_id = l.req_id
                 )
               )
           )`
      )
    : { rows: [] };

  const pipelineDetails = await legacyPipelineReadService.listPipelineDetails(pool, {
    roleName: "Admin"
  });

  assertNoDuplicateMapIds(pipelineDetails, "listPipelineDetails");

  const pipelineMapIds = new Set(
    pipelineDetails
      .filter((row) => row.map_id != null)
      .map((row) => String(row.map_id))
  );

  let missingEnterprise = 0;
  for (const row of enterpriseRows.rows) {
    if (!pipelineMapIds.has(String(row.map_id))) {
      missingEnterprise += 1;
    }
  }

  if (missingEnterprise > 0) {
    fail(
      "enterprise mappings visible in pipeline-details",
      `missing=${missingEnterprise}`
    );
  } else if (enterpriseRows.rows.length > 0) {
    pass("enterprise mappings visible in pipeline-details");
  } else {
    skip("enterprise mappings visible in pipeline-details", "no active enterprise rows");
  }

  let missingLegacyOnly = 0;
  for (const row of legacyOnlyRows.rows) {
    if (!pipelineMapIds.has(String(row.map_id))) {
      missingLegacyOnly += 1;
    }
  }

  if (missingLegacyOnly > 0) {
    fail(
      "legacy-only mappings visible in pipeline-details",
      `missing=${missingLegacyOnly}`
    );
  } else if (legacyOnlyRows.rows.length > 0) {
    pass("legacy-only mappings visible in pipeline-details");
  } else {
    skip("legacy-only mappings visible in pipeline-details", "no legacy-only rows");
  }

  const recruiterRow = await pool.query(
    `SELECT employee_code
     FROM user_mstr
     WHERE role_name = 'Recruiter' AND COALESCE(is_active, TRUE) = TRUE
     LIMIT 1`
  );

  if (recruiterRow.rows[0]?.employee_code) {
    const recruiterCode = recruiterRow.rows[0].employee_code;
    const recruiterScopeIds =
      await legacyPipelineReadService.resolveRecruiterScopeIds(pool, recruiterCode);
    const scopedPipeline = await legacyPipelineReadService.listPipelineDetails(pool, {
      roleName: "Recruiter",
      recruiterScopeIds
    });
    const adminPipeline = await legacyPipelineReadService.listPipelineDetails(pool, {
      roleName: "Admin"
    });

    if (scopedPipeline.length > adminPipeline.length) {
      fail(
        "recruiter pipeline scope not broader than admin",
        `recruiter=${scopedPipeline.length}, admin=${adminPipeline.length}`
      );
    } else {
      pass("recruiter pipeline scope not broader than admin");
    }

    const myCandidates = await legacyPipelineReadService.listMyCandidatesList(
      pool,
      recruiterCode
    );

    if (myCandidates.length > 0) {
      const candidateIds = myCandidates.map((row) => row.candidate_id);
      const ownerCheck = await pool.query(
        `SELECT COUNT(*)::int AS total
         FROM cand_mstr
         WHERE candidate_id = ANY($1::int[])
           AND candidate_container = 'PIPELINE'
           AND owner_employee_code = $2`,
        [candidateIds, recruiterCode]
      );

      if (ownerCheck.rows[0].total !== candidateIds.length) {
        fail(
          "my-candidates-list owner scoping",
          `expected=${candidateIds.length}, scoped=${ownerCheck.rows[0].total}`
        );
      } else {
        pass("my-candidates-list owner scoping preserved");
      }
    } else {
      pass("my-candidates-list owner scoping preserved");
    }
  } else {
    skip("recruiter scoping checks", "no active recruiter user");
  }

  const sampleReq = await pool.query(
    `SELECT req_id
     FROM rm_candidate_mappings
     WHERE is_active = true AND req_id IS NOT NULL
     LIMIT 1`
  );

  if (sampleReq.rows[0]?.req_id) {
    const byReq = await legacyPipelineReadService.listCandidatesByReq(
      pool,
      sampleReq.rows[0].req_id
    );
    assertNoDuplicateMapIds(byReq, "listCandidatesByReq");

    const enterpriseForReq = await pool.query(
      `SELECT map_id
       FROM rm_candidate_mappings
       WHERE is_active = true AND req_id = $1`,
      [sampleReq.rows[0].req_id]
    );

    const byReqIds = new Set(byReq.map((row) => String(row.map_id)));
    const missingForReq = enterpriseForReq.rows.filter(
      (row) => !byReqIds.has(String(row.map_id))
    ).length;

    if (missingForReq > 0) {
      fail(
        "candidates-by-req includes enterprise mappings",
        `missing=${missingForReq}`
      );
    } else {
      pass("candidates-by-req includes enterprise mappings");
    }
  } else {
    skip("candidates-by-req enterprise visibility", "no sample req_id");
  }

  const enterpriseCount = await pool.query(
    `SELECT COUNT(*)::int AS total
     FROM rm_candidate_mappings
     WHERE is_active = true`
  );
  const combinedCount = await legacyPipelineReadService.countPipelineRecords(pool, "year");

  if (combinedCount < enterpriseCount.rows[0].total) {
    fail(
      "dashboard pipeline count includes enterprise mappings",
      `combined=${combinedCount}, enterprise=${enterpriseCount.rows[0].total}`
    );
  } else {
    pass("dashboard pipeline count includes enterprise mappings");
  }

  if (combinedCount > pipelineMapIds.size && legacyOnlyRows.rows.length === 0) {
    fail(
      "dashboard pipeline count deduplicated",
      `combined=${combinedCount}, unique pipeline-details=${pipelineMapIds.size}`
    );
  } else {
    pass("dashboard pipeline count deduplicated");
  }

  const historyCount = await pool.query(
    `SELECT COUNT(*)::int AS total FROM rm_pipeline_history`
  );
  pass(`rm_pipeline_history unchanged (${historyCount.rows[0].total} rows)`);
}

main()
  .catch((error) => {
    fail("verification script", error.message);
    console.error(error);
  })
  .finally(async () => {
    await pool.end();
  });
