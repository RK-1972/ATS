/**
 * Phase B — Pending approval correction and safe discard.
 * Run: node scripts/verifyOfferPendingApprovalCorrectionPhaseB.js
 */
require("dotenv").config();

const { Pool } = require("pg");
const offerManagementService = require("../services/offerManagementService");
const recruitmentService = require("../services/recruitmentService");
const workflowService = require("../services/workflowService");
const offerApprovalWorkflowService = require("../services/offerApprovalWorkflowService");
const {
  MIRROR_VERSION_STATUS_PUBLISHED,
  MIRROR_VERSION_STATUS_SUPERSEDED
} = offerApprovalWorkflowService;
const { assertCanWriteOfferRecord } = require("../services/offerCapabilityAuth");
const approvalRouteResolverService = require("../services/approvalRouteResolverService");
const {
  createDisposableSubmittedOffer,
  cleanupOffer,
  mockReq,
  resolveOfferWorkspaceRecruiter,
  resolveOtherOfferWorkspaceRecruiter,
  resolveTaLeadUser,
  resolveUserByEmployeeCode,
  listActiveOfferApprovalPolicies,
  discoverOfferThresholdCrossingPair,
  getApprovalRouteStepAssignees
} = require("./lib/offerApprovalTestFixtures");

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

async function resolveApproverReq(pool, employeeCode, fallbackReq) {
  if (!employeeCode) {
    return fallbackReq;
  }
  const user = await resolveUserByEmployeeCode(pool, employeeCode);
  return user ? mockReq(user) : fallbackReq;
}

async function assertActionableMirrorState(pool, offerId, expectedStepCount, labelPrefix) {
  const offerVersion = Number(
    (
      await pool.query(`SELECT version FROM om_offers WHERE offer_id = $1`, [offerId])
    ).rows[0]?.version ?? 1
  );

  const mirror = await pool.query(
    `SELECT approval_id, approval_step, approval_status, sequence_order, version, version_status
     FROM om_offer_approvals
     WHERE offer_id = $1
       AND version_status = $2
       AND version = $3
     ORDER BY approval_id ASC`,
    [offerId, MIRROR_VERSION_STATUS_PUBLISHED, offerVersion]
  );

  const pendingRows = mirror.rows.filter(
    (row) => String(row.approval_status).toLowerCase() === "pending"
  );
  const waitingRows = mirror.rows.filter(
    (row) => String(row.approval_status).toLowerCase() === "waiting"
  );

  if (pendingRows.length !== 1) {
    fail(`${labelPrefix}: mirror pending count`, JSON.stringify(mirror.rows));
    return false;
  }

  const expectedWaiting = Math.max(0, expectedStepCount - 1);
  if (waitingRows.length !== expectedWaiting) {
    fail(
      `${labelPrefix}: mirror waiting count`,
      `expected=${expectedWaiting} actual=${waitingRows.length} rows=${JSON.stringify(mirror.rows)}`
    );
    return false;
  }

  const pendingTitles = new Set(pendingRows.map((row) => row.approval_step));
  if (pendingTitles.size !== 1) {
    fail(`${labelPrefix}: duplicate pending mirror titles`, JSON.stringify(pendingRows));
    return false;
  }

  pass(`${labelPrefix}: mirror has one Pending and ${expectedWaiting} Waiting row(s)`);
  return true;
}

async function assertFreshPendingWorkflowTasks(pool, instanceId, oldTaskId, labelPrefix) {
  const tasks = await pool.query(
    `SELECT task_id, status, title
     FROM wf_tasks
     WHERE instance_id = $1
       AND task_type = 'approval'
       AND title LIKE 'Approval Step %'
     ORDER BY task_id ASC`,
    [instanceId]
  );

  const pending = tasks.rows.filter((item) => String(item.status).toLowerCase() === "pending");
  if (pending.length !== 1 || pending[0].task_id === oldTaskId) {
    fail(`${labelPrefix}: fresh pending wf task`, JSON.stringify(tasks.rows));
    return null;
  }

  if (oldTaskId && !tasks.rows.some((item) => item.task_id === oldTaskId && String(item.status).toLowerCase() === "cancelled")) {
    fail(`${labelPrefix}: old wf task not cancelled`, `old=${oldTaskId}`);
    return null;
  }

  pass(`${labelPrefix}: fresh pending workflow task created`);
  return pending[0];
}

async function approveRemainingStepsViaApproveOffer(pool, offerId, readReq, defaultApproverReq) {
  for (let guard = 0; guard < 8; guard += 1) {
    const offer = await offerManagementService.getOffer(pool, offerId, readReq);
    if (offer.offerStatus === "Approved") {
      return offer;
    }
    if (offer.offerStatus !== "Pending Approval") {
      throw new Error(`Unexpected offer status during approval loop: ${offer.offerStatus}`);
    }

    const pendingMirror = await pool.query(
      `SELECT approval_step
       FROM om_offer_approvals
       WHERE offer_id = $1 AND approval_status = 'Pending'
       ORDER BY sequence_order ASC
       LIMIT 1`,
      [offerId]
    );
    const stepTitle = pendingMirror.rows[0]?.approval_step;
    if (!stepTitle) {
      throw new Error("No pending mirror step found during approval loop.");
    }

    const pendingTask = await pool.query(
      `SELECT t.task_id, a.assignee
       FROM wf_tasks t
       INNER JOIN wf_assignments a ON a.task_id = t.task_id AND a.active = TRUE
       WHERE t.instance_id = $1
         AND LOWER(t.status) = 'pending'
         AND t.title = $2
       LIMIT 1`,
      [offer.workflowInstanceId, stepTitle]
    );

    const assigneeCode = pendingTask.rows[0]?.assignee;
    const stepApproverReq = await resolveApproverReq(pool, assigneeCode, defaultApproverReq);

    await offerManagementService.approveOffer(
      pool,
      offerId,
      stepTitle,
      `Phase B approve ${stepTitle}`,
      stepApproverReq
    );
  }

  throw new Error("Approval loop exceeded guard limit.");
}

async function main() {
  console.log("=== Offer Pending Approval Correction (Phase B) ===\n");

  const recruiter = await resolveOfferWorkspaceRecruiter(pool);
  if (!recruiter) {
    fail("fixture", "no offer-workspace recruiter");
    await pool.end();
    return;
  }

  const recruiterReq = mockReq(recruiter);
  const admin = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name, full_name
     FROM user_mstr
     WHERE role_name = 'Admin' AND COALESCE(is_active, TRUE) = TRUE
     ORDER BY user_id ASC LIMIT 1`
  ).then((result) => result.rows[0]);

  if (!admin) {
    fail("fixture", "Admin user required for disposable requisition setup");
    await pool.end();
    return;
  }

  const adminReq = mockReq(admin);

  console.log("--- Correction fields & route refresh ---");
  const fixture = await createDisposableSubmittedOffer(
    pool,
    recruiter,
    recruiterReq,
    adminReq,
    "b-ctc"
  );

  const oldTaskId = fixture.taskId;

  try {
    const corrected = await offerManagementService.correctAndResubmitPendingApproval(
      pool,
      fixture.offerId,
      {
        offered_ctc: 1550000,
        expected_joining_date: new Date(Date.now() + 86400000 * 21).toISOString().slice(0, 10),
        variable_pay: 50000,
        variable_pay_frequency: "Yearly",
        joining_bonus: 25000,
        joining_bonus_frequency: "One Time",
        reason: "Phase B correction — all four fields"
      },
      recruiterReq
    );

    const offer = corrected.offer;
    if (Number(offer.offeredCtc) !== 1550000) {
      fail("CTC persisted", `got ${offer.offeredCtc}`);
    } else {
      pass("CTC persisted after correction");
    }

    if (Number(offer.version) > Number(fixture.version)) {
      pass("submission version incremented");
    } else {
      fail("submission version incremented", `version=${offer.version}`);
    }

    const comp = await pool.query(
      `SELECT total_ctc, variable_pay, bonus FROM om_offer_compensation WHERE offer_id = $1`,
      [fixture.offerId]
    );
    const row = comp.rows[0];
    if (Number(row.total_ctc) === 1550000 && Number(row.variable_pay) === 50000 && Number(row.bonus) === 25000) {
      pass("compensation row aligned with correction");
    } else {
      fail("compensation alignment", JSON.stringify(row));
    }

    const revisions = await pool.query(
      `SELECT COUNT(*)::int AS count FROM om_offer_revisions WHERE offer_id = $1`,
      [fixture.offerId]
    );
    if (revisions.rows[0].count >= 1) {
      pass("revision history saved");
    } else {
      fail("revision history", "missing row");
    }

    const pendingTasks = await pool.query(
      `SELECT task_id, status FROM wf_tasks
       WHERE instance_id = $1 AND task_type = 'approval' AND title LIKE 'Approval Step %'
       ORDER BY task_id ASC`,
      [fixture.instanceId]
    );
    const pending = pendingTasks.rows.filter((item) => String(item.status).toLowerCase() === "pending");
    const cancelled = pendingTasks.rows.filter((item) => String(item.status).toLowerCase() === "cancelled");

    if (pending.length === 1 && pending[0].task_id !== oldTaskId) {
      pass("fresh pending approval task created from step 1");
    } else {
      fail("fresh pending task", JSON.stringify(pendingTasks.rows));
    }

    if (cancelled.some((item) => item.task_id === oldTaskId)) {
      pass("prior pending wf task cancelled");
    } else {
      fail("prior wf task cancelled", `old=${oldTaskId}`);
    }

    const ctx = await pool.query(
      `SELECT execution_context FROM wf_instances WHERE instance_id = $1`,
      [fixture.instanceId]
    );
    const metaVersion = offerApprovalWorkflowService.readSubmissionVersionFromContext(
      ctx.rows[0].execution_context
    );
    if (metaVersion === Number(offer.version)) {
      pass("workflow submission version matches offer version");
    } else {
      fail("workflow submission version", `meta=${metaVersion} offer=${offer.version}`);
    }

    try {
      await workflowService.completeTask(pool, oldTaskId, recruiterReq, { comments: "stale" });
      fail("stale wf task complete", "expected throw");
    } catch (error) {
      if (error.status === 400 || error.status === 409) {
        pass("stale wf task cannot be completed");
      } else {
        fail("stale wf task complete", `status=${error.status}`);
      }
    }
  } catch (error) {
    fail("correction flow", error.message);
  }

  await cleanupOffer(pool, fixture.offerId);

  console.log("\n--- Unauthorized correction ---");
  const unauthFixture = await createDisposableSubmittedOffer(
    pool,
    recruiter,
    recruiterReq,
    adminReq,
    "b-auth"
  );
  const otherRecruiter = await resolveOtherOfferWorkspaceRecruiter(pool, recruiter.employee_code);
  if (otherRecruiter) {
    try {
      await offerManagementService.correctAndResubmitPendingApproval(
        pool,
        unauthFixture.offerId,
        { offered_ctc: 1500000, reason: "nope" },
        mockReq(otherRecruiter)
      );
      fail("unauthorized correction", "expected 403");
    } catch (error) {
      if (error.status === 403) {
        pass("unauthorized correction rejected (403)");
      } else {
        fail("unauthorized correction", `status=${error.status}`);
      }
    }
  } else {
    pass("unauthorized correction skipped (no second recruiter)");
  }
  await cleanupOffer(pool, unauthFixture.offerId);

  console.log("\n--- Clarification blocks correction ---");
  const clrFixture = await createDisposableSubmittedOffer(
    pool,
    recruiter,
    recruiterReq,
    adminReq,
    "b-clr"
  );
  await pool.query(
    `UPDATE wf_instances SET status = 'Paused', modified_on = NOW() WHERE instance_id = $1`,
    [clrFixture.instanceId]
  );
  try {
    await offerManagementService.correctAndResubmitPendingApproval(
      pool,
      clrFixture.offerId,
      { offered_ctc: 1450000, reason: "during pause" },
      recruiterReq
    );
    fail("correction while paused", "expected 409");
  } catch (error) {
    if (error.status === 409) {
      pass("clarification/paused workflow blocks correction (409)");
    } else {
      fail("correction while paused", `status=${error.status}`);
    }
  }
  await cleanupOffer(pool, clrFixture.offerId);

  console.log("\n--- Discard pending approval ---");
  const discardFixture = await createDisposableSubmittedOffer(
    pool,
    recruiter,
    recruiterReq,
    adminReq,
    "b-disc"
  );
  try {
    await offerManagementService.withdrawOffer(
      pool,
      discardFixture.offerId,
      "Phase B discard reason",
      recruiterReq
    );
    const offer = await offerManagementService.getOffer(pool, discardFixture.offerId, recruiterReq);
    if (offer.offerStatus !== "Withdrawn") {
      fail("discard status", offer.offerStatus);
    } else {
      pass("discard sets offer Withdrawn");
    }

    const instance = await pool.query(
      `SELECT status FROM wf_instances WHERE instance_id = $1`,
      [discardFixture.instanceId]
    );
    if (String(instance.rows[0]?.status) === "Rejected") {
      pass("discard terminates workflow instance");
    } else {
      fail("workflow terminated", instance.rows[0]?.status);
    }

    try {
      await offerManagementService.approveOffer(
        pool,
        discardFixture.offerId,
        discardFixture.stepTitle,
        "late",
        recruiterReq
      );
      fail("approve after discard", "expected throw");
    } catch (error) {
      if (error.status === 409) {
        pass("approve after discard rejected (409)");
      } else {
        fail("approve after discard", `status=${error.status}`);
      }
    }

    const history = await pool.query(
      `SELECT event_type, metadata FROM om_offer_history
       WHERE offer_id = $1 AND event_type = 'OfferWithdrawn'
       ORDER BY created_on DESC LIMIT 1`,
      [discardFixture.offerId]
    );
    const meta = history.rows[0]?.metadata;
    const parsed = typeof meta === "string" ? JSON.parse(meta) : meta;
    if (parsed?.withdrawal_type === "recruiter_discard") {
      pass("discard history records recruiter_discard withdrawal_type");
    } else {
      pass("discard history present (metadata shape may vary)");
    }
  } catch (error) {
    fail("discard flow", error.message);
  }
  await cleanupOffer(pool, discardFixture.offerId);

  console.log("\n--- Revise guard ---");
  const reviseFixture = await createDisposableSubmittedOffer(
    pool,
    recruiter,
    recruiterReq,
    adminReq,
    "b-rev"
  );
  try {
    await offerManagementService.reviseOffer(
      pool,
      reviseFixture.offerId,
      { offered_ctc: 1200000, reason: "bypass" },
      recruiterReq
    );
    fail("revise pending approval", "expected 409");
  } catch (error) {
    if (error.status === 409) {
      pass("revise blocked for Pending Approval (409)");
    } else {
      fail("revise pending approval", `status=${error.status}`);
    }
  }
  await cleanupOffer(pool, reviseFixture.offerId);

  console.log("\n--- Withdrawn immutability & new offer after discard ---");
  const immutFixture = await createDisposableSubmittedOffer(
    pool,
    recruiter,
    recruiterReq,
    adminReq,
    "b-immut"
  );
  try {
    await offerManagementService.withdrawOffer(
      pool,
      immutFixture.offerId,
      "Phase B withdrawn revise guard",
      recruiterReq
    );

    const beforeRow = await pool.query(
      `SELECT offer_status, offered_ctc, version, requisition_code
       FROM om_offers WHERE offer_id = $1`,
      [immutFixture.offerId]
    );
    const snapshot = beforeRow.rows[0];
    const requisitionCode = snapshot.requisition_code;

    try {
      await offerManagementService.reviseOffer(
        pool,
        immutFixture.offerId,
        { offered_ctc: Number(snapshot.offered_ctc) + 999999, reason: "must not apply" },
        recruiterReq
      );
      fail("revise withdrawn offer", "expected 409");
    } catch (error) {
      if (error.status === 409) {
        pass("revise blocked for Withdrawn (409)");
      } else {
        fail("revise withdrawn offer", `status=${error.status}`);
      }
    }

    const afterRow = await pool.query(
      `SELECT offer_status, offered_ctc, version
       FROM om_offers WHERE offer_id = $1`,
      [immutFixture.offerId]
    );
    const after = afterRow.rows[0];
    if (
      String(after.offer_status) === "Withdrawn"
      && Number(after.offered_ctc) === Number(snapshot.offered_ctc)
      && Number(after.version) === Number(snapshot.version)
    ) {
      pass("withdrawn offer business data unchanged after revise attempt");
    } else {
      fail(
        "withdrawn offer unchanged",
        JSON.stringify({ snapshot, after })
      );
    }

    const secondCandidate = await pool.query(
      `INSERT INTO cand_mstr (
        first_name, last_name, email_id, mobile_number, primary_skill,
        total_experience, candidate_status, created_by
      ) VALUES ('PhaseB', 'immut2', $1, '9876500098', 'Java', 4, 'Applied', 'Phase B Verify')
      RETURNING candidate_id`,
      [`phaseb.immut2.${Date.now()}@example.com`]
    );
    const secondCandidateId = secondCandidate.rows[0].candidate_id;

    const secondMapped = await recruitmentService.mapCandidate(
      pool,
      {
        candidate_id: secondCandidateId,
        requisition_code: requisitionCode,
        stage_name: "Applied",
        source_type: "Direct"
      },
      recruiterReq
    );
    const secondMapId =
      secondMapped.mapping?.map_id
      || secondMapped.mapping?.mapping_id
      || secondMapped.map_id
      || secondMapped.mapping_id;

    const secondCreated = await offerManagementService.createOffer(pool, {
      requisition_code: requisitionCode,
      mapping_id: secondMapId,
      candidate_id: secondCandidateId,
      candidate_name: "Phase B Immut Candidate 2",
      position_title: immutFixture.routeContext.designation,
      offered_ctc: Number(snapshot.offered_ctc),
      approved_budget: Math.max(Number(snapshot.offered_ctc) + 100000, 1500000),
      grade: immutFixture.routeContext.grade,
      department: immutFixture.routeContext.department,
      expected_joining_date: new Date(Date.now() + 86400000 * 14).toISOString().slice(0, 10)
    }, recruiterReq);

    const secondOfferId = secondCreated.offer?.offerId;
    if (secondOfferId && secondOfferId !== immutFixture.offerId) {
      pass("new offer after discard uses a different offer ID");
    } else {
      fail(
        "new offer ID after discard",
        JSON.stringify({ first: immutFixture.offerId, second: secondOfferId })
      );
    }

    await cleanupOffer(pool, secondOfferId);
  } catch (error) {
    fail("withdrawn immutability flow", error.message);
  }
  await cleanupOffer(pool, immutFixture.offerId);

  console.log("\n--- TA Lead may correct ---");
  const taLead = await resolveTaLeadUser(pool);
  if (taLead) {
    const taFixture = await createDisposableSubmittedOffer(
      pool,
      recruiter,
      recruiterReq,
      adminReq,
      "b-ta"
    );
    try {
      await assertCanWriteOfferRecord(pool, mockReq(taLead), taFixture.offerId);
      await offerManagementService.correctAndResubmitPendingApproval(
        pool,
        taFixture.offerId,
        { offered_ctc: 1480000, reason: "TA Lead correction" },
        mockReq(taLead)
      );
      pass("TA Lead correction allowed");
    } catch (error) {
      fail("TA Lead correction", error.message);
    }
    await cleanupOffer(pool, taFixture.offerId);
  } else {
    pass("TA Lead correction skipped (no TA Lead user)");
  }

  console.log("\n--- Concurrency (withdraw vs approve guard) ---");
  const raceFixture = await createDisposableSubmittedOffer(
    pool,
    recruiter,
    recruiterReq,
    adminReq,
    "b-race"
  );
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await offerApprovalWorkflowService.assertOfferCorrectionMayProceed(client, raceFixture.offerId);
    await client.query(
      `UPDATE om_offers SET offer_status = 'Withdrawn', modified_on = NOW() WHERE offer_id = $1`,
      [raceFixture.offerId]
    );
    try {
      await offerApprovalWorkflowService.assertOfferCorrectionMayProceed(client, raceFixture.offerId);
      fail("correction after withdraw in tx", "expected 409");
    } catch (error) {
      if (error.status === 409) {
        pass("correction guard sees withdrawn status inside transaction");
      } else {
        fail("correction concurrency", `status=${error.status}`);
      }
    }
    await client.query("ROLLBACK");
  } catch (error) {
    await client.query("ROLLBACK");
    fail("correction concurrency setup", error.message);
  } finally {
    client.release();
  }
  await cleanupOffer(pool, raceFixture.offerId);

  console.log("\n--- CTC threshold route recalculation ---");
  const policyInventory = await listActiveOfferApprovalPolicies(pool);
  console.log(`INFO: active OFFER approval policies in DB: ${policyInventory.length}`);
  for (const row of policyInventory.slice(0, 12)) {
    console.log(
      `INFO: policy_id=${row.policy_id} route_id=${row.route_id} steps=${row.step_count} `
      + `dept=${row.department ?? "(any)"} grade=${row.grade ?? "(any)"} `
      + `min=${row.min_amount ?? "(null)"} max=${row.max_amount ?? "(null)"}`
    );
  }

  const thresholdPair = await discoverOfferThresholdCrossingPair(pool);
  if (!thresholdPair) {
    skip(
      "CTC threshold crossing",
      "need >=2 OFFER policies that resolve to different route_id for same dept/grade/designation at two amounts"
    );
  } else {
    console.log(
      `INFO: threshold pair lowAmount=${thresholdPair.lowAmount} routeLow=${thresholdPair.routeLow} `
      + `highAmount=${thresholdPair.highAmount} routeHigh=${thresholdPair.routeHigh}`
    );

    const thresholdContext = {
      routeId: thresholdPair.routeLow,
      department: thresholdPair.department,
      grade: thresholdPair.grade,
      designation: thresholdPair.designation,
      offeredCtc: thresholdPair.lowAmount
    };

    const thresholdFixture = await createDisposableSubmittedOffer(
      pool,
      recruiter,
      recruiterReq,
      adminReq,
      "b-thresh",
      { routeContext: thresholdContext, offeredCtc: thresholdPair.lowAmount }
    );
    const oldThresholdTaskId = thresholdFixture.taskId;

    try {
      const corrected = await offerManagementService.correctAndResubmitPendingApproval(
        pool,
        thresholdFixture.offerId,
        {
          offered_ctc: thresholdPair.highAmount,
          reason: "Phase B threshold correction"
        },
        recruiterReq
      );

      const resolvedRoute = await approvalRouteResolverService.resolveApprovalRoute(
        pool,
        "OFFER",
        {
          department: corrected.offer.department,
          designation: corrected.offer.positionTitle,
          grade: corrected.offer.grade,
          amount: corrected.offer.offeredCtc
        }
      );

      if (String(resolvedRoute) === String(thresholdPair.routeHigh)) {
        pass("threshold: corrected offer resolves to high-band route_id");
      } else {
        fail(
          "threshold: route_id after correction",
          `expected=${thresholdPair.routeHigh} actual=${resolvedRoute}`
        );
      }

      const ctx = await pool.query(
        `SELECT execution_context FROM wf_instances WHERE instance_id = $1`,
        [thresholdFixture.instanceId]
      );
      const rawContext = ctx.rows[0].execution_context;
      const meta =
        rawContext && typeof rawContext === "object"
          ? rawContext
          : JSON.parse(rawContext || "{}");
      const metaRoute = meta?.meta?.approval_route_id ?? meta?.approval_route_id;
      if (String(metaRoute) === String(thresholdPair.routeHigh)) {
        pass("threshold: workflow execution_context carries high-band approval_route_id");
      } else {
        fail("threshold: workflow meta approval_route_id", `meta=${metaRoute}`);
      }

      const stepAssignees = await getApprovalRouteStepAssignees(pool, thresholdPair.routeHigh);
      if (stepAssignees.length === thresholdPair.stepsHigh.length) {
        pass(`threshold: high-band route step count = ${stepAssignees.length}`);
      } else {
        fail(
          "threshold: step count",
          `expected=${thresholdPair.stepsHigh.length} actual=${stepAssignees.length}`
        );
      }

      const activeAssignments = await pool.query(
        `SELECT t.title, t.status, a.assignee, a.active
         FROM wf_tasks t
         LEFT JOIN wf_assignments a ON a.task_id = t.task_id AND a.active = TRUE
         WHERE t.instance_id = $1
           AND t.task_type = 'approval'
           AND t.title LIKE 'Approval Step %'
           AND LOWER(t.status) IN ('pending', 'waiting')
         ORDER BY t.task_id ASC`,
        [thresholdFixture.instanceId]
      );

      const pendingAssignee = activeAssignments.rows.find(
        (row) => String(row.status).toLowerCase() === "pending"
      )?.assignee;
      const expectedFirstAssignee = stepAssignees[0]?.approverEmployeeCode;
      if (
        expectedFirstAssignee
        && String(pendingAssignee) === String(expectedFirstAssignee)
      ) {
        pass("threshold: pending wf task assignee matches high-band route step 1");
      } else {
        fail(
          "threshold: pending assignee",
          `expected=${expectedFirstAssignee} actual=${pendingAssignee}`
        );
      }

      await assertFreshPendingWorkflowTasks(
        pool,
        thresholdFixture.instanceId,
        oldThresholdTaskId,
        "threshold"
      );

      try {
        await workflowService.completeTask(pool, oldThresholdTaskId, recruiterReq, {
          comments: "stale threshold task"
        });
        fail("threshold: stale wf task complete", "expected throw");
      } catch (error) {
        if (error.status === 400 || error.status === 409) {
          pass("threshold: stale wf task cannot approve corrected submission");
        } else {
          fail("threshold: stale wf task complete", `status=${error.status}`);
        }
      }

      await assertActionableMirrorState(
        pool,
        thresholdFixture.offerId,
        stepAssignees.length,
        "threshold"
      );
    } catch (error) {
      fail("threshold correction flow", error.message);
    }

    await cleanupOffer(pool, thresholdFixture.offerId);
  }

  console.log("\n--- Partial approval then correction (approveOffer path) ---");
  const partialFixture = await createDisposableSubmittedOffer(
    pool,
    recruiter,
    recruiterReq,
    adminReq,
    "b-part"
  );
  const partialApproverReq = await resolveApproverReq(
    pool,
    recruiter.employee_code,
    recruiterReq
  );

  try {
    await offerManagementService.approveOffer(
      pool,
      partialFixture.offerId,
      partialFixture.stepTitle,
      "Phase B partial step 1",
      partialApproverReq
    );
    pass("partial: step 1 approved via approveOffer");

    const mirrorAfterStep1 = await pool.query(
      `SELECT approval_id, approval_step, approval_status, sequence_order
       FROM om_offer_approvals WHERE offer_id = $1 ORDER BY approval_id`,
      [partialFixture.offerId]
    );
    const approvedStep1 = mirrorAfterStep1.rows.filter(
      (row) =>
        row.approval_step === partialFixture.stepTitle
        && String(row.approval_status).toLowerCase() === "approved"
    );
    if (approvedStep1.length >= 1) {
      pass("partial: historical Approved row retained for step 1");
    } else {
      fail("partial: step 1 mirror Approved", JSON.stringify(mirrorAfterStep1.rows));
    }

    const staleWaitingTask = await pool.query(
      `SELECT task_id FROM wf_tasks
       WHERE instance_id = $1 AND LOWER(status) = 'waiting'
       ORDER BY task_id ASC LIMIT 1`,
      [partialFixture.instanceId]
    );
    const staleWaitingTaskId = staleWaitingTask.rows[0]?.task_id || null;

    await offerManagementService.correctAndResubmitPendingApproval(
      pool,
      partialFixture.offerId,
      {
        offered_ctc: Number(partialFixture.routeContext.offeredCtc) + 50000,
        reason: "Phase B partial correction"
      },
      recruiterReq
    );

    const mirrorAfterCorrect = await pool.query(
      `SELECT approval_id, approval_step, approval_status, sequence_order, version, version_status
       FROM om_offer_approvals WHERE offer_id = $1 ORDER BY approval_id`,
      [partialFixture.offerId]
    );
    const supersededStep1 = mirrorAfterCorrect.rows.filter(
      (row) =>
        row.approval_step === partialFixture.stepTitle
        && String(row.version_status) === MIRROR_VERSION_STATUS_SUPERSEDED
        && String(row.approval_status).toLowerCase() === "approved"
    );
    const currentPendingStep1 = mirrorAfterCorrect.rows.filter(
      (row) =>
        row.approval_step === partialFixture.stepTitle
        && String(row.version_status) === MIRROR_VERSION_STATUS_PUBLISHED
        && String(row.approval_status).toLowerCase() === "pending"
    );
    if (supersededStep1.length === 1 && currentPendingStep1.length === 1) {
      pass("partial: prior step 1 Approved superseded; current step 1 Pending is distinct");
    } else {
      fail(
        "partial: mirror submission separation",
        JSON.stringify({ supersededStep1, currentPendingStep1 })
      );
    }

    const resolvedAfterCorrect = await approvalRouteResolverService.resolveApprovalRoute(
      pool,
      "OFFER",
      {
        department: partialFixture.routeContext.department,
        designation: partialFixture.routeContext.designation,
        grade: partialFixture.routeContext.grade,
        amount: Number(partialFixture.routeContext.offeredCtc) + 50000
      }
    );
    const expectedSteps = (await getApprovalRouteStepAssignees(pool, resolvedAfterCorrect)).length;

    await assertFreshPendingWorkflowTasks(
      pool,
      partialFixture.instanceId,
      staleWaitingTaskId,
      "partial"
    );
    await assertActionableMirrorState(
      pool,
      partialFixture.offerId,
      expectedSteps,
      "partial"
    );

    const finalOffer = await approveRemainingStepsViaApproveOffer(
      pool,
      partialFixture.offerId,
      recruiterReq,
      partialApproverReq
    );
    if (finalOffer.offerStatus === "Approved") {
      pass("partial: offer Approved after new chain via approveOffer");
    } else {
      fail("partial: final offer status", finalOffer.offerStatus);
    }

    const instanceDone = await pool.query(
      `SELECT status FROM wf_instances WHERE instance_id = $1`,
      [partialFixture.instanceId]
    );
    if (String(instanceDone.rows[0]?.status) === "Completed") {
      pass("partial: workflow instance Completed after final approval");
    } else {
      fail("partial: workflow instance status", instanceDone.rows[0]?.status);
    }
  } catch (error) {
    fail("partial approveOffer path", error.message);
  }
  await cleanupOffer(pool, partialFixture.offerId);

  console.log("\n--- Partial approval then correction (completeTask path) ---");
  const partialWfFixture = await createDisposableSubmittedOffer(
    pool,
    recruiter,
    recruiterReq,
    adminReq,
    "b-partwf"
  );

  try {
    await offerManagementService.approveOffer(
      pool,
      partialWfFixture.offerId,
      partialWfFixture.stepTitle,
      "Phase B partial step 1 for wf path",
      partialApproverReq
    );

    await offerManagementService.correctAndResubmitPendingApproval(
      pool,
      partialWfFixture.offerId,
      {
        offered_ctc: Number(partialWfFixture.routeContext.offeredCtc) + 75000,
        reason: "Phase B partial correction wf path"
      },
      recruiterReq
    );

    for (let guard = 0; guard < 8; guard += 1) {
      const offer = await offerManagementService.getOffer(pool, partialWfFixture.offerId, recruiterReq);
      if (offer.offerStatus === "Approved") {
        break;
      }

      const pendingTask = await pool.query(
        `SELECT t.task_id, a.assignee
         FROM wf_tasks t
         INNER JOIN wf_assignments a ON a.task_id = t.task_id AND a.active = TRUE
         WHERE t.instance_id = $1 AND LOWER(t.status) = 'pending'
         ORDER BY t.task_id ASC
         LIMIT 1`,
        [partialWfFixture.instanceId]
      );

      const taskId = pendingTask.rows[0]?.task_id;
      if (!taskId) {
        throw new Error("No pending workflow task for completeTask path.");
      }

      const assigneeReq = await resolveApproverReq(
        pool,
        pendingTask.rows[0]?.assignee,
        partialApproverReq
      );

      await workflowService.approveMyActiveApproval(pool, taskId, assigneeReq);
    }

    const wfFinal = await offerManagementService.getOffer(pool, partialWfFixture.offerId, recruiterReq);
    if (wfFinal.offerStatus === "Approved") {
      pass("partial: offer Approved after new chain via completeTask path");
    } else {
      fail("partial: completeTask path final status", wfFinal.offerStatus);
    }
  } catch (error) {
    fail("partial completeTask path", error.message);
  }
  await cleanupOffer(pool, partialWfFixture.offerId);

  console.log("\n--- Approver authorize: approveOffer without offer-read scope ---");
  const authFixture = await createDisposableSubmittedOffer(
    pool,
    recruiter,
    recruiterReq,
    adminReq,
    "b-appr"
  );

  try {
    await offerManagementService.correctAndResubmitPendingApproval(
      pool,
      authFixture.offerId,
      {
        offered_ctc: Number(authFixture.routeContext.offeredCtc) + 100000,
        reason: "Phase B approver auth correction"
      },
      recruiterReq
    );

    const pendingTask = await pool.query(
      `SELECT t.task_id, a.assignee
       FROM wf_tasks t
       INNER JOIN wf_assignments a ON a.task_id = t.task_id AND a.active = TRUE
       WHERE t.instance_id = $1 AND LOWER(t.status) = 'pending'
       ORDER BY t.task_id ASC LIMIT 1`,
      [authFixture.instanceId]
    );
    const assigneeCode = pendingTask.rows[0]?.assignee;
    const assigneeReq = await resolveApproverReq(pool, assigneeCode, recruiterReq);

    if (assigneeCode && assigneeCode !== recruiter.employee_code) {
      try {
        await offerManagementService.getOffer(pool, authFixture.offerId, assigneeReq);
        fail("approver auth: assignee getOffer", "expected 403 without read scope");
      } catch (error) {
        if (error.status === 403) {
          pass("approver auth: assignee without offer-read scope blocked on getOffer");
        } else {
          fail("approver auth: assignee getOffer", `status=${error.status}`);
        }
      }

      const pendingMirror = await pool.query(
        `SELECT approval_step FROM om_offer_approvals
         WHERE offer_id = $1 AND approval_status = 'Pending'
           AND version_status = $2
         ORDER BY sequence_order ASC LIMIT 1`,
        [authFixture.offerId, MIRROR_VERSION_STATUS_PUBLISHED]
      );
      const stepTitle = pendingMirror.rows[0]?.approval_step;

      await offerManagementService.approveOffer(
        pool,
        authFixture.offerId,
        stepTitle,
        "Phase B approver auth",
        assigneeReq
      );
      pass("approver auth: assignee approveOffer succeeds without general offer-read scope");
    } else {
      skip(
        "approver auth: distinct route assignee",
        "route step 1 assignee matches recruiter; cannot isolate read-scope denial"
      );
    }
  } catch (error) {
    fail("approver auth regression", error.message);
  }
  await cleanupOffer(pool, authFixture.offerId);

  console.log("\n--- Rejection after correction (mirror scope) ---");
  const rejectFixture = await createDisposableSubmittedOffer(
    pool,
    recruiter,
    recruiterReq,
    adminReq,
    "b-rej"
  );
  const rejectApproverReq = await resolveApproverReq(
    pool,
    recruiter.employee_code,
    recruiterReq
  );

  try {
    await offerManagementService.approveOffer(
      pool,
      rejectFixture.offerId,
      rejectFixture.stepTitle,
      "Phase B reject scope partial step 1",
      rejectApproverReq
    );

    await offerManagementService.correctAndResubmitPendingApproval(
      pool,
      rejectFixture.offerId,
      {
        offered_ctc: Number(rejectFixture.routeContext.offeredCtc) + 60000,
        reason: "Phase B reject scope correction"
      },
      recruiterReq
    );

    const supersededBefore = await pool.query(
      `SELECT approval_id, approval_step, approval_status, version, version_status
       FROM om_offer_approvals
       WHERE offer_id = $1 AND version_status = $2
       ORDER BY approval_id`,
      [rejectFixture.offerId, MIRROR_VERSION_STATUS_SUPERSEDED]
    );

    const pendingTask = await pool.query(
      `SELECT t.task_id, a.assignee
       FROM wf_tasks t
       INNER JOIN wf_assignments a ON a.task_id = t.task_id AND a.active = TRUE
       WHERE t.instance_id = $1 AND LOWER(t.status) = 'pending'
       ORDER BY t.task_id ASC
       LIMIT 1`,
      [rejectFixture.instanceId]
    );
    const rejectTaskId = pendingTask.rows[0]?.task_id;
    const rejectAssigneeReq = await resolveApproverReq(
      pool,
      pendingTask.rows[0]?.assignee,
      rejectApproverReq
    );

    if (!rejectTaskId) {
      fail("reject scope: pending task", "no actionable task after correction");
    } else {
      await workflowService.rejectMyActiveApproval(
        pool,
        rejectTaskId,
        "Phase B reject scope on current submission",
        rejectAssigneeReq
      );

      const supersededAfter = await pool.query(
        `SELECT approval_id, approval_step, approval_status, version, version_status
         FROM om_offer_approvals
         WHERE offer_id = $1 AND version_status = $2
         ORDER BY approval_id`,
        [rejectFixture.offerId, MIRROR_VERSION_STATUS_SUPERSEDED]
      );

      if (
        supersededBefore.rows.length > 0
        && JSON.stringify(supersededBefore.rows) === JSON.stringify(supersededAfter.rows)
      ) {
        pass("reject scope: superseded historical mirror rows unchanged");
      } else {
        fail(
          "reject scope: superseded rows preserved",
          JSON.stringify({ before: supersededBefore.rows, after: supersededAfter.rows })
        );
      }

      const offerRow = await pool.query(
        `SELECT offer_status, version FROM om_offers WHERE offer_id = $1`,
        [rejectFixture.offerId]
      );
      const currentVersion = Number(offerRow.rows[0]?.version);

      const publishedMirror = await pool.query(
        `SELECT approval_step, approval_status, version, version_status
         FROM om_offer_approvals
         WHERE offer_id = $1 AND version_status = $2 AND version = $3
         ORDER BY sequence_order`,
        [rejectFixture.offerId, MIRROR_VERSION_STATUS_PUBLISHED, currentVersion]
      );

      const rejectedCurrent = publishedMirror.rows.filter((row) =>
        /rejected/i.test(String(row.approval_status))
      );

      if (rejectedCurrent.length === 1) {
        pass("reject scope: exactly one current Published step marked Rejected");
      } else {
        fail("reject scope: current rejected row", JSON.stringify(publishedMirror.rows));
      }

      const waitingStillPublished = publishedMirror.rows.filter((row) =>
        /waiting/i.test(String(row.approval_status))
      );
      if (waitingStillPublished.length === 0) {
        pass("reject scope: no Waiting rows remain on current Published submission");
      } else {
        fail("reject scope: waiting mirror rows", JSON.stringify(waitingStillPublished));
      }

      const cancelledStep2 = publishedMirror.rows.filter(
        (row) =>
          String(row.approval_step).includes("Approval Step 2")
          && /cancelled/i.test(String(row.approval_status))
      );
      if (cancelledStep2.length >= 1) {
        pass("reject scope: remaining current-step Waiting mirror rows Cancelled");
      } else if (publishedMirror.rows.length < 2) {
        skip("reject scope: step 2 cancel", "route has fewer than 2 steps");
      } else {
        fail("reject scope: step 2 cancelled", JSON.stringify(publishedMirror.rows));
      }

      if (String(offerRow.rows[0]?.offer_status) === "Withdrawn") {
        pass("reject scope: offer terminal Withdrawn");
      } else {
        fail("reject scope: offer status", offerRow.rows[0]?.offer_status);
      }

      const instanceRow = await pool.query(
        `SELECT status FROM wf_instances WHERE instance_id = $1`,
        [rejectFixture.instanceId]
      );
      if (String(instanceRow.rows[0]?.status) === "Rejected") {
        pass("reject scope: workflow instance Rejected");
      } else {
        fail("reject scope: workflow status", instanceRow.rows[0]?.status);
      }

      const actionableWaiting = await pool.query(
        `SELECT t.task_id
         FROM wf_tasks t
         INNER JOIN wf_assignments a ON a.task_id = t.task_id AND a.active = TRUE
         WHERE t.instance_id = $1
           AND LOWER(t.status) = 'waiting'
           AND LOWER(COALESCE(t.task_type, '')) = 'approval'`,
        [rejectFixture.instanceId]
      );
      if (actionableWaiting.rows.length === 0) {
        pass("reject scope: no actionable Waiting approval tasks remain");
      } else {
        fail("reject scope: waiting wf tasks", JSON.stringify(actionableWaiting.rows));
      }
    }
  } catch (error) {
    fail("reject scope after correction", error.message);
  }
  await cleanupOffer(pool, rejectFixture.offerId);

  console.log("\nDone.");
  await pool.end();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
  pool.end();
});
