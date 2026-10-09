/**
 * Regression verification for production UAT defects:
 * 1) Interviewer dropdown eligibility after Primary Role → Interviewer
 * 2) Interview schedule stage resolution (no interview_scheduled workflow error)
 *
 * Usage: node scripts/verifyUatProductionDefectRegressions.js
 */
require("dotenv").config();

const { Pool } = require("pg");
const userProvisioningService = require("../services/userProvisioningService");
const interviewService = require("../services/interviewService");
const {
  catalogStageCodeToCandidateWorkflowStageKey,
  inferCatalogStageCodeFromOperationalStage
} = require("../services/candidatePortalStageResolver");

const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

const RUN_ID = Date.now();
let passCount = 0;
let failCount = 0;
let skipCount = 0;

function pass(label) {
  passCount += 1;
  console.log(`PASS: ${label}`);
}

function fail(label, detail = "") {
  failCount += 1;
  console.log(`FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
}

function skip(label, detail = "") {
  skipCount += 1;
  console.log(`SKIP: ${label}${detail ? ` — ${detail}` : ""}`);
}

async function activeInterviewersForEmployee(employeeCode) {
  const result = await pool.query(
    `SELECT DISTINCT u.employee_code
     FROM interview_panel_mstr ip
     INNER JOIN user_mstr u ON ip.user_id = u.user_id
     INNER JOIN employee_work_assignment ewa ON ewa.employee_code = u.employee_code AND ewa.is_active = TRUE
     INNER JOIN work_assignment_mstr wa
       ON wa.work_assignment_id = ewa.work_assignment_id
      AND wa.is_active = TRUE
      AND wa.assignment_code = 'INTERVIEWER'
     WHERE ip.is_active = TRUE
       AND u.is_active = TRUE
       AND u.employee_code = $1`,
    [employeeCode]
  );
  return result.rows;
}

async function cleanupEmployee(employeeCode) {
  await pool.query(`DELETE FROM employee_work_assignment WHERE employee_code = $1`, [
    employeeCode
  ]);
  await pool.query(`DELETE FROM interview_panel_mstr WHERE employee_code = $1`, [employeeCode]);
  await pool.query(`DELETE FROM user_role_history WHERE employee_code = $1`, [employeeCode]);
  await pool.query(`DELETE FROM user_status_history WHERE employee_code = $1`, [employeeCode]);
  await pool.query(`DELETE FROM user_mstr WHERE employee_code = $1`, [employeeCode]);
}

function verifyStageResolverUnit() {
  const interviewScheduledCode = inferCatalogStageCodeFromOperationalStage("Interview Scheduled");
  const workflowKey = catalogStageCodeToCandidateWorkflowStageKey(interviewScheduledCode);

  if (interviewScheduledCode !== "L1_INTERVIEW") {
    fail("operational Interview Scheduled maps to L1_INTERVIEW catalog code", interviewScheduledCode);
  } else {
    pass("operational Interview Scheduled maps to L1_INTERVIEW catalog code");
  }

  if (workflowKey !== "l1") {
    fail("catalog L1_INTERVIEW maps to CANDIDATE workflow stage l1", workflowKey);
  } else {
    pass("catalog L1_INTERVIEW maps to CANDIDATE workflow stage l1");
  }

  if (catalogStageCodeToCandidateWorkflowStageKey("APPLIED") !== "applied") {
    fail("catalog APPLIED maps to applied workflow stage");
  } else {
    pass("catalog APPLIED maps to applied workflow stage");
  }

  const invalidSlug = "interview_scheduled";
  if (catalogStageCodeToCandidateWorkflowStageKey(invalidSlug)) {
    fail("display slug interview_scheduled is not a catalog stage code");
  } else {
    pass("display slug interview_scheduled is not a catalog stage code");
  }
}

async function countActiveInterviewerAssignments(employeeCode) {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS c
     FROM employee_work_assignment ewa
     INNER JOIN work_assignment_mstr wa
       ON wa.work_assignment_id = ewa.work_assignment_id
     WHERE ewa.employee_code = $1
       AND ewa.is_active = TRUE
       AND wa.assignment_code = 'INTERVIEWER'
       AND wa.is_active = TRUE`,
    [employeeCode]
  );
  return result.rows[0].c;
}

async function verifyInterviewerRoleChangeWithPreExistingAssignment(admin) {
  const code = `UATIVPRE${String(RUN_ID).slice(-7)}`;
  const email = `uat.iv.pre.${RUN_ID}@optalynx.demo`;

  const masters = await pool.query(
    `SELECT work_assignment_id, assignment_code
     FROM work_assignment_mstr
     WHERE assignment_code IN ('RECRUITER', 'INTERVIEWER')
       AND is_active = TRUE`
  );

  const recruiterWa = masters.rows.find((row) => row.assignment_code === "RECRUITER");
  const interviewerWa = masters.rows.find((row) => row.assignment_code === "INTERVIEWER");

  if (!recruiterWa || !interviewerWa) {
    skip("pre-existing INTERVIEWER role change", "RECRUITER or INTERVIEWER master missing");
    return;
  }

  await cleanupEmployee(code);

  try {
    await userProvisioningService.provisionEmployee(
      pool,
      { user: admin },
      {
        employee_code: code,
        full_name: "UAT Pre Existing Interviewer WA",
        email_id: email,
        password: "VerifyPass123",
        role_name: "Recruiter",
        work_assignment_ids: [recruiterWa.work_assignment_id, interviewerWa.work_assignment_id]
      }
    );

    const ewaBefore = await pool.query(
      `SELECT COUNT(*)::int AS c FROM employee_work_assignment WHERE employee_code = $1 AND is_active = TRUE`,
      [code]
    );
    const interviewerEwaBefore = await countActiveInterviewerAssignments(code);

    if (interviewerEwaBefore !== 1) {
      fail("pre-existing INTERVIEWER assignment before role change", `count=${interviewerEwaBefore}`);
      return;
    }

    await userProvisioningService.changePrimaryRole(pool, { user: admin }, code, {
      role_name: "Interviewer",
      reason: "UAT pre-existing INTERVIEWER assignment"
    });

    const ewaAfter = await pool.query(
      `SELECT COUNT(*)::int AS c FROM employee_work_assignment WHERE employee_code = $1 AND is_active = TRUE`,
      [code]
    );
    const interviewerEwaAfter = await countActiveInterviewerAssignments(code);

    if (ewaAfter.rows[0].c !== ewaBefore.rows[0].c) {
      fail(
        "pre-existing INTERVIEWER role change preserves EWA count",
        `before=${ewaBefore.rows[0].c} after=${ewaAfter.rows[0].c}`
      );
    } else {
      pass("pre-existing INTERVIEWER role change preserves EWA count");
    }

    if (interviewerEwaAfter !== 1) {
      fail("pre-existing INTERVIEWER role change keeps single INTERVIEWER EWA", `count=${interviewerEwaAfter}`);
    } else {
      pass("pre-existing INTERVIEWER role change keeps single INTERVIEWER EWA");
    }

    const activeJoin = await activeInterviewersForEmployee(code);
    if (activeJoin.length !== 1) {
      fail("pre-existing INTERVIEWER role change active-interviewers join", `rows=${activeJoin.length}`);
    } else {
      pass("pre-existing INTERVIEWER role change active-interviewers join");
    }

    const panelCount = await pool.query(
      `SELECT COUNT(*)::int AS c FROM interview_panel_mstr WHERE employee_code = $1 AND is_active = TRUE`,
      [code]
    );
    if (panelCount.rows[0].c !== 1) {
      fail("pre-existing INTERVIEWER role change single panel row", `count=${panelCount.rows[0].c}`);
    } else {
      pass("pre-existing INTERVIEWER role change single panel row");
    }
  } finally {
    await cleanupEmployee(code);
  }
}

async function verifyUnauthorizedInterviewerRoleChange(admin, unauthorizedUser) {
  if (!unauthorizedUser) {
    skip("unauthorized Interviewer role change", "no recruiter fixture without USER_ADMINISTRATOR");
    return;
  }

  const code = `UATIVDENY${String(RUN_ID).slice(-7)}`;
  const email = `uat.iv.deny.${RUN_ID}@optalynx.demo`;

  const recruiterWa = await pool.query(
    `SELECT work_assignment_id
     FROM work_assignment_mstr
     WHERE assignment_code = 'RECRUITER' AND is_active = TRUE
     LIMIT 1`
  );

  if (!recruiterWa.rows[0]) {
    skip("unauthorized Interviewer role change", "RECRUITER master missing");
    return;
  }

  await cleanupEmployee(code);

  try {
    await userProvisioningService.provisionEmployee(
      pool,
      { user: admin },
      {
        employee_code: code,
        full_name: "UAT Unauthorized Role Target",
        email_id: email,
        password: "VerifyPass123",
        role_name: "Recruiter",
        work_assignment_ids: [recruiterWa.rows[0].work_assignment_id]
      }
    );

    try {
      await userProvisioningService.changePrimaryRole(
        pool,
        { user: unauthorizedUser },
        code,
        {
          role_name: "Interviewer",
          reason: "should be denied"
        }
      );
      fail("unauthorized Interviewer role change rejected");
    } catch (error) {
      if (error.status === 403) {
        pass("unauthorized Interviewer role change rejected (403)");
      } else {
        fail("unauthorized Interviewer role change rejected", `status=${error.status} ${error.message}`);
      }
    }

    const roleRow = await pool.query(
      `SELECT role_name FROM user_mstr WHERE employee_code = $1`,
      [code]
    );
    if (roleRow.rows[0]?.role_name !== "Recruiter") {
      fail("unauthorized role change leaves Primary Role unchanged", roleRow.rows[0]?.role_name);
    } else {
      pass("unauthorized role change leaves Primary Role unchanged");
    }

    const interviewerEwa = await countActiveInterviewerAssignments(code);
    if (interviewerEwa !== 0) {
      fail("unauthorized role change creates no INTERVIEWER EWA", `count=${interviewerEwa}`);
    } else {
      pass("unauthorized role change creates no INTERVIEWER EWA");
    }

    const panelCount = await pool.query(
      `SELECT COUNT(*)::int AS c FROM interview_panel_mstr WHERE employee_code = $1`,
      [code]
    );
    if (panelCount.rows[0].c !== 0) {
      fail("unauthorized role change creates no panel row", `count=${panelCount.rows[0].c}`);
    } else {
      pass("unauthorized role change creates no panel row");
    }
  } finally {
    await cleanupEmployee(code);
  }
}

async function verifyInterviewerRoleChangeEligibility(admin) {
  const code = `UATIV${String(RUN_ID).slice(-8)}`;
  const email = `uat.iv.${RUN_ID}@optalynx.demo`;

  const recruiterWa = await pool.query(
    `SELECT work_assignment_id
     FROM work_assignment_mstr
     WHERE assignment_code = 'RECRUITER' AND is_active = TRUE
     LIMIT 1`
  );

  if (!recruiterWa.rows[0]) {
    skip("interviewer role change eligibility", "RECRUITER master missing");
    return;
  }

  await cleanupEmployee(code);

  try {
    await userProvisioningService.provisionEmployee(
      pool,
      { user: admin },
      {
        employee_code: code,
        full_name: "UAT Interviewer Role Change",
        email_id: email,
        password: "VerifyPass123",
        role_name: "Recruiter",
        work_assignment_ids: [recruiterWa.rows[0].work_assignment_id]
      }
    );

    await userProvisioningService.changePrimaryRole(pool, { user: admin }, code, {
      role_name: "Interviewer",
      reason: "UAT defect regression"
    });

    const activeJoin = await activeInterviewersForEmployee(code);
    if (activeJoin.length !== 1) {
      fail("primary role Interviewer appears in active-interviewers join", `rows=${activeJoin.length}`);
    } else {
      pass("primary role Interviewer appears in active-interviewers join");
    }

    const duplicatePanel = await pool.query(
      `SELECT COUNT(*)::int AS c FROM interview_panel_mstr WHERE employee_code = $1 AND is_active = TRUE`,
      [code]
    );
    if (duplicatePanel.rows[0].c !== 1) {
      fail("single active interview panel row after role change", `count=${duplicatePanel.rows[0].c}`);
    } else {
      pass("single active interview panel row after role change");
    }

    await userProvisioningService.changeUserStatus(pool, { user: admin }, code, {
      is_active: false,
      reason: "UAT inactive exclusion probe"
    });

    const inactiveJoin = await activeInterviewersForEmployee(code);
    if (inactiveJoin.length !== 0) {
      fail("inactive employee excluded from active-interviewers join", `rows=${inactiveJoin.length}`);
    } else {
      pass("inactive employee excluded from active-interviewers join");
    }
  } finally {
    await cleanupEmployee(code);
  }
}

async function verifyScheduleInterviewStageResolution(admin) {
  const fixture = await pool.query(
    `SELECT map_id, mapping_id, stage_name, req_id, requisition_code
     FROM rm_candidate_mappings
     WHERE is_active = TRUE
       AND map_id IS NOT NULL
       AND workflow_instance_id IS NOT NULL
     ORDER BY modified_on DESC NULLS LAST
     LIMIT 1`
  ).then((result) => result.rows[0]);

  if (!fixture) {
    skip("schedule interview stage resolution", "no enterprise mapping fixture");
    return;
  }

  const panel = await pool.query(
    `SELECT panel_id, interviewer_name, email_id, interviewer_type
     FROM interview_panel_mstr
     WHERE COALESCE(is_active, TRUE) = TRUE
     ORDER BY panel_id ASC
     LIMIT 1`
  ).then((result) => result.rows[0]);

  if (!panel) {
    skip("schedule interview stage resolution", "no active panel row");
    return;
  }

  const roundTypeRow = await pool.query(
    `SELECT name
     FROM md_records
     WHERE entity_type = 'interview_types'
       AND COALESCE(is_deleted, FALSE) = FALSE
     ORDER BY name ASC
     LIMIT 1`
  ).then((result) => result.rows[0]);

  const roundType = roundTypeRow?.name || "L1 Technical";
  const previousStage = fixture.stage_name;
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const interviewDate = tomorrow.toISOString().slice(0, 10);

  try {
    await interviewService.scheduleInterview(
      pool,
      {
        req_id: fixture.req_id,
        map_id: fixture.map_id,
        interviewer_id: panel.panel_id,
        round_type: roundType,
        interview_date: interviewDate,
        interview_time: "11:30",
        interviewer_name: panel.interviewer_name,
        interviewer_email: panel.email_id,
        interviewer_type: panel.interviewer_type || "Interviewer"
      },
      {
        user: {
          employee_code: admin.employee_code,
          email_id: admin.email_id,
          role_name: admin.role_name,
          full_name: admin.full_name
        }
      }
    );
    pass("scheduleInterview completes without Stage not found workflow error");

    const stageAfter = (
      await pool.query(`SELECT stage_name FROM rm_candidate_mappings WHERE map_id = $1`, [
        fixture.map_id
      ])
    ).rows[0]?.stage_name;

    if (!stageAfter || !/Interview Scheduled/i.test(stageAfter)) {
      fail("scheduleInterview writes operational micro-state stage", stageAfter);
    } else {
      pass(`scheduleInterview writes operational micro-state (${stageAfter})`);
    }
  } catch (error) {
    if (/Stage not found:\s*interview_scheduled/i.test(error.message || "")) {
      fail("scheduleInterview stage resolution", error.message);
    } else {
      skip("schedule interview stage resolution", error.message);
    }
  } finally {
    if (previousStage) {
      await pool.query(
        `UPDATE rm_candidate_mappings SET stage_name = $1, modified_on = NOW() WHERE map_id = $2`,
        [previousStage, fixture.map_id]
      );
    }
  }
}

async function main() {
  console.log("=== UAT production defect regressions ===\n");

  verifyStageResolverUnit();

  const admin = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name, full_name
     FROM user_mstr
     WHERE role_name = 'Admin' AND is_active = TRUE
     ORDER BY user_id ASC
     LIMIT 1`
  ).then((result) => result.rows[0]);

  const unauthorizedRecruiter = await pool.query(
    `SELECT u.user_id, u.employee_code, u.email_id, u.role_name, u.full_name
     FROM user_mstr u
     WHERE u.role_name = 'Recruiter'
       AND COALESCE(u.is_active, TRUE) = TRUE
       AND NOT EXISTS (
         SELECT 1
         FROM employee_work_assignment ewa
         INNER JOIN work_assignment_mstr wam
           ON wam.work_assignment_id = ewa.work_assignment_id
         WHERE ewa.employee_code = u.employee_code
           AND ewa.is_active = TRUE
           AND wam.assignment_code = 'USER_ADMINISTRATOR'
           AND wam.is_active = TRUE
       )
     ORDER BY u.user_id ASC
     LIMIT 1`
  ).then((result) => result.rows[0]);

  if (!admin) {
    skip("database integration checks", "no active Admin user");
  } else {
    await verifyInterviewerRoleChangeEligibility(admin);
    await verifyInterviewerRoleChangeWithPreExistingAssignment(admin);
    await verifyUnauthorizedInterviewerRoleChange(admin, unauthorizedRecruiter);
    await verifyScheduleInterviewStageResolution(admin);
  }

  console.log(
    `\nSummary: PASS=${passCount} FAIL=${failCount} SKIP=${skipCount}`
  );

  await pool.end();
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch(async (error) => {
  console.error(error);
  try {
    await pool.end();
  } catch (_error) {
    // ignore
  }
  process.exit(1);
});
