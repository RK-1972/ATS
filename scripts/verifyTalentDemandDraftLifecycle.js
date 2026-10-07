/**
 * Talent Demand Draft lifecycle verification.
 * Run: node scripts/verifyTalentDemandDraftLifecycle.js
 */
require("dotenv").config();

const { Pool } = require("pg");
const talentDemandDraftService = require("../services/talentDemandDraftService");
const talentDemandSubmitService = require("../services/talentDemandSubmitService");

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

function mockUser(row) {
  return {
    user_id: row.user_id,
    employee_code: row.employee_code,
    email_id: row.email_id,
    role_name: row.role_name,
    secondary_role: row.secondary_role || null,
    full_name: row.full_name || row.employee_code
  };
}

function mockReq(userRow) {
  const user = mockUser(userRow);
  return { user };
}

async function resolveRequestor() {
  const assigned = await pool.query(
    `SELECT u.user_id, u.employee_code, u.email_id, u.role_name, u.secondary_role, u.full_name
     FROM employee_work_assignment ewa
     INNER JOIN work_assignment_mstr wam
       ON wam.work_assignment_id = ewa.work_assignment_id
     INNER JOIN user_mstr u ON u.employee_code = ewa.employee_code
     WHERE ewa.is_active = TRUE
       AND wam.assignment_code = 'REQUISITION_REQUESTOR'
       AND COALESCE(u.is_active, TRUE) = TRUE
     ORDER BY ewa.employee_work_assignment_id
     LIMIT 1`
  );

  if (assigned.rows[0]) {
    return assigned.rows[0];
  }

  const admin = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name, secondary_role, full_name
     FROM user_mstr
     WHERE role_name = 'Admin' AND COALESCE(is_active, TRUE) = TRUE
     ORDER BY user_id ASC
     LIMIT 1`
  );

  return admin.rows[0] || null;
}

async function resolveForeignRecruiter(excludeCode) {
  const result = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name, secondary_role, full_name
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

async function findAvailableApprovedPosition(client) {
  const result = await client.query(
    `SELECT position_id, position_title, status
     FROM wp_approved_positions
     WHERE COALESCE(status, '') <> 'Fully Utilized'
       AND NOT EXISTS (
         SELECT 1
         FROM rm_requisitions r
         WHERE r.approved_position_id = wp_approved_positions.position_id
       )
     ORDER BY modified_on DESC NULLS LAST, position_id DESC
     LIMIT 1`
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  return {
    id: row.position_id,
    position_title: row.position_title,
    title: row.position_title,
    status: row.status
  };
}

async function bootstrapVerificationApprovedPosition(client) {
  const template = await client.query(
    `SELECT department, grade
     FROM wp_approved_positions
     WHERE department IS NOT NULL
       AND grade IS NOT NULL
     ORDER BY modified_on DESC NULLS LAST
     LIMIT 1`
  );
  const department = template.rows[0]?.department;
  const grade = template.rows[0]?.grade;

  if (!department || !grade) {
    return null;
  }

  const positionId = `TD-D1-${Date.now()}`;
  await client.query(
    `INSERT INTO wp_approved_positions (
      position_id,
      department,
      position_title,
      grade,
      headcount,
      budget_approved,
      budget_consumed,
      remaining_budget,
      status
    ) VALUES ($1, $2, $3, $4, $5, $6, 0, $6, 'Active')`,
    [positionId, department, "D1 Draft Lifecycle Verify", grade, 1, 1000000]
  );

  return {
    id: positionId,
    position_title: "D1 Draft Lifecycle Verify",
    title: "D1 Draft Lifecycle Verify",
    status: "Active",
    bootstrapped: true
  };
}

async function resolveRequisitionApprovalRoute(client) {
  const route = await client.query(
    `SELECT route_id
     FROM approval_route_mstr
     WHERE LOWER(TRIM(status)) = 'active'
       AND (
         LOWER(TRIM(applies_to)) LIKE '%requisition%'
         OR LOWER(TRIM(applies_to)) LIKE '%talent%'
         OR LOWER(TRIM(applies_to)) LIKE '%demand%'
       )
     ORDER BY route_id
     LIMIT 1`
  );

  return route.rows[0]?.route_id || null;
}

async function resolveSubmitDefaults(client) {
  const city = await client.query(
    `SELECT name FROM md_records
     WHERE entity_type IN ('cities', 'work_locations')
       AND is_deleted = FALSE
     ORDER BY id LIMIT 1`
  );
  const employment = await client.query(
    `SELECT name FROM md_records
     WHERE entity_type = 'employment_types'
       AND is_deleted = FALSE
     ORDER BY id LIMIT 1`
  );
  const priority = await client.query(
    `SELECT name FROM md_records
     WHERE entity_type = 'priorities'
       AND is_deleted = FALSE
     ORDER BY id LIMIT 1`
  );
  const skill = await client.query(
    `SELECT code FROM md_records
     WHERE entity_type = 'skills'
       AND is_deleted = FALSE
       AND LOWER(COALESCE(status, 'active')) = 'active'
       AND LOWER(COALESCE(version_status, 'published')) = 'published'
     ORDER BY id LIMIT 1`
  );

  return {
    primary_skill: skill.rows[0]?.code || "JAVA",
    work_location: city.rows[0]?.name || "Bengaluru",
    employment_type: employment.rows[0]?.name || "Full Time",
    priority_level: priority.rows[0]?.name || "High",
    target_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10)
  };
}

async function countAuditEvents(entityId, eventTypes) {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS c
     FROM md_enterprise_audit
     WHERE entity_id = $1
       AND event_type = ANY($2::text[])`,
    [String(entityId), eventTypes]
  );
  return result.rows[0]?.c || 0;
}

async function main() {
  console.log("=== Talent Demand Draft Lifecycle Verification ===\n");

  const requestor = await resolveRequestor();
  if (!requestor) {
    fail("fixtures", "no REQUISITION_REQUESTOR or Admin user");
    await pool.end();
    return;
  }

  const client = await pool.connect();
  let draftId = null;
  let requisitionCode = null;

  try {
    await client.query(
      `DELETE FROM wp_approved_positions p
       WHERE p.position_id LIKE 'TD-D1-%'
         AND NOT EXISTS (
           SELECT 1
           FROM rm_requisitions r
           WHERE r.approved_position_id = p.position_id
         )`
    );

    let position = await findAvailableApprovedPosition(client);
    const approvalRouteId = await resolveRequisitionApprovalRoute(client);

    if (!position?.id) {
      position = await bootstrapVerificationApprovedPosition(client);
      if (!position?.id) {
        skip("draft submit path", "no eligible approved position and bootstrap template missing");
        return;
      }
      pass(`fixtures: bootstrapped approved position ${position.id}`);
    }

    if (!approvalRouteId) {
      fail("fixtures", "no active requisition approval route");
      return;
    }

    pass(`fixtures: position=${position.id}, route=${approvalRouteId}, requestor=${requestor.employee_code}`);

    const defaults = await resolveSubmitDefaults(client);
    const ownerReq = mockReq(requestor);
    const foreign = await resolveForeignRecruiter(requestor.employee_code);

    const emptyDraft = await talentDemandDraftService.createDraft(
      pool,
      { job_title: "Wave2 Draft Probe" },
      requestor
    );
    draftId = emptyDraft.draft_id;

    try {
      await talentDemandSubmitService.submitDraft(
        pool,
        draftId,
        requestor.employee_code,
        null,
        ownerReq
      );
      fail("submit validation", "expected missing-field rejection");
    } catch (error) {
      if (error.status === 400) {
        pass("submit validation rejects incomplete draft");
      } else {
        fail("submit validation", `${error.status} ${error.message}`);
      }
    }

    const payload = {
      approved_position_id: position.id,
      approval_route_id: approvalRouteId,
      client_id: position.client_id || null,
      client_name: position.client_name || position.client || "Verification Client",
      project_id: position.project_id || null,
      project_name: position.project_name || position.project || "Verification Project",
      job_title: `[WAVE2] ${position.position_title || position.title || "Draft Role"}`,
      job_description: "Talent demand draft lifecycle verification.",
      primary_skill: defaults.primary_skill,
      work_location: defaults.work_location,
      employment_type: defaults.employment_type,
      priority_level: defaults.priority_level,
      target_date: defaults.target_date,
      openings_count: 3,
      experience_min: 2,
      experience_max: 8
    };

    const updated = await talentDemandDraftService.updateDraft(
      pool,
      draftId,
      payload,
      requestor
    );

    if (updated.job_title !== payload.job_title) {
      fail("draft save/edit", "job_title not persisted");
    } else {
      pass("draft save/edit");
    }

    const retrieved = await talentDemandDraftService.getDraft(pool, draftId, requestor);
    if (String(retrieved.approved_position_id) !== String(position.id)) {
      fail("draft retrieve", "approved_position_id mismatch");
    } else {
      pass("draft retrieve");
    }

    const listed = await talentDemandDraftService.listMyDrafts(pool, requestor);
    if (!listed.some((row) => String(row.draft_id) === String(draftId))) {
      fail("draft list owner", "draft missing from owner list");
    } else {
      pass("draft list owner");
    }

    if (foreign) {
      try {
        await talentDemandDraftService.getDraft(pool, draftId, foreign);
        fail("draft authorization", "foreign user read should be denied");
      } catch (error) {
        if (error.status === 403) {
          pass("draft authorization denies foreign read");
        } else {
          fail("draft authorization", `${error.status} ${error.message}`);
        }
      }
    } else {
      skip("draft authorization", "no foreign recruiter fixture");
    }

    const submitResult = await talentDemandSubmitService.submitDraft(
      pool,
      draftId,
      requestor.employee_code,
      updated.row_version,
      ownerReq
    );

    requisitionCode =
      submitResult.requisitionCode ||
      submitResult.requisition_code ||
      submitResult.data?.requisition_code ||
      null;

    if (!requisitionCode) {
      fail("draft submit", "missing requisition code in submit result");
    } else {
      pass(`draft submit creates requisition (${requisitionCode})`);
    }

    const reqNumericRow = await client.query(
      `SELECT headcount, experience_min, experience_max
       FROM rm_requisitions
       WHERE requisition_code = $1
       LIMIT 1`,
      [requisitionCode]
    );
    const reqNumeric = reqNumericRow.rows[0] || {};
    const headcountOk = Number(reqNumeric.headcount) === payload.openings_count;
    const expMinOk = Number(reqNumeric.experience_min) === payload.experience_min;
    const expMaxOk = Number(reqNumeric.experience_max) === payload.experience_max;

    if (!headcountOk || !expMinOk || !expMaxOk) {
      fail(
        "D1 draft fields on rm_requisitions",
        `headcount=${reqNumeric.headcount}, experience_min=${reqNumeric.experience_min}, experience_max=${reqNumeric.experience_max}`
      );
    } else {
      pass("D1 draft openings/experience persisted on rm_requisitions");
    }

    const submittedDraft = await talentDemandDraftService.getDraft(pool, draftId, requestor);
    if (String(submittedDraft.status).toUpperCase() !== "SUBMITTED") {
      fail("draft status after submit", submittedDraft.status);
    } else {
      pass("draft status after submit is SUBMITTED");
    }

    const reqRow = await client.query(
      `SELECT workflow_instance_id, req_status
       FROM rm_requisitions
       WHERE requisition_code = $1
       LIMIT 1`,
      [requisitionCode]
    );

    if (!reqRow.rows[0]?.workflow_instance_id) {
      fail("workflow initiation", "workflow_instance_id missing on requisition");
    } else {
      pass("workflow initiation sets workflow_instance_id");
    }

    const wfTasks = await client.query(
      `SELECT COUNT(*)::int AS c
       FROM wf_tasks
       WHERE instance_id = $1`,
      [reqRow.rows[0].workflow_instance_id]
    );

    if ((wfTasks.rows[0]?.c || 0) < 1) {
      fail("workflow initiation", "no wf_tasks created");
    } else {
      pass("workflow initiation creates approval tasks");
    }

    try {
      await talentDemandDraftService.updateDraft(
        pool,
        draftId,
        { job_title: "Should not update" },
        requestor
      );
      fail("invalid transition", "update after submit should be blocked");
    } catch (error) {
      if (error.status === 400) {
        pass("invalid transition blocks edit after submit");
      } else {
        fail("invalid transition", `${error.status} ${error.message}`);
      }
    }

    try {
      await talentDemandSubmitService.submitDraft(
        pool,
        draftId,
        requestor.employee_code,
        submittedDraft.row_version,
        ownerReq
      );
      fail("duplicate submit", "expected rejection");
    } catch (error) {
      if (error.status === 400 || error.status === 409) {
        pass("duplicate submit rejected");
      } else {
        fail("duplicate submit", `${error.status} ${error.message}`);
      }
    }

    const auditCount = await countAuditEvents(requisitionCode, [
      "RequisitionCreated",
      "RequisitionSubmitted"
    ]);

    if (auditCount < 1) {
      fail("audit evidence", `expected lifecycle audit rows, got ${auditCount}`);
    } else {
      pass(`audit evidence (${auditCount} event(s) for requisition)`);
    }
  } finally {
    client.release();
    await pool.end();
  }

  if (process.exitCode) {
    console.log("\nTalent Demand Draft lifecycle verification completed with failures.");
  } else {
    console.log("\nAll Talent Demand Draft lifecycle checks passed.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
