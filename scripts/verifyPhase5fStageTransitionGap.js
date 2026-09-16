/**
 * Phase 5F — enterprise interview stage gap + atomic history verification.
 * Run: node scripts/verifyPhase5fStageTransitionGap.js
 */
require("dotenv").config();

const { Pool } = require("pg");
const recruitmentService = require("../services/recruitmentService");
const interviewService = require("../services/interviewService");
const pipelineHistoryService = require("../services/pipelineHistoryService");
const {
  isLegacyDualWriteEnabled,
  isEnterpriseOperationalSor
} = require("../config/operationalCutover");

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

async function countHistoryForMapping(mappingId) {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS total
     FROM rm_pipeline_history
     WHERE mapping_id = $1`,
    [mappingId]
  );
  return result.rows[0].total;
}

async function latestHistoryForMapping(mappingId) {
  const result = await pool.query(
    `SELECT event_type, from_stage, to_stage
     FROM rm_pipeline_history
     WHERE mapping_id = $1
     ORDER BY history_id DESC
     LIMIT 1`,
    [mappingId]
  );
  return result.rows[0] || null;
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

async function findFeedbackFixture() {
  const result = await pool.query(
    `SELECT
        i.interview_id,
        i.map_id,
        i.schedule_id,
        i.round_type,
        m.mapping_id,
        m.stage_name,
        m.requisition_code,
        ipm.panel_id,
        ipm.interviewer_name,
        ipm.email_id,
        u.user_id,
        u.employee_code,
        u.email_id AS panel_email,
        u.role_name
     FROM im_interviews i
     INNER JOIN rm_candidate_mappings m
       ON m.map_id = i.map_id
      AND m.is_active = TRUE
     INNER JOIN im_panel_assignments pa
       ON pa.interview_id = i.interview_id
     INNER JOIN interview_panel_mstr ipm
       ON ipm.panel_id = pa.panel_id
      AND COALESCE(ipm.is_active, TRUE) = TRUE
     LEFT JOIN user_mstr u
       ON u.employee_code = ipm.employee_code
       OR u.user_id = ipm.user_id
     WHERE COALESCE(i.feedback_submitted, FALSE) = FALSE
       AND NOT EXISTS (
         SELECT 1
         FROM im_feedback f
         WHERE f.interview_id = i.interview_id
       )
     ORDER BY i.interview_id DESC
     LIMIT 1`
  );
  return result.rows[0] || null;
}

async function main() {
  console.log("=== Phase 5F Enterprise Interview Stage Gap ===\n");

  if (!isEnterpriseOperationalSor()) {
    skip("all scenarios", "OPERATIONAL_SOR is not enterprise");
    await pool.end();
    return;
  }

  const mappingFixture = await pool.query(
    `SELECT map_id, mapping_id, stage_name, requisition_code
     FROM rm_candidate_mappings
     WHERE is_active = TRUE
       AND map_id IS NOT NULL
     ORDER BY modified_on DESC NULLS LAST
     LIMIT 1`
  );
  const mappingRow = mappingFixture.rows[0];

  if (!mappingRow) {
    skip("all scenarios", "no active rm_candidate_mappings fixture");
    await pool.end();
    return;
  }

  const recruiter = await resolveRecruiterForMapping(mappingRow.requisition_code);
  if (!recruiter) {
    skip("recruiter scenarios", "no assigned recruiter fixture");
  }

  // 1) Atomic rollback — forced history failure rolls back stage update.
  const rollbackFixture = await pool.query(
    `SELECT map_id, mapping_id, stage_name
     FROM rm_candidate_mappings
     WHERE is_active = TRUE
       AND map_id IS NOT NULL
       AND COALESCE(stage_name, '') <> 'Phase5F-Rollback-Probe'
     ORDER BY modified_on DESC NULLS LAST
     LIMIT 1`
  );
  const rollbackRow = rollbackFixture.rows[0];

  if (!rollbackRow || !recruiter) {
    skip("transaction rollback", "no rollback fixture");
  } else {
    const originalStage = rollbackRow.stage_name;
    const originalRecord = pipelineHistoryService.recordPipelineStageTransition;

    pipelineHistoryService.recordPipelineStageTransition = async () => {
      throw new Error("forced history failure");
    };

    try {
      await pipelineHistoryService.applyEnterpriseInterviewStageTransition(pool, {
        mapId: rollbackRow.map_id,
        newStage: "Phase5F-Rollback-Probe",
        eventType: "InterviewOutcomeStage",
        user: {
          name: recruiter.email_id || recruiter.employee_code,
          role: recruiter.role_name
        },
        comments: "rollback probe",
        metadata: { verification: "phase5f-rollback" }
      });
      fail("transaction rollback", "expected forced history failure");
    } catch (error) {
      if (!/forced history failure/i.test(error.message)) {
        fail("transaction rollback", error.message);
      } else {
        const stageAfter = (
          await pool.query(
            `SELECT stage_name
             FROM rm_candidate_mappings
             WHERE map_id = $1`,
            [rollbackRow.map_id]
          )
        ).rows[0]?.stage_name;

        if (stageAfter === "Phase5F-Rollback-Probe") {
          fail("transaction rollback", "stage update was not rolled back");
        } else if (stageAfter !== originalStage) {
          fail("transaction rollback", `stage is ${stageAfter}, expected ${originalStage}`);
        } else {
          pass("forced history failure rolls back stage update");
        }
      }
    } finally {
      pipelineHistoryService.recordPipelineStageTransition = originalRecord;
    }
  }

  // 2) submitFeedback enterprise path when LEGACY_DUAL_WRITE=false.
  if (isLegacyDualWriteEnabled()) {
    skip(
      "submitFeedback enterprise path with LEGACY_DUAL_WRITE=false",
      "LEGACY_DUAL_WRITE is enabled in this environment"
    );
  } else {
    const feedbackFixture = await findFeedbackFixture();

    if (!feedbackFixture || !feedbackFixture.user_id) {
      skip(
        "submitFeedback enterprise path with LEGACY_DUAL_WRITE=false",
        "no pending interview + panel-user fixture"
      );
    } else {
      const beforeHistory = await countHistoryForMapping(feedbackFixture.mapping_id);
      const previousStage = feedbackFixture.stage_name;
      const panelUser = {
        user_id: feedbackFixture.user_id,
        employee_code: feedbackFixture.employee_code,
        email_id: feedbackFixture.panel_email || feedbackFixture.email_id,
        role_name: feedbackFixture.role_name || "Interviewer"
      };

      try {
        await interviewService.submitFeedback(
          pool,
          {
            interview_id: feedbackFixture.interview_id,
            interview_level: feedbackFixture.round_type || "L1 Technical",
            area_of_interview: "Technical",
            overall_rating: "Good",
            strengths: "phase5f",
            improvement_areas: "none",
            overall_comments: "Phase 5F feedback verification",
            final_outcome: "Selected",
            skills: []
          },
          mockReq(panelUser)
        );

        const afterHistory = await countHistoryForMapping(feedbackFixture.mapping_id);
        if (afterHistory !== beforeHistory + 1) {
          fail(
            "submitFeedback writes exactly one pipeline-history row",
            `${beforeHistory} -> ${afterHistory}`
          );
        } else {
          pass("submitFeedback writes exactly one pipeline-history row");
        }

        const history = await latestHistoryForMapping(feedbackFixture.mapping_id);
        if (history?.event_type !== "InterviewOutcomeStage") {
          fail("submitFeedback history event_type", history?.event_type);
        } else if (history?.from_stage !== previousStage) {
          fail(
            "submitFeedback history from_stage",
            `expected=${previousStage}, got=${history?.from_stage}`
          );
        } else if (!history?.to_stage) {
          fail("submitFeedback history to_stage missing");
        } else {
          pass(`submitFeedback enterprise stage/history recorded (${history.to_stage})`);
        }

        const stageAfter = (
          await pool.query(
            `SELECT stage_name
             FROM rm_candidate_mappings
             WHERE map_id = $1`,
            [feedbackFixture.map_id]
          )
        ).rows[0]?.stage_name;

        if (!stageAfter || stageAfter === previousStage && history?.to_stage === previousStage) {
          skip("submitFeedback enterprise stage value", "outcome resolved to unchanged stage");
        } else if (stageAfter !== history?.to_stage) {
          fail("submitFeedback rm stage matches history to_stage", stageAfter);
        } else {
          pass("submitFeedback rm stage matches history to_stage");
        }
      } catch (error) {
        fail("submitFeedback enterprise path", error.message);
      }
    }
  }

  // 3) Dual-write mode preserves enterprise + legacy when enabled.
  if (!isLegacyDualWriteEnabled()) {
    skip("dual-write enterprise + legacy stage updates", "LEGACY_DUAL_WRITE disabled");
  } else {
    skip(
      "dual-write enterprise + legacy stage updates",
      "no isolated dual-write fixture without mutating production feedback rows"
    );
  }

  if (process.exitCode) {
    console.error("\nPhase 5F verification completed with failures.");
  } else {
    console.log("\nAll Phase 5F checks passed or were intentionally skipped.");
  }

  await pool.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
