/**
 * Phase A — Offer approval workflow safety verification.
 * Run: node scripts/verifyOfferApprovalWorkflowSafety.js
 */
require("dotenv").config();

const { Pool } = require("pg");
const offerManagementService = require("../services/offerManagementService");
const recruitmentService = require("../services/recruitmentService");
const workflowService = require("../services/workflowService");
const offerApprovalWorkflowService = require("../services/offerApprovalWorkflowService");
const { assertCanWriteOfferRecord } = require("../services/offerCapabilityAuth");
const { REQUISITION_STATUS } = require("../constants/requisitionStatus");

const RUN_ID = Date.now();

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

function mockReq(user) {
  return {
    user: {
      user_id: user.user_id,
      employee_code: user.employee_code,
      email_id: user.email_id,
      role_name: user.role_name,
      secondary_role: user.secondary_role || null,
      full_name: user.full_name || user.email_id
    }
  };
}

async function resolveOfferWorkspaceRecruiter() {
  const result = await pool.query(
    `SELECT u.user_id, u.employee_code, u.email_id, u.role_name, u.full_name
     FROM user_mstr u
     INNER JOIN employee_work_assignment ewa
       ON ewa.employee_code = u.employee_code AND ewa.is_active = TRUE
     INNER JOIN work_assignment_mstr wam
       ON wam.work_assignment_id = ewa.work_assignment_id AND wam.is_active = TRUE
     WHERE TRIM(COALESCE(wam.workspace_flag, '')) = 'showOfferWorkspace'
       AND u.role_name = 'Recruiter'
       AND COALESCE(u.is_active, TRUE) = TRUE
     ORDER BY u.user_id ASC
     LIMIT 1`
  );
  return result.rows[0] || null;
}

async function resolveTaLeadUser() {
  const result = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name, full_name
     FROM user_mstr
     WHERE role_name IN ('TA Lead', 'TA Leader')
       AND COALESCE(is_active, TRUE) = TRUE
     ORDER BY user_id ASC
     LIMIT 1`
  );
  return result.rows[0] || null;
}

async function resolveOtherOfferWorkspaceRecruiter(excludeCode) {
  const result = await pool.query(
    `SELECT u.user_id, u.employee_code, u.email_id, u.role_name, u.full_name
     FROM user_mstr u
     INNER JOIN employee_work_assignment ewa
       ON ewa.employee_code = u.employee_code AND ewa.is_active = TRUE
     INNER JOIN work_assignment_mstr wam
       ON wam.work_assignment_id = ewa.work_assignment_id AND wam.is_active = TRUE
     WHERE TRIM(COALESCE(wam.workspace_flag, '')) = 'showOfferWorkspace'
       AND u.role_name = 'Recruiter'
       AND u.employee_code <> $1
       AND COALESCE(u.is_active, TRUE) = TRUE
     ORDER BY u.user_id ASC
     LIMIT 1`,
    [excludeCode]
  );
  return result.rows[0] || null;
}

async function resolveValidGrade() {
  const result = await pool.query(
    `SELECT name FROM md_records
     WHERE entity_type = 'grades' AND COALESCE(is_deleted, FALSE) = FALSE
     ORDER BY name ASC LIMIT 1`
  );
  return result.rows[0]?.name || "L4";
}

async function allocateReqId() {
  const result = await pool.query(
    `SELECT GREATEST(
      COALESCE((SELECT MAX(req_id) FROM rm_requisitions WHERE req_id IS NOT NULL), 0),
      COALESCE((SELECT MAX(req_id) FROM req_mstr), 0)
    ) + 1 AS next_id`
  );
  return result.rows[0].next_id;
}

async function createDisposableSubmittedOffer(recruiter, recruiterReq, adminReq, suffix) {
  const requisitionCode = `REQ-OA-${String(RUN_ID).slice(-8)}-${suffix}`;
  const reqId = await allocateReqId();
  const grade = await resolveValidGrade();

  await pool.query(
    `INSERT INTO rm_requisitions (
      requisition_code, req_id, position_title, department, grade, headcount, req_status,
      budget_approved, created_by, modified_by
    ) VALUES ($1, $2, $3, 'Offer Workspace QA', $4, 1, $5, 1500000, 'Phase A Verify', 'Phase A Verify')`,
    [
      requisitionCode,
      reqId,
      `Phase A ${suffix}`,
      grade,
      REQUISITION_STATUS.APPROVED
    ]
  );

  const reqMstrExists = await pool.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'req_mstr'
     ) AS exists`
  );
  if (reqMstrExists.rows[0]?.exists) {
    await pool.query(
      `INSERT INTO req_mstr (
        req_id, req_code, client_name, project_name, job_title, job_description,
        openings_count, req_status, created_by
      ) VALUES ($1, $2, 'Phase A', 'Offer Workspace QA', $3, 'Disposable requisition', 1, $4, 'Phase A Verify')
      ON CONFLICT (req_id) DO NOTHING`,
      [reqId, requisitionCode.replace(/^REQ-/, "REQ"), `Phase A ${suffix}`, REQUISITION_STATUS.APPROVED]
    );
  }

  await recruitmentService.assignRecruiter(
    pool,
    requisitionCode,
    recruiter.employee_code,
    adminReq
  );

  const candidateInsert = await pool.query(
    `INSERT INTO cand_mstr (
      first_name, last_name, email_id, mobile_number, primary_skill,
      total_experience, candidate_status, created_by
    ) VALUES ('PhaseA', $1, $2, '9876500011', 'Java', 4, 'Applied', 'Phase A Verify')
    RETURNING candidate_id`,
    [suffix, `phasea.${RUN_ID}.${suffix}@example.com`]
  );
  const candidateId = candidateInsert.rows[0].candidate_id;

  const mapped = await recruitmentService.mapCandidate(
    pool,
    {
      candidate_id: candidateId,
      requisition_code: requisitionCode,
      stage_name: "Applied",
      source_type: "Direct"
    },
    recruiterReq
  );
  const mapping = mapped.mapping || mapped;
  const mapId = mapping.map_id || mapping.mapping_id;

  const created = await offerManagementService.createOffer(pool, {
    requisition_code: requisitionCode,
    mapping_id: mapId,
    candidate_id: candidateId,
    candidate_name: `Phase A Candidate ${suffix}`,
    offered_ctc: 1400000,
    approved_budget: 1500000,
    grade,
    department: "Offer Workspace QA",
    expected_joining_date: new Date(Date.now() + 86400000 * 14).toISOString().slice(0, 10)
  }, recruiterReq);

  const offerId = created.offer?.offerId;
  const offer = created.offer;
  const instanceId = offer.workflowInstanceId;
  const version = Number(offer.version || 1);
  const stepTitle = `Approval Step 1 — ${offerId}`;

  const executionContext = {
    meta: {
      document_type: "OFFER",
      offer_id: offerId,
      ...offerApprovalWorkflowService.buildSubmissionVersionMetaPatch(version)
    }
  };

  await pool.query(
    `UPDATE wf_instances
     SET execution_context = $1, modified_on = NOW()
     WHERE instance_id = $2`,
    [JSON.stringify(executionContext), instanceId]
  );

  await pool.query(
    `UPDATE om_offers
     SET offer_status = 'Pending Approval', modified_on = NOW()
     WHERE offer_id = $1`,
    [offerId]
  );

  await pool.query(
    `INSERT INTO om_offer_approvals (
      offer_id, approval_step, approver_role, approval_status, sequence_order, effective_from
    ) VALUES ($1, $2, 'Approver', 'Pending', 1, NOW())`,
    [offerId, stepTitle]
  );

  const taskId = await workflowService.createTask(pool, instanceId, {
    stageKey: "approval",
    taskType: "approval",
    title: stepTitle,
    status: "Pending",
    assignee: recruiter.employee_code,
    assigneeRole: "Approver",
    assignedBy: "Phase A Verify",
    assignmentActive: true
  });

  await pool.query(
    `INSERT INTO om_offer_approvals (
      offer_id, approval_step, approver_role, approval_status, sequence_order, effective_from
    ) VALUES ($1, $2, 'Approver', 'Waiting', 2, NOW())`,
    [offerId, `Approval Step 2 — ${offerId}`]
  );

  await workflowService.createTask(pool, instanceId, {
    stageKey: "approval",
    taskType: "approval",
    title: `Approval Step 2 — ${offerId}`,
    status: "Waiting",
    assignee: recruiter.employee_code,
    assigneeRole: "Approver",
    assignedBy: "Phase A Verify",
    assignmentActive: false
  });

  return { offerId, taskId, stepTitle, instanceId, version };
}

async function resolveSubmittedOfferFixture(recruiter, recruiterReq, adminReq, suffix = "x") {
  const built = await createDisposableSubmittedOffer(
    recruiter,
    recruiterReq,
    adminReq,
    suffix
  );

  return {
    offerId: built.offerId,
    workflowInstanceId: built.instanceId,
    version: built.version,
    approvalStep: built.stepTitle,
    taskId: built.taskId,
    assigneeCode: recruiter.employee_code
  };
}

async function resolveUserByEmployeeCode(code) {
  const result = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name, full_name
     FROM user_mstr WHERE employee_code = $1 LIMIT 1`,
    [code]
  );
  return result.rows[0] || null;
}

async function cleanupOffer(offerId) {
  if (!offerId) {
    return;
  }
  const reqRow = await pool.query(
    `SELECT requisition_code FROM om_offers WHERE offer_id = $1`,
    [offerId]
  );
  const requisitionCode = reqRow.rows[0]?.requisition_code;
  const letter = await pool.query(
    `SELECT letter_id FROM om_offer_letters WHERE offer_id = $1`,
    [offerId]
  );
  for (const row of letter.rows) {
    await pool.query(`DELETE FROM om_offer_letter_ctc WHERE letter_id = $1`, [row.letter_id]);
  }
  await pool.query(`DELETE FROM om_offer_letters WHERE offer_id = $1`, [offerId]);
  await pool.query(`DELETE FROM om_offer_history WHERE offer_id = $1`, [offerId]);
  await pool.query(`DELETE FROM om_offer_approvals WHERE offer_id = $1`, [offerId]);
  await pool.query(`DELETE FROM om_offer_compensation WHERE offer_id = $1`, [offerId]);
  await pool.query(`DELETE FROM om_offer_acceptance WHERE offer_id = $1`, [offerId]);
  await pool.query(
    `DELETE FROM et_task_history WHERE task_id IN (
       SELECT task_id FROM et_tasks WHERE business_object_id = $1
     )`,
    [offerId]
  ).catch(() => undefined);
  await pool.query(`DELETE FROM et_tasks WHERE business_object_id = $1`, [offerId]).catch(() => undefined);
  const inst = await pool.query(
    `SELECT workflow_instance_id FROM om_offers WHERE offer_id = $1`,
    [offerId]
  );
  const instanceId = inst.rows[0]?.workflow_instance_id;
  if (instanceId) {
    await pool.query(`DELETE FROM wf_assignments WHERE task_id IN (SELECT task_id FROM wf_tasks WHERE instance_id = $1)`, [instanceId]);
    await pool.query(`DELETE FROM wf_tasks WHERE instance_id = $1`, [instanceId]);
    await pool.query(`DELETE FROM wf_history WHERE instance_id = $1`, [instanceId]);
    await pool.query(`DELETE FROM wf_instances WHERE instance_id = $1`, [instanceId]);
  }
  await pool.query(`DELETE FROM om_offers WHERE offer_id = $1`, [offerId]);

  if (requisitionCode) {
    await pool.query(
      `DELETE FROM rm_candidate_mappings WHERE requisition_code = $1`,
      [requisitionCode]
    ).catch(() => undefined);
    await pool.query(
      `DELETE FROM rm_recruiter_assignments WHERE requisition_code = $1`,
      [requisitionCode]
    ).catch(() => undefined);
    await pool.query(
      `DELETE FROM rm_requisitions WHERE requisition_code = $1`,
      [requisitionCode]
    ).catch(() => undefined);
  }
}

async function main() {
  console.log("=== Offer Approval Workflow Safety (Phase A) ===\n");

  const recruiter = await resolveOfferWorkspaceRecruiter();
  if (!recruiter) {
    fail("fixtures", "Recruiter with showOfferWorkspace required");
    await pool.end();
    return;
  }

  const admin = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name, full_name
     FROM user_mstr
     WHERE role_name = 'Admin' AND COALESCE(is_active, TRUE) = TRUE
     ORDER BY user_id ASC LIMIT 1`
  ).then((result) => result.rows[0]);

  if (!admin) {
    fail("fixtures", "Admin user required for disposable requisition setup");
    await pool.end();
    return;
  }

  const recruiterReq = mockReq(recruiter);
  const adminReq = mockReq(admin);
  const otherRecruiter = await resolveOtherOfferWorkspaceRecruiter(recruiter.employee_code);

  const versionFixture = await resolveSubmittedOfferFixture(
    recruiter,
    recruiterReq,
    adminReq,
    "ver"
  );
  if (!versionFixture?.offerId) {
    fail("fixtures", "Could not create version-check offer");
    await pool.end();
    return;
  }

  const approverUser = await resolveUserByEmployeeCode(versionFixture.assigneeCode);
  const approverReq = approverUser ? mockReq(approverUser) : recruiterReq;

  const contextRow = await pool.query(
    `SELECT execution_context FROM wf_instances WHERE instance_id = $1`,
    [versionFixture.workflowInstanceId]
  );
  const submissionVersion = offerApprovalWorkflowService.readSubmissionVersionFromContext(
    contextRow.rows[0]?.execution_context
  );
  if (submissionVersion === versionFixture.version) {
    pass("submission version present in workflow context");
  } else {
    fail(
      "submission version present in workflow context",
      `context=${submissionVersion} offer.version=${versionFixture.version}`
    );
  }
  await cleanupOffer(versionFixture.offerId);

  console.log("\n--- Write authorization ---");

  const authFixture = await resolveSubmittedOfferFixture(
    recruiter,
    recruiterReq,
    adminReq,
    "auth"
  );
  try {
    await assertCanWriteOfferRecord(pool, recruiterReq, authFixture.offerId);
    pass("write auth: assigned recruiter allowed");
  } catch (error) {
    fail("write auth: assigned recruiter allowed", error.message);
  }

  if (otherRecruiter) {
    try {
      await assertCanWriteOfferRecord(
        pool,
        mockReq(otherRecruiter),
        authFixture.offerId
      );
      fail("write auth: other workspace recruiter", "expected throw");
    } catch (error) {
      if (error.status === 403) {
        pass("write auth: other workspace recruiter denied (403)");
      } else {
        fail("write auth: other workspace recruiter", `status=${error.status}`);
      }
    }
  } else {
    fail("write auth: other workspace recruiter", "no second recruiter fixture");
  }

  await pool.query(
    `UPDATE rm_recruiter_assignments
     SET is_active = FALSE
     WHERE requisition_code = (
       SELECT requisition_code FROM om_offers WHERE offer_id = $1
     )
       AND recruiter_code = $2`,
    [authFixture.offerId, recruiter.employee_code]
  );
  try {
    await assertCanWriteOfferRecord(pool, recruiterReq, authFixture.offerId);
    fail("write auth: unassigned creator", "expected throw");
  } catch (error) {
    if (error.status === 403) {
      pass("write auth: unassigned former assignee denied (403)");
    } else {
      fail("write auth: unassigned former assignee", `status=${error.status}`);
    }
  }
  await cleanupOffer(authFixture.offerId);

  console.log("\n--- Approval guards ---");

  const validFixture = await resolveSubmittedOfferFixture(
    recruiter,
    recruiterReq,
    adminReq,
    "valid"
  );
  try {
    await offerManagementService.approveOffer(
      pool,
      validFixture.offerId,
      validFixture.approvalStep,
      "Phase A valid approve",
      approverReq
    );
    pass("valid current-version approveOffer succeeds");
  } catch (error) {
    fail("valid current-version approveOffer succeeds", error.message);
  }
  await cleanupOffer(validFixture.offerId);

  const withdrawnOffer = await resolveSubmittedOfferFixture(
    recruiter,
    recruiterReq,
    adminReq,
    "withdrawn"
  );
  await pool.query(
    `UPDATE om_offers SET offer_status = 'Withdrawn', modified_on = NOW() WHERE offer_id = $1`,
    [withdrawnOffer.offerId]
  );
  try {
    await offerManagementService.approveOffer(
      pool,
      withdrawnOffer.offerId,
      withdrawnOffer.approvalStep,
      "should fail",
      approverReq
    );
    fail("approve withdrawn offer", "expected throw");
  } catch (error) {
    if (error.status === 409) {
      pass("approve withdrawn offer rejected (409)");
    } else {
      fail("approve withdrawn offer", `status=${error.status} ${error.message}`);
    }
  }
  await cleanupOffer(withdrawnOffer.offerId);

  const staleFixture = await resolveSubmittedOfferFixture(
    recruiter,
    recruiterReq,
    adminReq,
    "stale"
  );
  await pool.query(
    `UPDATE om_offers SET version = version + 0.1, modified_on = NOW() WHERE offer_id = $1`,
    [staleFixture.offerId]
  );
  try {
    await offerManagementService.approveOffer(
      pool,
      staleFixture.offerId,
      staleFixture.approvalStep,
      "stale",
      approverReq
    );
    fail("stale submission approve", "expected throw");
  } catch (error) {
    if (error.status === 409) {
      pass("stale submission approve rejected (409)");
    } else {
      fail("stale submission approve", `status=${error.status} ${error.message}`);
    }
  }
  await cleanupOffer(staleFixture.offerId);

  console.log("\n--- Workflow completeTask path ---");

  const wfFixture = await resolveSubmittedOfferFixture(
    recruiter,
    recruiterReq,
    adminReq,
    "wf"
  );
  try {
    await workflowService.approveMyActiveApproval(pool, wfFixture.taskId, approverReq);
    pass("workflow approveMyActiveApproval on current submission");
  } catch (error) {
    fail("workflow approveMyActiveApproval on current submission", error.message);
  }
  await cleanupOffer(wfFixture.offerId);

  const staleWf = await resolveSubmittedOfferFixture(
    recruiter,
    recruiterReq,
    adminReq,
    "stalewf"
  );
  await pool.query(
    `UPDATE om_offers SET version = version + 0.1, modified_on = NOW() WHERE offer_id = $1`,
    [staleWf.offerId]
  );
  try {
    await workflowService.approveMyActiveApproval(pool, staleWf.taskId, approverReq);
    fail("workflow stale approve", "expected throw");
  } catch (error) {
    if (error.status === 409) {
      pass("workflow stale approve rejected (409)");
    } else {
      fail("workflow stale approve", `status=${error.status} ${error.message}`);
    }
  }
  await cleanupOffer(staleWf.offerId);

  console.log("\n--- Paused workflow guards ---");

  const pauseFixture = await resolveSubmittedOfferFixture(
    recruiter,
    recruiterReq,
    adminReq,
    "pause"
  );
  await pool.query(
    `UPDATE wf_instances SET status = 'Paused', modified_on = NOW() WHERE instance_id = $1`,
    [pauseFixture.workflowInstanceId]
  );
  try {
    await offerManagementService.approveOffer(
      pool,
      pauseFixture.offerId,
      pauseFixture.approvalStep,
      "paused",
      approverReq
    );
    fail("approveOffer on paused workflow", "expected throw");
  } catch (error) {
    if (error.status === 409) {
      pass("approveOffer on paused workflow rejected (409)");
    } else {
      fail("approveOffer on paused workflow", `status=${error.status} ${error.message}`);
    }
  }
  try {
    await workflowService.approveMyActiveApproval(
      pool,
      pauseFixture.taskId,
      approverReq
    );
    fail("completeTask on paused workflow", "expected throw");
  } catch (error) {
    if (error.status === 409) {
      pass("completeTask on paused workflow rejected (409)");
    } else {
      fail("completeTask on paused workflow", `status=${error.status} ${error.message}`);
    }
  }
  await cleanupOffer(pauseFixture.offerId);

  console.log("\n--- Sequential multi-step approval ---");

  const multiFixture = await resolveSubmittedOfferFixture(
    recruiter,
    recruiterReq,
    adminReq,
    "multi"
  );
  const step2Title = `Approval Step 2 — ${multiFixture.offerId}`;

  try {
    await offerManagementService.approveOffer(
      pool,
      multiFixture.offerId,
      multiFixture.approvalStep,
      "step 1 approveOffer",
      approverReq
    );
    pass("multi-step: approveOffer step 1 succeeds");
  } catch (error) {
    fail("multi-step: approveOffer step 1", error.message);
  }

  const afterStep1 = await pool.query(
    `SELECT offer_status FROM om_offers WHERE offer_id = $1`,
    [multiFixture.offerId]
  );
  const instanceAfterStep1 = await pool.query(
    `SELECT status FROM wf_instances WHERE instance_id = $1`,
    [multiFixture.workflowInstanceId]
  );
  if (String(instanceAfterStep1.rows[0]?.status) === "Running") {
    pass("multi-step: workflow instance stays Running after step 1");
  } else {
    fail(
      "multi-step: workflow instance stays Running after step 1",
      `status=${instanceAfterStep1.rows[0]?.status}`
    );
  }

  if (afterStep1.rows[0]?.offer_status === "Pending Approval") {
    pass("multi-step: offer remains Pending Approval after step 1");
  } else {
    fail(
      "multi-step: offer remains Pending Approval after step 1",
      `status=${afterStep1.rows[0]?.offer_status}`
    );
  }

  const step2Task = await pool.query(
    `SELECT t.task_id, t.status
     FROM wf_tasks t
     WHERE t.instance_id = $1 AND t.title = $2`,
    [multiFixture.workflowInstanceId, step2Title]
  );
  if (String(step2Task.rows[0]?.status) === "Pending") {
    pass("multi-step: step 2 wf task activated to Pending");
  } else {
    fail(
      "multi-step: step 2 wf task activated",
      `status=${step2Task.rows[0]?.status || "missing"}`
    );
  }

  const step2Mirror = await pool.query(
    `SELECT approval_status FROM om_offer_approvals
     WHERE offer_id = $1 AND approval_step = $2`,
    [multiFixture.offerId, step2Title]
  );
  if (String(step2Mirror.rows[0]?.approval_status) === "Pending") {
    pass("multi-step: step 2 mirror row Pending");
  } else {
    fail(
      "multi-step: step 2 mirror row",
      `status=${step2Mirror.rows[0]?.approval_status || "missing"}`
    );
  }

  try {
    await offerManagementService.approveOffer(
      pool,
      multiFixture.offerId,
      step2Title,
      "step 2 approveOffer",
      approverReq
    );
    pass("multi-step: approveOffer step 2 succeeds");
  } catch (error) {
    fail("multi-step: approveOffer step 2", error.message);
  }

  const finalOffer = await pool.query(
    `SELECT offer_status FROM om_offers WHERE offer_id = $1`,
    [multiFixture.offerId]
  );
  if (finalOffer.rows[0]?.offer_status === "Approved") {
    pass("multi-step: offer Approved after step 2");
  } else {
    fail(
      "multi-step: final offer status",
      `status=${finalOffer.rows[0]?.offer_status}`
    );
  }

  const instanceAfterStep2 = await pool.query(
    `SELECT status, completed_on FROM wf_instances WHERE instance_id = $1`,
    [multiFixture.workflowInstanceId]
  );
  if (String(instanceAfterStep2.rows[0]?.status) === "Completed") {
    pass("multi-step: workflow instance Completed after final step");
  } else {
    fail(
      "multi-step: workflow instance Completed after final step",
      `status=${instanceAfterStep2.rows[0]?.status}`
    );
  }

  const letterRows = await pool.query(
    `SELECT COUNT(*)::int AS count FROM om_offer_letters WHERE offer_id = $1`,
    [multiFixture.offerId]
  );
  if (Number(letterRows.rows[0]?.count || 0) === 1) {
    pass("multi-step: single awaiting-letter row after final approval");
  } else {
    fail(
      "multi-step: awaiting-letter row count",
      `count=${letterRows.rows[0]?.count}`
    );
  }

  await cleanupOffer(multiFixture.offerId);

  console.log("\n--- Linked et_task approval (A.2) ---");

  const etFixture = await resolveSubmittedOfferFixture(
    recruiter,
    recruiterReq,
    adminReq,
    "et"
  );
  const etInsert = await pool.query(
    `INSERT INTO et_tasks (
      module, task_type, title, status, assignee, assignee_role,
      workflow_instance_id, workflow_task_id, business_object_type, business_object_id,
      created_by, effective_from
    ) VALUES (
      'Offer Management', $1, $2, 'Pending', $3, 'Approver',
      $4, $5, 'Offer', $6, 'Phase A Verify', NOW()
    ) RETURNING task_id`,
    [
      etFixture.approvalStep,
      `Inbox mirror ${etFixture.approvalStep}`,
      etFixture.assigneeCode,
      etFixture.workflowInstanceId,
      etFixture.taskId,
      etFixture.offerId
    ]
  );

  try {
    await offerManagementService.approveOffer(
      pool,
      etFixture.offerId,
      etFixture.approvalStep,
      "et_task linked approve",
      approverReq
    );
    pass("linked et_task: approveOffer succeeds without wf double-complete");
  } catch (error) {
    fail("linked et_task: approveOffer", error.message);
  }

  const wfAfterEt = await pool.query(
    `SELECT status FROM wf_tasks WHERE task_id = $1`,
    [etFixture.taskId]
  );
  if (String(wfAfterEt.rows[0]?.status) === "Completed") {
    pass("linked et_task: route wf_task Completed once");
  } else {
    fail("linked et_task: route wf_task status", `status=${wfAfterEt.rows[0]?.status}`);
  }

  const etAfter = await pool.query(
    `SELECT status FROM et_tasks WHERE task_id = $1`,
    [etInsert.rows[0].task_id]
  );
  if (String(etAfter.rows[0]?.status) === "Completed") {
    pass("linked et_task: inbox et_task Completed");
  } else {
    fail("linked et_task: inbox status", `status=${etAfter.rows[0]?.status}`);
  }

  await cleanupOffer(etFixture.offerId);

  const multiCtFixture = await resolveSubmittedOfferFixture(
    recruiter,
    recruiterReq,
    adminReq,
    "mct"
  );
  const step2CtTitle = `Approval Step 2 — ${multiCtFixture.offerId}`;
  try {
    await workflowService.approveMyActiveApproval(
      pool,
      multiCtFixture.taskId,
      approverReq
    );
    pass("multi-step completeTask: step 1 succeeds");
  } catch (error) {
    fail("multi-step completeTask: step 1", error.message);
  }
  const step2CtTask = await pool.query(
    `SELECT task_id FROM wf_tasks
     WHERE instance_id = $1 AND title = $2 AND LOWER(status) = 'pending'`,
    [multiCtFixture.workflowInstanceId, step2CtTitle]
  );
  const step2CtTaskId = step2CtTask.rows[0]?.task_id;
  if (step2CtTaskId) {
    pass("multi-step completeTask: step 2 task actionable");
    try {
      await workflowService.approveMyActiveApproval(pool, step2CtTaskId, approverReq);
      pass("multi-step completeTask: step 2 succeeds");
    } catch (error) {
      fail("multi-step completeTask: step 2", error.message);
    }
  } else {
    fail("multi-step completeTask: step 2 task actionable", "no pending step 2 task");
  }
  await cleanupOffer(multiCtFixture.offerId);

  console.log("\n--- Cancellation helper ---");

  const cancelFixture = await resolveSubmittedOfferFixture(
    recruiter,
    recruiterReq,
    adminReq,
    "cancel"
  );
  await pool.query(
    `INSERT INTO om_offer_approvals (
      offer_id, approval_step, approver_role, approver_name, approval_status, sequence_order, effective_from
    ) VALUES ($1, 'Seed Completed Step', 'Approver', 'Phase A Seed', 'Approved', 0, NOW())`,
    [cancelFixture.offerId]
  );

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await offerApprovalWorkflowService.cancelPendingOfferApprovalWork(
      client,
      {
        offerId: cancelFixture.offerId,
        instanceId: cancelFixture.workflowInstanceId
      },
      recruiterReq
    );
    await client.query("COMMIT");

    if (result.cancelledTaskIds.length > 0) {
      pass(`cancel helper invalidated ${result.cancelledTaskIds.length} wf task(s)`);
    } else {
      fail("cancel helper wf tasks", "expected at least one cancelled task");
    }

    const approvedPreserved = await pool.query(
      `SELECT approval_status
       FROM om_offer_approvals
       WHERE offer_id = $1 AND approval_step = 'Seed Completed Step'`,
      [cancelFixture.offerId]
    );
    if (approvedPreserved.rows[0]?.approval_status === "Approved") {
      pass("cancel helper preserves seeded Approved row");
    } else {
      fail(
        "cancel helper preserves seeded Approved row",
        `status=${approvedPreserved.rows[0]?.approval_status || "missing"}`
      );
    }

    const pendingLeft = await pool.query(
      `SELECT COUNT(*)::int AS count
       FROM om_offer_approvals
       WHERE offer_id = $1 AND approval_status IN ('Pending', 'Waiting')`,
      [cancelFixture.offerId]
    );
    if (pendingLeft.rows[0].count === 0) {
      pass("cancel helper cleared pending/waiting mirror rows");
    } else {
      fail("cancel helper mirror", `pending/waiting left=${pendingLeft.rows[0].count}`);
    }
  } catch (error) {
    await client.query("ROLLBACK");
    fail("cancel helper transaction", error.message);
  } finally {
    client.release();
  }

  if (otherRecruiter) {
    try {
      await offerApprovalWorkflowService.cancelPendingOfferApprovalWork(
        pool,
        {
          offerId: cancelFixture.offerId,
          instanceId: cancelFixture.workflowInstanceId
        },
        mockReq(otherRecruiter)
      );
      fail("cancel helper unauthorized", "expected throw");
    } catch (error) {
      if (error.status === 403) {
        pass("cancel helper: other workspace recruiter blocked (403)");
      } else {
        fail("cancel helper unauthorized", `status=${error.status}`);
      }
    }
  } else {
    fail("cancel helper unauthorized", "no other offer-workspace recruiter fixture");
  }

  const taLead = await resolveTaLeadUser();
  if (taLead) {
    try {
      await assertCanWriteOfferRecord(pool, mockReq(taLead), cancelFixture.offerId);
      pass("TA Lead write authorization allowed");
    } catch (error) {
      fail("TA Lead write authorization", error.message);
    }
  } else {
    pass("TA Lead write authorization skipped (no TA Lead user)");
  }

  await cleanupOffer(cancelFixture.offerId);

  console.log("\n--- Concurrency (same transaction) ---");
  const raceFixture = await resolveSubmittedOfferFixture(
    recruiter,
    recruiterReq,
    adminReq,
    "race"
  );
  const raceClient = await pool.connect();
  try {
    await raceClient.query("BEGIN");
    await offerApprovalWorkflowService.assertOfferApprovalMayProceed(
      raceClient,
      raceFixture.offerId
    );
    await raceClient.query(
      `UPDATE om_offers SET offer_status = 'Withdrawn', modified_on = NOW() WHERE offer_id = $1`,
      [raceFixture.offerId]
    );
    try {
      await offerApprovalWorkflowService.assertOfferApprovalMayProceed(
        raceClient,
        raceFixture.offerId
      );
      fail("concurrency re-check inside tx", "expected 409 after status change");
    } catch (error) {
      if (error.status === 409) {
        pass("concurrency: in-tx guard sees withdrawn status (409)");
      } else {
        fail("concurrency re-check", `status=${error.status}`);
      }
    }
    await raceClient.query("ROLLBACK");
  } catch (error) {
    await raceClient.query("ROLLBACK");
    fail("concurrency setup", error.message);
  } finally {
    raceClient.release();
  }
  await cleanupOffer(raceFixture.offerId);

  console.log("\nDone.");
  await pool.end();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
  pool.end();
});
