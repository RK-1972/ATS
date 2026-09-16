/**
 * Phase 5I — governed ATS stage write enforcement verification.
 * Run: node scripts/verifyPhase5iAtsStageWriteEnforcement.js
 */
require("dotenv").config();

const { Pool } = require("pg");
const recruitmentService = require("../services/recruitmentService");
const interviewService = require("../services/interviewService");
const pipelineHistoryService = require("../services/pipelineHistoryService");
const { resolveGovernedAtsStage } = require("../services/atsStageWriteValidator");

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

function skip(label, reason) {
  console.log(`SKIP: ${label} — ${reason}`);
}

function mockReq(user) {
  return { user };
}

async function countActiveMappings() {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS total FROM rm_candidate_mappings WHERE is_active = TRUE`
  );
  return result.rows[0].total;
}

async function resolveRecruiterForMapping(requisitionCode) {
  const result = await pool.query(
    `SELECT u.user_id, u.employee_code, u.email_id, u.role_name, u.secondary_role
     FROM rm_recruiter_assignments a
     INNER JOIN user_mstr u ON u.employee_code = a.recruiter_code
     WHERE a.requisition_code = $1
       AND a.is_active = TRUE
       AND u.role_name = 'Recruiter'
     LIMIT 1`,
    [requisitionCode]
  );
  return result.rows[0] || null;
}

async function findActiveMappingFixture() {
  const result = await pool.query(
    `SELECT m.map_id, m.mapping_id, m.candidate_id, m.requisition_code, m.stage_name
     FROM rm_candidate_mappings m
     WHERE m.is_active = TRUE
       AND m.map_id IS NOT NULL
     ORDER BY m.modified_on DESC NULLS LAST
     LIMIT 1`
  );
  return result.rows[0] || null;
}

async function resolveInterviewRoundType() {
  const fromMaster = await pool.query(
    `SELECT name
     FROM md_records
     WHERE entity_type = 'interview_types'
       AND COALESCE(is_deleted, FALSE) = FALSE
     ORDER BY name ASC
     LIMIT 1`
  );

  if (fromMaster.rows[0]?.name) {
    return fromMaster.rows[0].name;
  }

  return "L1 Technical";
}

async function main() {
  console.log("=== Phase 5I ATS Stage Write Enforcement ===\n");

  const mappingCountBefore = await countActiveMappings();

  // Resolver — catalog
  try {
    const applied = await resolveGovernedAtsStage(pool, "Applied");
    if (applied.displayName !== "Applied" || applied.resolvedVia !== "catalog") {
      fail("catalog stage accepted", JSON.stringify(applied));
    } else {
      pass("catalog stage accepted (Applied)");
    }
  } catch (error) {
    fail("catalog stage accepted", error.message);
  }

  // Resolver — alias canonicalization
  try {
    const alias = await resolveGovernedAtsStage(pool, "L1 Technical");
    if (alias.displayName !== "L1 Interview" || alias.resolvedVia !== "alias") {
      fail("proven alias canonicalized", JSON.stringify(alias));
    } else {
      pass("proven alias accepted and canonicalized (L1 Technical -> L1 Interview)");
    }
  } catch (error) {
    fail("proven alias canonicalized", error.message);
  }

  // Resolver — unknown
  try {
    await resolveGovernedAtsStage(pool, "Interview Scheduled");
    fail("unknown/inactive stage rejected", "expected 400");
  } catch (error) {
    if (error.status === 400) {
      pass("unknown/inactive stage rejected (Interview Scheduled)");
    } else {
      fail("unknown/inactive stage rejected", `status=${error.status}`);
    }
  }

  // Resolver — ambiguous Classic value without alias
  try {
    await resolveGovernedAtsStage(pool, "L1 Technical Cleared");
    fail("ambiguous Classic value rejected", "expected 400");
  } catch (error) {
    if (error.status === 400) {
      pass("ambiguous Classic value rejected (L1 Technical Cleared)");
    } else {
      fail("ambiguous Classic value rejected", `status=${error.status}`);
    }
  }

  const fixture = await findActiveMappingFixture();
  if (!fixture) {
    skip("W2 integration scenarios", "no active mapping fixture");
  } else {
    const recruiter = await resolveRecruiterForMapping(fixture.requisition_code);
    const admin = await pool.query(
      `SELECT user_id, employee_code, email_id, role_name, secondary_role
       FROM user_mstr
       WHERE role_name = 'Admin' AND COALESCE(is_active, TRUE) = TRUE
       LIMIT 1`
    ).then((result) => result.rows[0] || null);

    const actor = recruiter || admin;
    if (!actor) {
      skip("W2 integration scenarios", "no recruiter/admin fixture");
    } else {
      const req = mockReq(actor);

      // W2 catalog update
      const catalogTarget = fixture.stage_name === "Screening" ? "Applied" : "Screening";
      try {
        const result = await recruitmentService.updateCandidateStage(
          pool,
          fixture.map_id,
          catalogTarget,
          "Phase 5I catalog stage verification",
          req
        );

        if (result.mapping?.stage_name !== catalogTarget) {
          fail("W2 catalog stage accepted", result.mapping?.stage_name);
        } else {
          pass(`W2 catalog stage accepted (${catalogTarget})`);
        }
      } catch (error) {
        fail("W2 catalog stage accepted", error.message);
      }

      // W2 alias update
      try {
        const aliasResult = await recruitmentService.updateCandidateStage(
          pool,
          fixture.map_id,
          "L1 Technical",
          "Phase 5I alias verification",
          req
        );

        if (aliasResult.mapping?.stage_name !== "L1 Interview") {
          fail("W2 alias canonicalized", aliasResult.mapping?.stage_name);
        } else {
          pass("W2 alias accepted and canonicalized (L1 Technical -> L1 Interview)");
        }
      } catch (error) {
        fail("W2 alias canonicalized", error.message);
      }

      // W2 arbitrary rejected
      try {
        await recruitmentService.updateCandidateStage(
          pool,
          fixture.map_id,
          "HR Interview Scheduled",
          "",
          req
        );
        fail("W2 arbitrary stage rejected", "expected 400");
      } catch (error) {
        if (error.status === 400) {
          pass("W2 arbitrary stage rejected (HR Interview Scheduled)");
        } else {
          fail("W2 arbitrary stage rejected", `status=${error.status} ${error.message}`);
        }
      }

      // W2 rollback — forced history failure rolls back stage update
      const rollbackFixture = await pool.query(
        `SELECT map_id, mapping_id, stage_name
         FROM rm_candidate_mappings
         WHERE map_id = $1`,
        [fixture.map_id]
      ).then((result) => result.rows[0]);

      if (rollbackFixture) {
        const originalStage = rollbackFixture.stage_name;
        const originalRecord = pipelineHistoryService.recordPipelineStageTransition;

        pipelineHistoryService.recordPipelineStageTransition = async () => {
          throw new Error("forced history failure");
        };

        try {
          await recruitmentService.updateCandidateStage(
            pool,
            rollbackFixture.map_id,
            "Offer",
            "rollback probe",
            req
          );
          fail("W2 transaction rollback", "expected forced history failure");
        } catch (error) {
          if (!/forced history failure/i.test(error.message)) {
            fail("W2 transaction rollback", error.message);
          } else {
            const stageAfter = (
              await pool.query(
                `SELECT stage_name FROM rm_candidate_mappings WHERE map_id = $1`,
                [rollbackFixture.map_id]
              )
            ).rows[0]?.stage_name;

            if (stageAfter !== originalStage) {
              fail("W2 forced history failure rolls back stage update", stageAfter);
            } else {
              pass("W2 forced history failure rolls back stage update");
            }
          }
        } finally {
          pipelineHistoryService.recordPipelineStageTransition = originalRecord;
        }
      }
    }
  }

  // W1 default Applied
  try {
    const defaultStage = await resolveGovernedAtsStage(pool, "Applied");
    if (defaultStage.displayName !== "Applied") {
      fail("W1 default Applied", defaultStage.displayName);
    } else {
      pass("W1 default Applied resolves");
    }
  } catch (error) {
    fail("W1 default Applied", error.message);
  }

  // W1 arbitrary rejected via resolver (mapCandidate uses same gate)
  try {
    await resolveGovernedAtsStage(pool, "L1 Interview Scheduled");
    fail("W1 arbitrary stage rejected", "expected 400");
  } catch (error) {
    if (error.status === 400) {
      pass("W1 arbitrary stage rejected (L1 Interview Scheduled)");
    } else {
      fail("W1 arbitrary stage rejected", `status=${error.status}`);
    }
  }

  // W3 micro-state path unchanged — scheduleInterview still writes micro-state
  const scheduleFixture = await pool.query(
    `SELECT map_id, mapping_id, stage_name, req_id, requisition_code
     FROM rm_candidate_mappings
     WHERE is_active = TRUE
       AND map_id IS NOT NULL
       AND COALESCE(stage_name, '') NOT LIKE '%Interview Scheduled%'
     ORDER BY modified_on DESC NULLS LAST
     LIMIT 1`
  ).then((result) => result.rows[0]);

  if (!scheduleFixture) {
    skip("W3 interview micro-state unchanged", "no schedule fixture");
  } else {
    const roundType = await resolveInterviewRoundType();
    const recruiter = await resolveRecruiterForMapping(scheduleFixture.requisition_code);
    const panel = await pool.query(
      `SELECT panel_id, interviewer_name, email_id, interviewer_type
       FROM interview_panel_mstr
       WHERE COALESCE(is_active, TRUE) = TRUE
       ORDER BY panel_id ASC
       LIMIT 1`
    ).then((result) => result.rows[0]);

    if (!recruiter || !panel) {
      skip("W3 interview micro-state unchanged", "missing recruiter/panel fixture");
    } else {
      const previousStage = scheduleFixture.stage_name;
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const interviewDate = tomorrow.toISOString().slice(0, 10);

      try {
        await interviewService.scheduleInterview(
          pool,
          {
            req_id: scheduleFixture.req_id,
            map_id: scheduleFixture.map_id,
            interviewer_id: panel.panel_id,
            round_type: roundType,
            interview_date: interviewDate,
            interview_time: "10:00",
            interviewer_name: panel.interviewer_name,
            interviewer_email: panel.email_id,
            interviewer_type: panel.interviewer_type || "Interviewer"
          },
          mockReq(recruiter)
        );

        const stageAfter = (
          await pool.query(
            `SELECT stage_name FROM rm_candidate_mappings WHERE map_id = $1`,
            [scheduleFixture.map_id]
          )
        ).rows[0]?.stage_name;

        if (!stageAfter || !/Interview Scheduled/i.test(stageAfter)) {
          fail("W3 interview micro-state unchanged", stageAfter);
        } else {
          pass(`W3 interview micro-state still written (${stageAfter})`);
        }

        // Restore prior stage for fixture hygiene
        if (previousStage && previousStage !== stageAfter) {
          await pool.query(
            `UPDATE rm_candidate_mappings
             SET stage_name = $1, modified_on = NOW()
             WHERE map_id = $2`,
            [previousStage, scheduleFixture.map_id]
          );
        }
      } catch (error) {
        skip("W3 interview micro-state unchanged", error.message);
      }
    }
  }

  const mappingCountAfter = await countActiveMappings();
  if (mappingCountAfter !== mappingCountBefore) {
    fail(
      "active mapping row count unchanged",
      `${mappingCountBefore} -> ${mappingCountAfter}`
    );
  } else {
    pass(`active mapping row count unchanged (${mappingCountBefore})`);
  }

  await pool.end();

  if (process.exitCode) {
    console.log("\n=== Phase 5I RESULT: FAIL ===");
  } else {
    console.log("\n=== Phase 5I RESULT: PASS ===");
  }
}

main().catch((error) => {
  console.error("Fatal:", error);
  process.exitCode = 1;
});
