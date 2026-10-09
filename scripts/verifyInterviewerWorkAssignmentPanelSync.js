/**
 * Regression verification: INTERVIEWER work assignment ↔ interview_panel_mstr sync.
 * Run: node scripts/verifyInterviewerWorkAssignmentPanelSync.js
 */
require("dotenv").config();

const bcrypt = require("bcryptjs");
const { Pool } = require("pg");
const workAssignmentService = require("../services/workAssignmentService");
const userProvisioningService = require("../services/userProvisioningService");
const interviewPanelRegistry = require("../services/interviewPanelRegistryService");

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

const RUN_ID = Date.now();

function pass(label) {
  console.log(`PASS: ${label}`);
}

function fail(label, detail) {
  console.error(`FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
  process.exitCode = 1;
}

async function activeInterviewersForEmployee(pool, employeeCode) {
  const result = await pool.query(
    `SELECT DISTINCT ip.panel_id, u.employee_code
     FROM interview_panel_mstr ip
     INNER JOIN user_mstr u ON ip.user_id = u.user_id
     INNER JOIN employee_work_assignment ewa ON ewa.employee_code = u.employee_code
       AND ewa.is_active = TRUE
     INNER JOIN work_assignment_mstr wa ON wa.work_assignment_id = ewa.work_assignment_id
       AND wa.is_active = TRUE
       AND wa.assignment_code = 'INTERVIEWER'
     WHERE ip.is_active = TRUE
       AND u.employee_code = $1`,
    [employeeCode]
  );
  return result.rows;
}

async function resolveInterviewerWorkAssignmentId(pool) {
  const result = await pool.query(
    `SELECT work_assignment_id
     FROM work_assignment_mstr
     WHERE assignment_code = 'INTERVIEWER' AND is_active = TRUE
     ORDER BY work_assignment_id
     LIMIT 1`
  );
  return result.rows[0]?.work_assignment_id ?? null;
}

async function resolveRecruiterWorkAssignmentId(pool) {
  const result = await pool.query(
    `SELECT work_assignment_id
     FROM work_assignment_mstr
     WHERE assignment_code = 'RECRUITER' AND is_active = TRUE
     ORDER BY work_assignment_id
     LIMIT 1`
  );
  return result.rows[0]?.work_assignment_id ?? null;
}

async function cleanupDisposableEmployee(pool, employeeCode) {
  await pool.query(
    `DELETE FROM employee_work_assignment WHERE employee_code = $1`,
    [employeeCode]
  );
  await pool.query(`DELETE FROM user_status_history WHERE employee_code = $1`, [
    employeeCode
  ]);
  await pool.query(`DELETE FROM user_role_history WHERE employee_code = $1`, [
    employeeCode
  ]);
  await pool.query(`DELETE FROM user_mstr WHERE employee_code = $1`, [employeeCode]);
  await pool.query(
    `UPDATE interview_panel_mstr SET is_active = FALSE WHERE employee_code = $1`,
    [employeeCode]
  );
}

async function main() {
  try {
    await interviewPanelRegistry.assertInterviewPanelSchema(pool);
    pass("interview_panel_mstr schema matches implementation assumptions");
  } catch (error) {
    fail("schema preflight", error.message);
    await pool.end();
    return;
  }

  const interviewerWaId = await resolveInterviewerWorkAssignmentId(pool);
  const recruiterWaId = await resolveRecruiterWorkAssignmentId(pool);

  if (!interviewerWaId) {
    fail("fixture", "INTERVIEWER work_assignment_mstr row not found");
    await pool.end();
    return;
  }

  const existingActive = await pool.query(
    `SELECT u.employee_code, ip.panel_id
     FROM interview_panel_mstr ip
     INNER JOIN user_mstr u ON ip.user_id = u.user_id
     INNER JOIN employee_work_assignment ewa ON ewa.employee_code = u.employee_code
       AND ewa.is_active = TRUE
     INNER JOIN work_assignment_mstr wa ON wa.work_assignment_id = ewa.work_assignment_id
       AND wa.assignment_code = 'INTERVIEWER'
     WHERE ip.is_active = TRUE
     LIMIT 1`
  );

  if (existingActive.rows[0]) {
    const code = existingActive.rows[0].employee_code;
    const rows = await activeInterviewersForEmployee(pool, code);
    if (rows.length === 1) {
      pass("existing interviewer appears in active-interviewers join (Schedule + CoPilot source)");
    } else {
      fail(
        "existing interviewer active-interviewers join",
        `expected 1 row, got ${rows.length} for ${code}`
      );
    }
  } else {
    console.log("SKIP: no pre-existing active interviewer fixture for regression baseline");
  }

  const disposableCode = `VIS${String(RUN_ID).slice(-8)}`;
  const disposableEmail = `verify.iv.sync.${RUN_ID}@optalynx.demo`;
  const passwordHash = await bcrypt.hash("VerifyPass123", 10);

  await cleanupDisposableEmployee(pool, disposableCode);

  await pool.query(
    `INSERT INTO user_mstr (
       employee_code, full_name, email_id, password_hash, role_name, is_active
     ) VALUES ($1, $2, $3, $4, 'Interviewer', TRUE)`,
    [disposableCode, "Verify Interviewer Sync", disposableEmail, passwordHash]
  );

  let panelIdAfterAssign = null;
  let ewaId = null;

  try {
    const assigned = await workAssignmentService.assignWorkAssignment(
      pool,
      disposableCode,
      interviewerWaId,
      new Date().toISOString().slice(0, 10),
      null
    );
    ewaId = assigned.employee_work_assignment_id;

    const panelRows = await pool.query(
      `SELECT panel_id, is_active, interviewer_type
       FROM interview_panel_mstr
       WHERE employee_code = $1`,
      [disposableCode]
    );

    if (panelRows.rows.length !== 1) {
      fail("new INTERVIEWER assignment creates exactly one panel", `count=${panelRows.rows.length}`);
    } else {
      panelIdAfterAssign = panelRows.rows[0].panel_id;
      pass("new INTERVIEWER assignment creates exactly one panel");
    }

    const activeRows = await activeInterviewersForEmployee(pool, disposableCode);
    if (activeRows.length === 1 && Number(activeRows[0].panel_id) === Number(panelIdAfterAssign)) {
      pass("new interviewer appears in active-interviewers join (Regular + CoPilot)");
    } else {
      fail(
        "new interviewer active-interviewers join",
        JSON.stringify(activeRows)
      );
    }

    try {
      await workAssignmentService.assignWorkAssignment(
        pool,
        disposableCode,
        interviewerWaId,
        new Date().toISOString().slice(0, 10),
        null
      );
      fail("repeated INTERVIEWER assignment", "expected 409 conflict");
    } catch (error) {
      if (error.status === 409) {
        const panelAfterDup = await pool.query(
          `SELECT COUNT(*)::int AS c, MIN(panel_id) AS panel_id
           FROM interview_panel_mstr WHERE employee_code = $1`,
          [disposableCode]
        );
        if (
          panelAfterDup.rows[0].c === 1 &&
          Number(panelAfterDup.rows[0].panel_id) === Number(panelIdAfterAssign)
        ) {
          pass("repeated assignment keeps single panel_id (idempotent registry)");
        } else {
          fail("repeated assignment panel_id", JSON.stringify(panelAfterDup.rows[0]));
        }
      } else {
        fail("repeated INTERVIEWER assignment", error.message);
      }
    }

    if (recruiterWaId) {
      await workAssignmentService.assignWorkAssignment(
        pool,
        disposableCode,
        recruiterWaId,
        new Date().toISOString().slice(0, 10),
        null
      );
      const panelUnchanged = await pool.query(
        `SELECT COUNT(*)::int AS c, MIN(panel_id) AS panel_id
         FROM interview_panel_mstr WHERE employee_code = $1`,
        [disposableCode]
      );
      if (
        panelUnchanged.rows[0].c === 1 &&
        Number(panelUnchanged.rows[0].panel_id) === Number(panelIdAfterAssign)
      ) {
        pass("non-INTERVIEWER assignment does not add another panel row");
      } else {
        fail("non-INTERVIEWER side effect", JSON.stringify(panelUnchanged.rows[0]));
      }
      const recruiterEwa = await pool.query(
        `SELECT employee_work_assignment_id
         FROM employee_work_assignment
         WHERE employee_code = $1 AND work_assignment_id = $2
         ORDER BY employee_work_assignment_id DESC LIMIT 1`,
        [disposableCode, recruiterWaId]
      );
      if (recruiterEwa.rows[0]) {
        await workAssignmentService.removeEmployeeWorkAssignment(
          pool,
          recruiterEwa.rows[0].employee_work_assignment_id
        );
      }
    } else {
      console.log("SKIP: RECRUITER work assignment fixture missing");
    }

    await workAssignmentService.removeEmployeeWorkAssignment(pool, ewaId);
    ewaId = null;

    const afterRemoveActive = await activeInterviewersForEmployee(pool, disposableCode);
    const afterRemovePanel = await pool.query(
      `SELECT panel_id, is_active FROM interview_panel_mstr WHERE employee_code = $1`,
      [disposableCode]
    );

    if (afterRemoveActive.length === 0) {
      pass("removing INTERVIEWER removes employee from active-interviewers join");
    } else {
      fail("after remove active-interviewers", JSON.stringify(afterRemoveActive));
    }

    if (
      afterRemovePanel.rows.length === 1 &&
      afterRemovePanel.rows[0].is_active === false
    ) {
      pass("removing INTERVIEWER deactivates panel row without delete");
    } else {
      fail("after remove panel state", JSON.stringify(afterRemovePanel.rows[0]));
    }

    const reassigned = await workAssignmentService.assignWorkAssignment(
      pool,
      disposableCode,
      interviewerWaId,
      new Date().toISOString().slice(0, 10),
      null
    );
    ewaId = reassigned.employee_work_assignment_id;

    const rePanel = await pool.query(
      `SELECT panel_id, is_active FROM interview_panel_mstr WHERE employee_code = $1`,
      [disposableCode]
    );
    const reActive = await activeInterviewersForEmployee(pool, disposableCode);

    if (
      rePanel.rows.length === 1 &&
      Number(rePanel.rows[0].panel_id) === Number(panelIdAfterAssign) &&
      rePanel.rows[0].is_active === true
    ) {
      pass("re-assigning INTERVIEWER reactivates same panel_id");
    } else {
      fail("re-assign panel", JSON.stringify(rePanel.rows[0]));
    }

    if (reActive.length === 1) {
      pass("re-assigning INTERVIEWER restores active-interviewers visibility");
    } else {
      fail("re-assign active-interviewers", JSON.stringify(reActive));
    }
  } finally {
    if (ewaId) {
      await pool.query(
        `DELETE FROM employee_work_assignment WHERE employee_work_assignment_id = $1`,
        [ewaId]
      );
    }
    await cleanupDisposableEmployee(pool, disposableCode);
  }

  const adminUser = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name, full_name
     FROM user_mstr
     WHERE role_name = 'Admin' AND is_active = TRUE
     ORDER BY user_id ASC
     LIMIT 1`
  );

  if (adminUser.rows[0] && interviewerWaId) {
    const provCode = `VIP${String(RUN_ID).slice(-7)}`;
    const provEmail = `verify.iv.prov.${RUN_ID}@optalynx.demo`;
    await cleanupDisposableEmployee(pool, provCode);

    try {
      await userProvisioningService.provisionEmployee(
        pool,
        {
          user: {
            user_id: adminUser.rows[0].user_id,
            employee_code: adminUser.rows[0].employee_code,
            email_id: adminUser.rows[0].email_id,
            role_name: adminUser.rows[0].role_name,
            full_name: adminUser.rows[0].full_name
          }
        },
        {
          employee_code: provCode,
          full_name: "Verify Provision Interviewer",
          email_id: provEmail,
          password: "VerifyPass123",
          role_name: "Interviewer",
          work_assignment_ids: [interviewerWaId]
        }
      );

      const provPanel = await pool.query(
        `SELECT COUNT(*)::int AS c FROM interview_panel_mstr WHERE employee_code = $1 AND is_active = TRUE`,
        [provCode]
      );
      const provActive = await activeInterviewersForEmployee(pool, provCode);

      if (provPanel.rows[0].c === 1 && provActive.length === 1) {
        pass("user provisioning with INTERVIEWER work_assignment_ids syncs panel registry");
      } else {
        fail(
          "provisioning path panel sync",
          `panel=${provPanel.rows[0].c} activeJoin=${provActive.length}`
        );
      }
    } finally {
      await cleanupDisposableEmployee(pool, provCode);
    }
  } else {
    console.log("SKIP: provisioning path (admin or INTERVIEWER master missing)");
  }

  if (!process.exitCode) {
    console.log("\nCOMPLETE: interviewer work assignment panel sync verification passed.");
  } else {
    console.log("\nFAILED: see errors above.");
  }

  await pool.end();
}

main().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
  try {
    await pool.end();
  } catch (_error) {
    // ignore
  }
});
