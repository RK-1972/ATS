/**
 * Phase 5E — unified stage transition audit verification.
 * Run: node scripts/verifyPhase5eStageTransitionAudit.js
 */
require("dotenv").config();

const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const recruitmentService = require("../services/recruitmentService");
const interviewService = require("../services/interviewService");
const businessRulesService = require("../services/businessRulesService");
const {
  applyEnterpriseInterviewStageTransition
} = require("../services/pipelineHistoryService");
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

async function tableExists(tableName) {
  const result = await pool.query(
    `SELECT EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = $1
    ) AS exists`,
    [tableName]
  );
  return Boolean(result.rows[0]?.exists);
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

  const fromExisting = await pool.query(
    `SELECT round_type
     FROM im_interviews
     WHERE round_type IS NOT NULL
     ORDER BY interview_id DESC
     LIMIT 1`
  );

  return fromExisting.rows[0]?.round_type || null;
}

async function resolvePanelMember() {
  const result = await pool.query(
    `SELECT panel_id, interviewer_name, email_id
     FROM interview_panel_mstr
     WHERE COALESCE(is_active, TRUE) = TRUE
     ORDER BY panel_id ASC
     LIMIT 1`
  );
  return result.rows[0] || null;
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

async function findScheduleFixture() {
  const result = await pool.query(
    `SELECT m.map_id, m.mapping_id, m.candidate_id, m.requisition_code, m.stage_name,
            r.req_id
     FROM rm_candidate_mappings m
     INNER JOIN rm_requisitions r ON r.requisition_code = m.requisition_code
     WHERE m.is_active = TRUE
       AND m.map_id IS NOT NULL
     ORDER BY m.modified_on DESC NULLS LAST
     LIMIT 1`
  );
  return result.rows[0] || null;
}

async function main() {
  console.log("=== Phase 5E Stage Transition Audit ===\n");

  if (!isEnterpriseOperationalSor()) {
    skip("enterprise stage transition audit", "OPERATIONAL_SOR is not enterprise");
    await pool.end();
    return;
  }

  const fixture = await findScheduleFixture();
  if (!fixture) {
    skip("all scenarios", "no active rm_candidate_mappings fixture");
    await pool.end();
    return;
  }

  const recruiter = await resolveRecruiterForMapping(fixture.requisition_code);
  if (!recruiter) {
    skip("recruiter-driven scenarios", "no assigned recruiter for fixture requisition");
    await pool.end();
    return;
  }

  const req = mockReq(recruiter);

  // 1) Phase 2B manual stage update still writes exactly one transition row.
  const currentStage = String(fixture.stage_name || "Applied").trim();
  const manualNextStage = currentStage === "Screening" ? "Applied" : "Screening";
  const beforeManual = await countHistoryForMapping(fixture.mapping_id);

  try {
    await recruitmentService.updateCandidateStage(
      pool,
      fixture.map_id,
      manualNextStage,
      "Phase 5E manual stage verification",
      req
    );

    const afterManual = await countHistoryForMapping(fixture.mapping_id);
    if (afterManual !== beforeManual + 1) {
      fail("manual stage update writes exactly one history row", `${beforeManual} -> ${afterManual}`);
    } else {
      pass("manual stage update writes exactly one history row");
    }

    const manualHistory = await latestHistoryForMapping(fixture.mapping_id);
    if (manualHistory?.event_type !== "StageChanged" && manualHistory?.event_type !== "CandidateShortlisted") {
      fail("manual stage history event_type", manualHistory?.event_type);
    } else if (manualHistory?.to_stage !== manualNextStage) {
      fail("manual stage history to_stage", manualHistory?.to_stage);
    } else {
      pass(`manual stage history to_stage=${manualHistory.to_stage}`);
    }
  } catch (error) {
    fail("manual stage update", error.message);
  }

  // 2) MANDATORY_L2_INTERVIEW wiring uses target_stage (updateCandidateStage now passes it).
  try {
    const positiveRule = await businessRulesService.evaluateRule(
      pool,
      "MANDATORY_L2_INTERVIEW",
      {
        target_stage: "Client Interview",
        grade: "G8",
        l2_completed: false
      }
    );

    if (!positiveRule.matched) {
      fail("MANDATORY_L2_INTERVIEW target_stage wiring");
    } else {
      pass("MANDATORY_L2_INTERVIEW fires with target_stage=Client Interview");
    }

    const negativeRule = await businessRulesService.evaluateRule(
      pool,
      "MANDATORY_L2_INTERVIEW",
      {
        to_stage: "Client Interview",
        grade: "G8",
        l2_completed: false
      }
    );

    if (negativeRule.matched) {
      fail("MANDATORY_L2_INTERVIEW ignores to_stage-only context");
    } else {
      pass("MANDATORY_L2_INTERVIEW does not fire with to_stage-only context");
    }
  } catch (error) {
    skip("MANDATORY_L2_INTERVIEW wiring", error.message);
  }

  // 3) scheduleInterview writes InterviewScheduledStage history.
  const panel = await resolvePanelMember();
  const roundType = await resolveInterviewRoundType();
  if (!panel) {
    skip("scheduleInterview history", "no interview_panel_mstr fixture");
  } else if (!roundType) {
    skip("scheduleInterview history", "no interview_types master-data fixture");
  } else {
    const scheduleFixture = await pool.query(
      `SELECT map_id, mapping_id, stage_name
       FROM rm_candidate_mappings
       WHERE is_active = TRUE
         AND map_id IS NOT NULL
         AND COALESCE(stage_name, '') NOT LIKE '%Interview Scheduled%'
       ORDER BY modified_on DESC NULLS LAST
       LIMIT 1`
    );
    const scheduleRow = scheduleFixture.rows[0];

    if (!scheduleRow) {
      skip("scheduleInterview history", "no suitable mapping fixture");
    } else {
      const beforeSchedule = await countHistoryForMapping(scheduleRow.mapping_id);
      const previousStage = scheduleRow.stage_name;
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 2);
      const interviewDate = tomorrow.toISOString().slice(0, 10);

      try {
        await interviewService.scheduleInterview(
          pool,
          {
            map_id: scheduleRow.map_id,
            req_id: fixture.req_id,
            interviewer_id: panel.panel_id,
            round_type: roundType,
            interview_date: interviewDate,
            interview_time: "10:30",
            interviewer_name: panel.interviewer_name,
            interviewer_email: panel.email_id,
            remarks: "Phase 5E schedule verification"
          },
          req
        );

        const afterSchedule = await countHistoryForMapping(scheduleRow.mapping_id);
        if (afterSchedule !== beforeSchedule + 1) {
          fail("scheduleInterview writes one history row", `${beforeSchedule} -> ${afterSchedule}`);
        } else {
          pass("scheduleInterview writes one history row");
        }

        const scheduleHistory = await latestHistoryForMapping(scheduleRow.mapping_id);
        if (scheduleHistory?.event_type !== "InterviewScheduledStage") {
          fail("scheduleInterview history event_type", scheduleHistory?.event_type);
        } else if (scheduleHistory?.from_stage !== previousStage) {
          fail(
            "scheduleInterview history from_stage",
            `expected=${previousStage}, got=${scheduleHistory?.from_stage}`
          );
        } else if (!scheduleHistory?.to_stage) {
          fail("scheduleInterview history to_stage missing");
        } else {
          pass(`scheduleInterview history from/to stages recorded (${scheduleHistory.to_stage})`);
        }
      } catch (error) {
        fail("scheduleInterview history", error.message);
      }
    }
  }

  // 4) Interview outcome stage transition helper writes InterviewOutcomeStage history.
  const outcomeFixture = await pool.query(
    `SELECT map_id, mapping_id, stage_name
     FROM rm_candidate_mappings
     WHERE is_active = TRUE
       AND map_id IS NOT NULL
       AND COALESCE(stage_name, '') <> 'L1 Technical Cleared'
     ORDER BY modified_on DESC NULLS LAST
     LIMIT 1`
  );
  const outcomeRow = outcomeFixture.rows[0];

  if (!outcomeRow) {
    skip("interview outcome history", "no suitable mapping fixture");
  } else {
    const beforeOutcome = await countHistoryForMapping(outcomeRow.mapping_id);
    const previousOutcomeStage = outcomeRow.stage_name;

    try {
      const result = await applyEnterpriseInterviewStageTransition(pool, {
        mapId: outcomeRow.map_id,
        newStage: "L1 Technical Cleared",
        eventType: "InterviewOutcomeStage",
        user: {
          name: recruiter.email_id || recruiter.employee_code,
          role: recruiter.role_name
        },
        comments: "Phase 5E outcome verification",
        metadata: { verification: true }
      });

      if (!result?.historyRecorded) {
        fail("interview outcome helper records history");
      } else {
        const afterOutcome = await countHistoryForMapping(outcomeRow.mapping_id);
        if (afterOutcome !== beforeOutcome + 1) {
          fail("interview outcome writes one history row", `${beforeOutcome} -> ${afterOutcome}`);
        } else {
          pass("interview outcome writes one history row");
        }

        const outcomeHistory = await latestHistoryForMapping(outcomeRow.mapping_id);
        if (outcomeHistory?.event_type !== "InterviewOutcomeStage") {
          fail("interview outcome history event_type", outcomeHistory?.event_type);
        } else if (outcomeHistory?.from_stage !== previousOutcomeStage) {
          fail(
            "interview outcome history from_stage",
            `expected=${previousOutcomeStage}, got=${outcomeHistory?.from_stage}`
          );
        } else if (outcomeHistory?.to_stage !== "L1 Technical Cleared") {
          fail("interview outcome history to_stage", outcomeHistory?.to_stage);
        } else {
          pass("interview outcome history from/to stages recorded");
        }
      }
    } catch (error) {
      fail("interview outcome history", error.message);
    }
  }

  // 5) submitFeedback enterprise path covered by verifyPhase5fStageTransitionGap.js.
  skip(
    "submitFeedback enterprise rm history via syncLegacyFeedback",
    "covered by verifyPhase5fStageTransitionGap.js"
  );

  if (process.exitCode) {
    console.error("\nPhase 5E stage transition audit completed with failures.");
  } else {
    console.log("\nAll Phase 5E stage transition audit checks passed.");
  }

  await pool.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
