/**
 * Offer approval clarification loop — mirrors verifyRequisitionClarification.js.
 */
require("dotenv").config();
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const workflowService = require("../services/workflowService");
const offerManagementService = require("../services/offerManagementService");
const {
  mockReq,
  resolveOfferWorkspaceRecruiter,
  resolveOtherOfferWorkspaceRecruiter,
  resolveTaLeadUser,
  resolveUserByEmployeeCode,
  createDisposableSubmittedOffer,
  cleanupOffer
} = require("./lib/offerApprovalTestFixtures");

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

const API_BASE_URL = process.env.API_BASE_URL || "http://localhost:5000";

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
    { expiresIn: "8h" }
  );
}

async function readJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function apiFetch(path, token, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {})
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers,
    body:
      options.body !== undefined
        ? typeof options.body === "string"
          ? options.body
          : JSON.stringify(options.body)
        : undefined
  });

  const data = await readJson(response);
  return { response, data };
}

async function isApiReachable() {
  try {
    const { response } = await apiFetch("/health-test", null, { method: "GET" });
    return response.ok;
  } catch {
    return false;
  }
}

async function countTasks(client, instanceId) {
  const result = await client.query(
    `SELECT task_id, title, status, task_type, assignee
     FROM wf_tasks WHERE instance_id = $1 ORDER BY task_id`,
    [instanceId]
  );
  return result.rows;
}

async function getActiveApprovalTask(client, instanceId) {
  const result = await client.query(
    `SELECT t.task_id, t.title, t.status, t.assignee, a.assignment_id
     FROM wf_tasks t
     INNER JOIN wf_assignments a ON a.task_id = t.task_id AND a.active = TRUE
     WHERE t.instance_id = $1
       AND LOWER(TRIM(t.status)) = 'pending'
       AND LOWER(TRIM(COALESCE(t.task_type, 'approval'))) IN ('approval', 'approve')
     ORDER BY t.task_id ASC
     LIMIT 1`,
    [instanceId]
  );
  return result.rows[0] || null;
}

async function myActiveApprovalTaskIds(employeeCode) {
  const profile =
    (await resolveUserByEmployeeCode(pool, employeeCode))
    || {
      employee_code: employeeCode,
      role_name: "Recruiter",
      full_name: employeeCode,
      email_id: `${employeeCode}@optalynx.local`
    };
  const rows = await workflowService.getMyActiveApprovals(pool, mockReq(profile));
  return rows.map((row) => String(row.task_id));
}

async function main() {
  const checks = [];
  const failures = [];

  const pass = (label, ok) => {
    checks.push({ label, ok });
    if (!ok) failures.push(label);
    console.log(`${ok ? "PASS" : "FAIL"} — ${label}`);
  };

  const recruiter = await resolveOfferWorkspaceRecruiter(pool);

  if (!recruiter) {
    console.log("SKIP — no offer-workspace recruiter in database.");
    process.exitCode = 0;
    return;
  }

  const admin = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name, full_name
     FROM user_mstr
     WHERE role_name = 'Admin' AND COALESCE(is_active, TRUE) = TRUE
     ORDER BY user_id ASC LIMIT 1`
  ).then((result) => result.rows[0]);

  if (!admin) {
    console.log("SKIP — no active Admin user for fixture setup.");
    process.exitCode = 0;
    return;
  }

  const recruiterReq = mockReq(recruiter);
  const adminReq = mockReq(admin);

  console.log("\n--- Unresolved requester identity (B1) ---");
  const b1Fixture = await createDisposableSubmittedOffer(
    pool,
    recruiter,
    recruiterReq,
    adminReq,
    "clr-b1"
  );

  await pool.query(
    `UPDATE om_offers
     SET recruiter_id = $1, created_by = $2
     WHERE offer_id = $3`,
    ["__UNRESOLVED_OFFER_REQUESTOR__", "__UNRESOLVED_OFFER_REQUESTOR__", b1Fixture.offerId]
  );

  const b1Active = await getActiveApprovalTask(pool, b1Fixture.instanceId);
  const b1ApproverCode = String(b1Active?.assignee || recruiter.employee_code).trim();
  const b1ApproverProfile =
    (await resolveUserByEmployeeCode(pool, b1ApproverCode))
    || {
      employee_code: b1ApproverCode,
      role_name: "Recruiter",
      full_name: b1ApproverCode,
      email_id: `${b1ApproverCode}@optalynx.local`
    };
  const b1ApproverReq = mockReq(b1ApproverProfile);

  const instanceBefore = await pool.query(
    `SELECT status, execution_context FROM wf_instances WHERE instance_id = $1`,
    [b1Fixture.instanceId]
  );
  const taskBefore = await pool.query(
    `SELECT status FROM wf_tasks WHERE task_id = $1`,
    [b1Fixture.taskId]
  );
  const assignmentBefore = await pool.query(
    `SELECT active FROM wf_assignments WHERE task_id = $1 AND assignment_id = $2`,
    [b1Fixture.taskId, b1Active?.assignment_id]
  );

  try {
    await offerManagementService.requestClarification(
      pool,
      b1Fixture.offerId,
      "Please clarify compensation.",
      b1ApproverReq
    );
    pass("Unresolved requester blocks send back", false);
  } catch (error) {
    pass("Unresolved requester blocks send back", error.status === 409);
    pass(
      "Unresolved requester returns explicit message",
      String(error.message || "").toLowerCase().includes("requester")
    );
  }

  const instanceAfterFail = await pool.query(
    `SELECT status, execution_context FROM wf_instances WHERE instance_id = $1`,
    [b1Fixture.instanceId]
  );
  const taskAfterFail = await pool.query(
    `SELECT status FROM wf_tasks WHERE task_id = $1`,
    [b1Fixture.taskId]
  );
  const assignmentAfterFail = await pool.query(
    `SELECT active FROM wf_assignments WHERE task_id = $1 AND assignment_id = $2`,
    [b1Fixture.taskId, b1Active?.assignment_id]
  );
  const tasksAfterFail = await countTasks(pool, b1Fixture.instanceId);

  pass(
    "Failed send back leaves instance Running",
    String(instanceAfterFail.rows[0]?.status || "") === "Running"
  );
  pass(
    "Failed send back leaves approval task Pending",
    String(taskAfterFail.rows[0]?.status || "").toLowerCase() === "pending"
  );
  pass(
    "Failed send back preserves active approver assignment",
    assignmentAfterFail.rows[0]?.active === assignmentBefore.rows[0]?.active
      && assignmentAfterFail.rows[0]?.active === true
  );
  pass(
    "Failed send back does not create clarification task",
    !tasksAfterFail.some(
      (task) => String(task.task_type || "").toLowerCase() === "clarification"
    )
  );
  pass(
    "Failed send back does not set clarification hold",
    !(
      typeof instanceAfterFail.rows[0]?.execution_context === "object"
        ? instanceAfterFail.rows[0]?.execution_context?.clarification
        : JSON.parse(instanceAfterFail.rows[0]?.execution_context || "{}")?.clarification
    )
  );

  await cleanupOffer(pool, b1Fixture.offerId);

  console.log("\n--- Reject during outstanding clarification (B2) ---");
  const b2Fixture = await createDisposableSubmittedOffer(
    pool,
    recruiter,
    recruiterReq,
    adminReq,
    "clr-b2"
  );

  await pool.query(
    `UPDATE om_offers
     SET recruiter_id = $1, created_by = $1
     WHERE offer_id = $2`,
    [recruiter.employee_code, b2Fixture.offerId]
  );

  try {
    const b2Active = await getActiveApprovalTask(pool, b2Fixture.instanceId);
    const b2ApproverCode = String(b2Active.assignee).trim();
    const b2ApproverProfile =
      (await resolveUserByEmployeeCode(pool, b2ApproverCode))
      || {
        employee_code: b2ApproverCode,
        role_name: "Recruiter",
        full_name: b2ApproverCode,
        email_id: `${b2ApproverCode}@optalynx.local`
      };
    const b2ApproverReq = mockReq(b2ApproverProfile);
    const rejectReason = "Rejected while clarification outstanding — B2 verification.";

    await offerManagementService.requestClarification(
      pool,
      b2Fixture.offerId,
      "Need compensation split before approval.",
      b2ApproverReq
    );

    const b2ApproverOfferView = await offerManagementService.getOffer(
      pool,
      b2Fixture.offerId,
      b2ApproverReq
    );
    pass(
      "B2 held approver receives canRejectDuringClarification",
      b2ApproverOfferView.canRejectDuringClarification === true
      && Number(b2ApproverOfferView.clarificationHeldApprovalTaskId)
        === Number(b2Fixture.taskId)
    );

    const b2TasksPaused = await countTasks(pool, b2Fixture.instanceId);
    const b2ClarTask = b2TasksPaused.find(
      (task) =>
        String(task.task_type || "").toLowerCase() === "clarification"
        && String(task.status || "").toLowerCase() === "pending"
    );

    const otherRecruiterB2 = await resolveOtherOfferWorkspaceRecruiter(
      pool,
      recruiter.employee_code
    );
    if (otherRecruiterB2) {
      try {
        const otherRecruiterView = await offerManagementService.getOffer(
          pool,
          b2Fixture.offerId,
          mockReq(otherRecruiterB2)
        );
        pass(
          "B2 non-held viewer not eligible to reject during clarification",
          otherRecruiterView.canRejectDuringClarification !== true
        );
      } catch (error) {
        pass(
          "B2 non-held viewer not eligible to reject during clarification (no read access)",
          error.status === 403
        );
      }

      try {
        await workflowService.rejectMyActiveApproval(
          pool,
          b2Fixture.taskId,
          "Unauthorized reject",
          mockReq(otherRecruiterB2)
        );
        pass("Unauthorized reject during clarification blocked", false);
      } catch (error) {
        pass("Unauthorized reject during clarification blocked", error.status === 403);
      }
    } else {
      pass("B2 non-held viewer not eligible to reject during clarification (skipped)", true);
      pass("Unauthorized reject during clarification blocked (skipped)", true);
    }

    await workflowService.rejectMyActiveApproval(
      pool,
      b2Fixture.taskId,
      rejectReason,
      b2ApproverReq
    );

    const b2Instance = await pool.query(
      `SELECT status, execution_context FROM wf_instances WHERE instance_id = $1`,
      [b2Fixture.instanceId]
    );
    const b2Offer = await pool.query(
      `SELECT offer_status FROM om_offers WHERE offer_id = $1`,
      [b2Fixture.offerId]
    );
    const b2History = await pool.query(
      `SELECT event_type, comments, actor
       FROM om_offer_history
       WHERE offer_id = $1
       ORDER BY created_on ASC NULLS LAST`,
      [b2Fixture.offerId]
    );
    const b2WfHistory = await pool.query(
      `SELECT event_type, metadata FROM wf_history WHERE instance_id = $1`,
      [b2Fixture.instanceId]
    );

    pass(
      "B2 rejection terminates workflow instance",
      String(b2Instance.rows[0]?.status || "") === "Rejected"
    );
    pass(
      "B2 rejection clears clarification hold",
      !(
        typeof b2Instance.rows[0]?.execution_context === "object"
          ? b2Instance.rows[0]?.execution_context?.clarification
          : JSON.parse(b2Instance.rows[0]?.execution_context || "{}")?.clarification
      )
    );
    pass(
      "B2 rejection applies offer Withdrawn terminal semantics",
      String(b2Offer.rows[0]?.offer_status || "") === "Withdrawn"
    );
    pass(
      "B2 rejection preserves reason in offer history",
      b2History.rows.some(
        (row) =>
          String(row.event_type || "") === "OfferWithdrawn"
          && String(row.comments || "").includes("B2 verification")
      )
    );
    pass(
      "B2 rejection records workflow TaskRejected history",
      b2WfHistory.rows.some((row) => row.event_type === "TaskRejected")
    );

    const b2TasksAfterReject = await countTasks(pool, b2Fixture.instanceId);
    const heldAfterReject = b2TasksAfterReject.find(
      (task) => String(task.task_id) === String(b2Fixture.taskId)
    );
    pass(
      "B2 held approval task completed after reject",
      String(heldAfterReject?.status || "").toLowerCase() === "completed"
    );
    pass(
      "B2 requestor clarification task cancelled",
      b2ClarTask
        ? String(
            b2TasksAfterReject.find(
              (task) => String(task.task_id) === String(b2ClarTask.task_id)
            )?.status || ""
          ).toLowerCase() === "cancelled"
        : false
    );

    if (b2ClarTask) {
      const requestorBellAfterReject = await myActiveApprovalTaskIds(
        recruiter.employee_code
      );
      pass(
        "B2 requestor clarification removed from active inbox",
        !requestorBellAfterReject.includes(String(b2ClarTask.task_id))
      );
    } else {
      pass("B2 requestor clarification removed from active inbox", false);
    }

    try {
      await offerManagementService.submitClarification(
        pool,
        b2Fixture.offerId,
        "Late response after rejection",
        recruiterReq
      );
      pass("B2 late clarification response rejected", false);
    } catch (error) {
      pass("B2 late clarification response rejected", error.status === 409);
    }

    const b2OfferAfterLate = await pool.query(
      `SELECT offer_status FROM om_offers WHERE offer_id = $1`,
      [b2Fixture.offerId]
    );
    pass(
      "B2 late clarification does not change terminal offer state",
      String(b2OfferAfterLate.rows[0]?.offer_status || "") === "Withdrawn"
    );
  } finally {
    await cleanupOffer(pool, b2Fixture.offerId);
  }

  console.log("\n--- Normal rejection outside clarification ---");
  const b2NormalFixture = await createDisposableSubmittedOffer(
    pool,
    recruiter,
    recruiterReq,
    adminReq,
    "clr-b2-normal"
  );

  try {
    const normalActive = await getActiveApprovalTask(pool, b2NormalFixture.instanceId);
    const normalApproverCode = String(normalActive.assignee).trim();
    const normalApproverProfile =
      (await resolveUserByEmployeeCode(pool, normalApproverCode))
      || {
        employee_code: normalApproverCode,
        role_name: "Recruiter",
        full_name: normalApproverCode,
        email_id: `${normalApproverCode}@optalynx.local`
      };

    await workflowService.rejectMyActiveApproval(
      pool,
      normalActive.task_id,
      "Rejected without clarification.",
      mockReq(normalApproverProfile)
    );

    const normalOffer = await pool.query(
      `SELECT offer_status FROM om_offers WHERE offer_id = $1`,
      [b2NormalFixture.offerId]
    );
    pass(
      "Normal rejection still terminates offer approval",
      String(normalOffer.rows[0]?.offer_status || "") === "Withdrawn"
    );
  } finally {
    await cleanupOffer(pool, b2NormalFixture.offerId);
  }

  console.log("\n--- TA Lead / Admin clarification response (B3) ---");
  const taLead = await resolveTaLeadUser(pool);
  const b3Fixture = await createDisposableSubmittedOffer(
    pool,
    recruiter,
    recruiterReq,
    adminReq,
    "clr-b3"
  );

  await pool.query(
    `UPDATE om_offers
     SET recruiter_id = $1, created_by = $1
     WHERE offer_id = $2`,
    [recruiter.employee_code, b3Fixture.offerId]
  );

  try {
    const b3Active = await getActiveApprovalTask(pool, b3Fixture.instanceId);
    const b3ApproverCode = String(b3Active.assignee).trim();
    const b3ApproverProfile =
      (await resolveUserByEmployeeCode(pool, b3ApproverCode))
      || {
        employee_code: b3ApproverCode,
        role_name: "Recruiter",
        full_name: b3ApproverCode,
        email_id: `${b3ApproverCode}@optalynx.local`
      };

    await offerManagementService.requestClarification(
      pool,
      b3Fixture.offerId,
      "Please confirm variable pay.",
      mockReq(b3ApproverProfile)
    );

    if (taLead) {
      const taLeadResponse = "TA Lead responding on behalf of requester.";
      await offerManagementService.submitClarification(
        pool,
        b3Fixture.offerId,
        taLeadResponse,
        mockReq(taLead)
      );

      const afterTaLead = await offerManagementService.getOffer(
        pool,
        b3Fixture.offerId,
        recruiterReq
      );
      const taLeadRound = (afterTaLead.clarificationRounds || []).find(
        (round) => round.response_comments === taLeadResponse
      );
      pass("TA Lead may submit clarification response", Boolean(taLeadRound));
      pass(
        "TA Lead response records actual responder identity",
        String(taLeadRound?.responded_by || "").trim() ===
          String(taLead.full_name || taLead.email_id || "").trim()
      );

      const b3InstanceRunning = await pool.query(
        `SELECT status FROM wf_instances WHERE instance_id = $1`,
        [b3Fixture.instanceId]
      );
      pass(
        "Workflow resumes after TA Lead clarification response",
        b3InstanceRunning.rows[0]?.status === "Running"
      );
    } else {
      pass("TA Lead may submit clarification response (skipped — no TA Lead)", true);
      pass("TA Lead response records actual responder identity (skipped)", true);
      pass("Workflow resumes after TA Lead clarification response (skipped)", true);
    }

    await offerManagementService.requestClarification(
      pool,
      b3Fixture.offerId,
      "Admin round — confirm location.",
      mockReq(b3ApproverProfile)
    );

    const adminResponse = "Admin responding on behalf of requester.";
    await offerManagementService.submitClarification(
      pool,
      b3Fixture.offerId,
      adminResponse,
      adminReq
    );

    const afterAdmin = await offerManagementService.getOffer(
      pool,
      b3Fixture.offerId,
      recruiterReq
    );
    const adminRound = (afterAdmin.clarificationRounds || []).find(
      (round) => round.response_comments === adminResponse
    );
    pass("Admin may submit clarification response", Boolean(adminRound));
    pass(
      "Admin response records actual responder identity",
      String(adminRound?.responded_by || "").trim() ===
        String(admin.full_name || admin.email_id || "").trim()
    );

    const otherRecruiterB3 = await resolveOtherOfferWorkspaceRecruiter(
      pool,
      recruiter.employee_code
    );
    if (otherRecruiterB3) {
      await offerManagementService.requestClarification(
        pool,
        b3Fixture.offerId,
        "Third round for unauthorized test.",
        mockReq(b3ApproverProfile)
      );
      try {
        await offerManagementService.submitClarification(
          pool,
          b3Fixture.offerId,
          "Should be denied",
          mockReq(otherRecruiterB3)
        );
        pass("Unrelated recruiter still denied for clarification response", false);
      } catch (error) {
        pass(
          "Unrelated recruiter still denied for clarification response",
          error.status === 403
        );
      }
    } else {
      pass("Unrelated recruiter still denied for clarification response (skipped)", true);
    }
  } finally {
    await cleanupOffer(pool, b3Fixture.offerId);
  }

  console.log("\n--- Clarification happy path ---");
  const fixture = await createDisposableSubmittedOffer(
    pool,
    recruiter,
    recruiterReq,
    adminReq,
    "clr"
  );

  const { offerId, instanceId, taskId: initialApprovalTaskId } = fixture;

  await pool.query(
    `UPDATE om_offers
     SET recruiter_id = $1, created_by = $1
     WHERE offer_id = $2`,
    [recruiter.employee_code, offerId]
  );

  try {
    const activeBefore = await getActiveApprovalTask(pool, instanceId);
    const approverCode = String(activeBefore.assignee).trim();
    const approverProfile =
      (await resolveUserByEmployeeCode(pool, approverCode))
      || {
        employee_code: approverCode,
        role_name: "Recruiter",
        full_name: approverCode,
        email_id: `${approverCode}@optalynx.local`
      };
    const approverReq = mockReq(approverProfile);

    try {
      await offerManagementService.requestClarification(pool, offerId, "   ", approverReq);
      pass("Send back rejects empty comment", false);
    } catch (error) {
      pass("Send back rejects empty comment", error.status === 400);
    }

    await offerManagementService.requestClarification(
      pool,
      offerId,
      "Please confirm joining date and variable pay breakdown.",
      approverReq
    );

    const instancePaused = await pool.query(
      `SELECT status, execution_context FROM wf_instances WHERE instance_id = $1`,
      [instanceId]
    );
    const instanceStatus = String(instancePaused.rows[0]?.status || "");
    const context = instancePaused.rows[0]?.execution_context || {};
    const parsedContext =
      typeof context === "string" ? JSON.parse(context) : context;

    pass("Workflow instance paused after send back", instanceStatus === "Paused");
    pass(
      "Clarification hold references approval task",
      Number(parsedContext?.clarification?.task_id) === Number(initialApprovalTaskId)
    );

    const tasksAfterSendBack = await countTasks(pool, instanceId);
    const heldTask = tasksAfterSendBack.find(
      (task) => String(task.task_id) === String(initialApprovalTaskId)
    );
    pass(
      "Approval task held for clarification",
      String(heldTask?.status || "").toLowerCase() === "waiting for clarification"
    );

    const clarificationTask = tasksAfterSendBack.find(
      (task) => String(task.task_type || "").toLowerCase() === "clarification"
      && String(task.status || "").toLowerCase() === "pending"
    );
    pass("Requestor clarification task created", Boolean(clarificationTask));

    const approverBellDuringPause = await myActiveApprovalTaskIds(approverCode);
    pass(
      "Approver pending approval removed from active inbox during pause",
      !approverBellDuringPause.includes(String(initialApprovalTaskId))
    );

    const requestorBellDuringPause = clarificationTask
      ? await myActiveApprovalTaskIds(recruiter.employee_code)
      : [];
    pass(
      "Requestor sees clarification task in active inbox",
      clarificationTask
        ? requestorBellDuringPause.includes(String(clarificationTask.task_id))
        : false
    );

    try {
      await offerManagementService.approveOffer(
        pool,
        offerId,
        fixture.stepTitle,
        "should not approve",
        approverReq
      );
      pass("Approve blocked while clarification open", false);
    } catch (error) {
      pass("Approve blocked while clarification open", error.status === 409);
    }

    try {
      await offerManagementService.correctAndResubmitPendingApproval(
        pool,
        offerId,
        { offered_ctc: 1500000, reason: "during clarification" },
        recruiterReq
      );
      pass("Correction blocked during clarification", false);
    } catch (error) {
      pass("Correction blocked during clarification", error.status === 409);
    }

    const otherRecruiter = await resolveOtherOfferWorkspaceRecruiter(
      pool,
      recruiter.employee_code
    );
    if (otherRecruiter) {
      try {
        await offerManagementService.submitClarification(
          pool,
          offerId,
          "Unauthorized response",
          mockReq(otherRecruiter)
        );
        pass("Unauthorized clarification response rejected", false);
      } catch (error) {
        pass("Unauthorized clarification response rejected", error.status === 403);
      }
    } else {
      pass("Unauthorized clarification response rejected (skipped — no second recruiter)", true);
    }

    await offerManagementService.submitClarification(
      pool,
      offerId,
      "Joining date is 14 days from offer release; variable pay is annual.",
      recruiterReq
    );

    const instanceRunning = await pool.query(
      `SELECT status FROM wf_instances WHERE instance_id = $1`,
      [instanceId]
    );
    pass("Workflow resumed after requestor response", instanceRunning.rows[0]?.status === "Running");

    const resumedApproval = await getActiveApprovalTask(pool, instanceId);
    pass(
      "Same approval task reactivated",
      String(resumedApproval?.task_id) === String(initialApprovalTaskId)
    );

    const approverBellAfterResume = await myActiveApprovalTaskIds(approverCode);
    pass(
      "Approver pending task returns to active inbox",
      approverBellAfterResume.includes(String(initialApprovalTaskId))
    );

    await offerManagementService.requestClarification(
      pool,
      offerId,
      "Second round — please attach compensation split.",
      approverReq
    );

    await offerManagementService.submitClarification(
      pool,
      offerId,
      "Base 80%, variable 20% documented in offer sheet.",
      recruiterReq
    );

    const bundle = await offerManagementService.getOffer(pool, offerId, recruiterReq);
    pass(
      "Multiple clarification rounds stored on offer",
      Array.isArray(bundle.clarificationRounds) && bundle.clarificationRounds.length >= 2
    );
    pass(
      "No outstanding clarification after second response",
      !bundle.clarificationPending
    );

    await offerManagementService.approveOffer(
      pool,
      offerId,
      fixture.stepTitle,
      "Approved after clarification",
      approverReq
    );

    const offerRow = await pool.query(
      `SELECT offer_status FROM om_offers WHERE offer_id = $1`,
      [offerId]
    );
    pass(
      "Final approval still succeeds after clarification loop",
      String(offerRow.rows[0]?.offer_status) === "Pending Approval"
        || String(offerRow.rows[0]?.offer_status) === "Approved"
    );
  } finally {
    await cleanupOffer(pool, offerId);
  }

  console.log("\n--- HTTP POST my-approvals reject (B2) ---");
  if (!(await isApiReachable())) {
    console.log(
      `NOT RUN — HTTP route tests (${API_BASE_URL} not reachable; start backend to execute).`
    );
  } else {
    const httpFixture = await createDisposableSubmittedOffer(
      pool,
      recruiter,
      recruiterReq,
      adminReq,
      "clr-http"
    );

    await pool.query(
      `UPDATE om_offers
       SET recruiter_id = $1, created_by = $1
       WHERE offer_id = $2`,
      [recruiter.employee_code, httpFixture.offerId]
    );

    try {
      const httpActive = await getActiveApprovalTask(pool, httpFixture.instanceId);
      const httpApproverCode = String(httpActive.assignee).trim();
      const httpApproverProfile =
        (await resolveUserByEmployeeCode(pool, httpApproverCode))
        || {
          employee_code: httpApproverCode,
          role_name: "Recruiter",
          full_name: httpApproverCode,
          email_id: `${httpApproverCode}@optalynx.local`,
          user_id: 0
        };
      const httpApproverToken = signToken(httpApproverProfile);
      const httpRejectReason = "HTTP reject during clarification — route verification.";

      await offerManagementService.requestClarification(
        pool,
        httpFixture.offerId,
        "HTTP clarify before reject.",
        mockReq(httpApproverProfile)
      );

      const bundleRes = await apiFetch("/api/v1/offers", httpApproverToken);
      pass("HTTP GET /api/v1/offers succeeds for held approver", bundleRes.response.ok);

      const bundleOffer = (bundleRes.data?.offers || []).find(
        (row) => String(row.offerId || row.offer_id) === String(httpFixture.offerId)
      );
      pass(
        "HTTP bundle exposes held task id and canRejectDuringClarification",
        Boolean(bundleOffer?.canRejectDuringClarification)
        && Number(bundleOffer?.clarificationHeldApprovalTaskId)
          === Number(httpFixture.taskId)
      );

      const heldTaskId =
        bundleOffer?.clarificationHeldApprovalTaskId || httpFixture.taskId;

      const otherRecruiterHttp = await resolveOtherOfferWorkspaceRecruiter(
        pool,
        recruiter.employee_code
      );
      if (otherRecruiterHttp) {
        const otherToken = signToken(otherRecruiterHttp);
        const denyRes = await apiFetch(
          `/api/v1/workflows/my-approvals/${encodeURIComponent(heldTaskId)}/reject`,
          otherToken,
          { method: "POST", body: { comments: "Should be denied" } }
        );
        pass(
          "HTTP non-held approver reject denied",
          denyRes.response.status === 403
        );
      } else {
        pass("HTTP non-held approver reject denied (skipped)", true);
      }

      const rejectRes = await apiFetch(
        `/api/v1/workflows/my-approvals/${encodeURIComponent(heldTaskId)}/reject`,
        httpApproverToken,
        { method: "POST", body: { comments: httpRejectReason } }
      );
      pass("HTTP held approver reject succeeds", rejectRes.response.ok);

      const httpInstance = await pool.query(
        `SELECT status FROM wf_instances WHERE instance_id = $1`,
        [httpFixture.instanceId]
      );
      const httpOffer = await pool.query(
        `SELECT offer_status FROM om_offers WHERE offer_id = $1`,
        [httpFixture.offerId]
      );
      const httpHistory = await pool.query(
        `SELECT event_type, comments FROM om_offer_history WHERE offer_id = $1`,
        [httpFixture.offerId]
      );
      pass(
        "HTTP reject terminates workflow instance",
        String(httpInstance.rows[0]?.status || "") === "Rejected"
      );
      pass(
        "HTTP reject applies Withdrawn offer semantics",
        String(httpOffer.rows[0]?.offer_status || "") === "Withdrawn"
      );
      pass(
        "HTTP reject preserves reason in offer history",
        httpHistory.rows.some(
          (row) =>
            String(row.event_type || "") === "OfferWithdrawn"
            && String(row.comments || "").includes("route verification")
        )
      );

      const httpTasks = await countTasks(pool, httpFixture.instanceId);
      const httpClar = httpTasks.find(
        (task) =>
          String(task.task_type || "").toLowerCase() === "clarification"
          && String(task.task_id) !== String(httpFixture.taskId)
      );
      pass(
        "HTTP reject cancels clarification task",
        httpClar
          ? String(httpClar.status || "").toLowerCase() === "cancelled"
          : false
      );

      const heldAssignment = await pool.query(
        `SELECT active
         FROM wf_assignments
         WHERE task_id = $1
         ORDER BY assignment_id ASC
         LIMIT 1`,
        [httpFixture.taskId]
      );
      pass(
        "HTTP reject deactivates held approval assignment",
        heldAssignment.rows[0]?.active === false
      );

      const lateRes = await apiFetch(
        `/api/v1/offers/${encodeURIComponent(httpFixture.offerId)}/submit-clarification`,
        signToken(recruiter),
        { method: "POST", body: { comments: "Late HTTP response" } }
      );
      pass("HTTP late clarification response rejected", lateRes.response.status === 409);

      const httpNormalFixture = await createDisposableSubmittedOffer(
        pool,
        recruiter,
        recruiterReq,
        adminReq,
        "clr-http-normal"
      );

      try {
        const normalActive = await getActiveApprovalTask(
          pool,
          httpNormalFixture.instanceId
        );
        const normalProfile =
          (await resolveUserByEmployeeCode(pool, String(normalActive.assignee).trim()))
          || httpApproverProfile;
        const normalToken = signToken(normalProfile);
        const normalRejectRes = await apiFetch(
          `/api/v1/workflows/my-approvals/${encodeURIComponent(normalActive.task_id)}/reject`,
          normalToken,
          { method: "POST", body: { comments: "HTTP normal reject outside clarification." } }
        );
        pass("HTTP normal reject outside clarification succeeds", normalRejectRes.response.ok);

        const normalOffer = await pool.query(
          `SELECT offer_status FROM om_offers WHERE offer_id = $1`,
          [httpNormalFixture.offerId]
        );
        pass(
          "HTTP normal reject reaches Withdrawn",
          String(normalOffer.rows[0]?.offer_status || "") === "Withdrawn"
        );
      } finally {
        await cleanupOffer(pool, httpNormalFixture.offerId);
      }
    } finally {
      await cleanupOffer(pool, httpFixture.offerId);
    }
  }

  console.log(`\nSummary: ${checks.filter((c) => c.ok).length} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log("Failures:", failures.join(", "));
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
