/**
 * Sprint 3 Final Enterprise Verification (read/exercise only — no product changes).
 */
require("dotenv").config();
const { Pool } = require("pg");
const workforcePlanningService = require("../services/workforcePlanningService");
const workflowService = require("../services/workflowService");
const budgetWorkflowCompletionService = require("../services/budgetWorkflowCompletionService");

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

const results = [];

function mockReq(employeeCode, roleName = "Approver", fullName = null) {
  return {
    user: {
      employee_code: employeeCode,
      role_name: roleName,
      email_id: `${String(employeeCode).toLowerCase()}@optalynx.local`,
      full_name: fullName || employeeCode
    }
  };
}

function record(scenario, pass, evidence) {
  results.push({ scenario, pass: Boolean(pass), evidence });
  console.log(`\n=== ${scenario}: ${pass ? "PASS" : "FAIL"} ===`);
  (Array.isArray(evidence) ? evidence : [evidence]).forEach((line) => {
    console.log(`  ${line}`);
  });
}

async function getDraft(client) {
  const state = await client.query(
    `SELECT draft_payload FROM wp_config_state WHERE id = 1`
  );
  return state.rows[0].draft_payload;
}

async function getBudget(client, requestId) {
  const draft = await getDraft(client);
  return {
    draft,
    request: (draft.budget_requests || []).find((item) => item.id === requestId),
    queue: (draft.approval_queue || []).find((item) => item.id === requestId),
    positions: draft.approved_positions || []
  };
}

async function getTasks(client, instanceId) {
  const result = await client.query(
    `SELECT t.task_id, t.title, t.status, t.task_type, t.assignee,
            a.active, a.assignee AS assignment_assignee
     FROM wf_tasks t
     LEFT JOIN wf_assignments a ON a.task_id = t.task_id
     WHERE t.instance_id = $1
     ORDER BY t.task_id`,
    [instanceId]
  );
  return result.rows;
}

async function getInstance(client, instanceId) {
  const result = await client.query(
    `SELECT instance_id, status, workflow_code, execution_context
     FROM wf_instances WHERE instance_id = $1`,
    [instanceId]
  );
  return result.rows[0] || null;
}

async function getAudits(client, entityId) {
  const result = await client.query(
    `SELECT event_type, action, previous_value, new_value, created_on
     FROM md_enterprise_audit
     WHERE entity_id = $1
     ORDER BY created_on DESC
     LIMIT 20`,
    [entityId]
  );
  return result.rows;
}

function timelineSteps(queueOrRequest) {
  return (queueOrRequest?.timeline || []).map((t) => t.step);
}

function historyActions(queueOrRequest) {
  return (queueOrRequest?.history || []).map(
    (h) => h.action || h.event || h.step || JSON.stringify(h)
  );
}

async function ensureTwoStepRoute(client) {
  const route = await client.query(
    `SELECT r.route_id
     FROM approval_route_mstr r
     WHERE LOWER(TRIM(r.status)) = 'active'
       AND (
         LOWER(TRIM(r.applies_to)) LIKE '%budget%'
         OR UPPER(SPLIT_PART(REGEXP_REPLACE(TRIM(r.applies_to), '[^A-Za-z0-9]+', '_', 'g'), '_', 1)) = 'BUDGET'
       )
     ORDER BY r.route_id LIMIT 1`
  );
  if (!route.rows[0]) throw new Error("No BUDGET route");

  const steps = await client.query(
    `SELECT sequence_no, approver_employee_code
     FROM approval_route_step WHERE route_id = $1 ORDER BY sequence_no`,
    [route.rows[0].route_id]
  );

  if (steps.rows.length < 2) {
    const second = await client.query(
      `SELECT employee_code FROM user_mstr
       WHERE is_active = TRUE AND employee_code IS NOT NULL
         AND employee_code <> $1
       ORDER BY user_id LIMIT 1`,
      [steps.rows[0]?.approver_employee_code || ""]
    );
    if (!second.rows[0]) throw new Error("Need second employee for L2");
    await client.query(
      `INSERT INTO approval_route_step (
         route_id, step_no, approver_employee_code, approval_type,
         comments_required, allow_reject, allow_return, stop_if_rejected, sequence_no
       ) VALUES ($1, 2, $2, 'Approver', FALSE, TRUE, TRUE, TRUE, 2)`,
      [route.rows[0].route_id, second.rows[0].employee_code]
    );
  }

  const refreshed = await client.query(
    `SELECT sequence_no, approver_employee_code
     FROM approval_route_step WHERE route_id = $1 ORDER BY sequence_no`,
    [route.rows[0].route_id]
  );

  return {
    routeId: route.rows[0].route_id,
    l1: String(refreshed.rows[0].approver_employee_code).trim(),
    l2: String(refreshed.rows[1].approver_employee_code).trim()
  };
}

async function buildCriteria(client, routeId) {
  const policy = await client.query(
    `SELECT department, designation, grade, min_amount
     FROM approval_route_policy
     WHERE route_id = $1 AND is_active = TRUE
     ORDER BY policy_id LIMIT 1`,
    [routeId]
  );
  const dept = await client.query(
    `SELECT name FROM md_records WHERE entity_type='departments' AND is_deleted=FALSE ORDER BY id LIMIT 1`
  );
  const desig = await client.query(
    `SELECT name FROM md_records WHERE entity_type='designations' AND is_deleted=FALSE ORDER BY id LIMIT 1`
  );
  const grade = await client.query(
    `SELECT COALESCE(code,name) AS v FROM md_records WHERE entity_type='grades' AND is_deleted=FALSE ORDER BY id LIMIT 1`
  );

  return {
    department: policy.rows[0]?.department || dept.rows[0].name,
    position: policy.rows[0]?.designation || desig.rows[0].name,
    grade: policy.rows[0]?.grade || grade.rows[0].v,
    proposed_budget:
      policy.rows[0]?.min_amount != null
        ? Number(policy.rows[0].min_amount)
        : 500000,
    headcount: 1,
    justification: "Sprint 3 enterprise final verification.",
    priority: "Medium"
  };
}

async function createAndSubmit(pool, criteria, requestorReq, justification) {
  const created = await workforcePlanningService.createBudgetRequest(
    pool,
    { ...criteria, justification: justification || criteria.justification },
    requestorReq
  );
  const requestId = created.request.id;
  await workforcePlanningService.submitBudgetRequest(pool, requestId, requestorReq);
  return requestId;
}

async function myApprovalsFor(employeeCode) {
  return workflowService.getMyActiveApprovals(pool, mockReq(employeeCode));
}

function budgetRowsFor(approvals, requestId) {
  return (approvals || []).filter(
    (row) =>
      String(row.document_number) === String(requestId)
      || String(row.instance_id) === `WF-BR-${requestId}`
  );
}

async function main() {
  const client = await pool.connect();
  let overallFail = false;

  try {
    const { routeId, l1, l2 } = await ensureTwoStepRoute(client);
    const criteria = await buildCriteria(client, routeId);
    const admin = await client.query(
      `SELECT employee_code, role_name FROM user_mstr
       WHERE LOWER(TRIM(role_name))='admin' AND is_active=TRUE
       ORDER BY user_id LIMIT 1`
    );
    const requestorReq = mockReq(
      admin.rows[0].employee_code,
      admin.rows[0].role_name,
      "Requestor Admin"
    );
    const nonApprover = "NOT-AN-APPROVER";

    // ------------------------------------------------------------------
    // Scenario 1 — L1 Approve
    // ------------------------------------------------------------------
    {
      const requestId = await createAndSubmit(
        pool,
        criteria,
        requestorReq,
        "S1 L1 Approve"
      );
      const instanceId = `WF-BR-${requestId}`;

      const beforeL1 = await myApprovalsFor(l1);
      const beforeL2 = await myApprovalsFor(l2);

      await workforcePlanningService.approveBudgetRequest(
        pool,
        requestId,
        "L1 ok",
        mockReq(l1, "Approver", "L1 Approver")
      );

      const snap = await getBudget(client, requestId);
      const tasks = await getTasks(client, instanceId);
      const l1Task = tasks.find((t) => /Approval Step 1/.test(t.title || ""));
      const l2Task = tasks.find((t) => /Approval Step 2/.test(t.title || ""));
      const afterL1 = await myApprovalsFor(l1);
      const afterL2 = await myApprovalsFor(l2);
      const audits = await getAudits(client, requestId);
      const tl = timelineSteps(snap.queue || snap.request);
      const hist = historyActions(snap.queue || snap.request);

      const checks = [];
      const okL1 =
        l1Task && String(l1Task.status).toLowerCase() === "completed";
      checks.push(`L1 task completed: ${okL1} (${l1Task?.status})`);
      const okL2 =
        l2Task
        && String(l2Task.status).toLowerCase() === "pending"
        && l2Task.active === true;
      checks.push(
        `L2 activated Pending/active: ${okL2} (status=${l2Task?.status}, active=${l2Task?.active})`
      );
      const okStatus =
        snap.request?.status === "Pending Level-2 Approval"
        && snap.queue?.status === "Pending Level-2 Approval";
      checks.push(`Budget Pending Level-2 Approval: ${okStatus}`);
      const l1Gone = budgetRowsFor(afterL1, requestId).length === 0;
      const l2Appears = budgetRowsFor(afterL2, requestId).length === 1;
      checks.push(
        `My Approvals L1 gone: ${l1Gone} (before=${budgetRowsFor(beforeL1, requestId).length}, after=${budgetRowsFor(afterL1, requestId).length})`
      );
      checks.push(
        `My Approvals L2 appears: ${l2Appears} (before=${budgetRowsFor(beforeL2, requestId).length}, after=${budgetRowsFor(afterL2, requestId).length})`
      );
      const okTl = tl.includes("Level-1 Approved") || tl.includes("Submitted");
      checks.push(`Timeline has Level-1 Approved/Submitted: ${okTl} [${tl.join(", ")}]`);
      const okAudit = audits.some(
        (a) =>
          /BudgetRouted|Level-1|Level-2/i.test(a.event_type || "")
          || /Level-2/i.test(a.new_value || "")
          || /routed/i.test(a.action || "")
      );
      checks.push(
        `Audit updated: ${okAudit} (latest=${audits[0]?.event_type}/${audits[0]?.new_value})`
      );
      const okHist = hist.length > 0 || tl.length > 0;
      checks.push(`History/timeline present: ${okHist} (history entries=${hist.length})`);

      const pass =
        okL1 && okL2 && okStatus && l1Gone && l2Appears && okTl && okAudit && okHist;
      record("Scenario 1 — L1 Approve", pass, checks);
      if (!pass) overallFail = true;

      // keep requestId for Scenario 2 continuation
      global.__s1RequestId = requestId;
      global.__s1InstanceId = instanceId;
    }

    // ------------------------------------------------------------------
    // Scenario 2 — Final Approve (continue S1)
    // ------------------------------------------------------------------
    {
      const requestId = global.__s1RequestId;
      const instanceId = global.__s1InstanceId;
      const beforePos = (await getBudget(client, requestId)).positions.length;

      await workforcePlanningService.approveBudgetRequest(
        pool,
        requestId,
        "L2 final",
        mockReq(l2, "Approver", "L2 Approver")
      );

      const snap = await getBudget(client, requestId);
      const instance = await getInstance(client, instanceId);
      const afterL1 = budgetRowsFor(await myApprovalsFor(l1), requestId);
      const afterL2 = budgetRowsFor(await myApprovalsFor(l2), requestId);
      const audits = await getAudits(client, requestId);
      const tl = timelineSteps(snap.queue || snap.request);
      const hist = historyActions(snap.queue || snap.request);
      const posCreated = snap.positions.some(
        (p) => p.source_request_id === requestId
      );

      const checks = [];
      const okWf = String(instance?.status) === "Completed";
      checks.push(`Workflow completed: ${okWf} (${instance?.status})`);
      const okApproved =
        snap.request?.status === "Approved" && snap.queue?.status === "Approved";
      checks.push(`Budget Approved: ${okApproved}`);
      checks.push(
        `Approved Position created: ${posCreated} (before=${beforePos}, after=${snap.positions.length})`
      );
      const emptyMy =
        afterL1.length === 0 && afterL2.length === 0;
      checks.push(`My Approvals empty for this doc: ${emptyMy}`);
      const okTl =
        tl.includes("Level-2 Approved")
        || tl.includes("Approved")
        || tl.includes("Level-1 Approved");
      checks.push(`Timeline updated: ${okTl} [${tl.join(", ")}]`);
      const okAudit = audits.some(
        (a) =>
          /Approved|BudgetApproved|Position/i.test(
            `${a.event_type} ${a.action} ${a.new_value}`
          )
      );
      checks.push(`Audit updated: ${okAudit}`);
      checks.push(`History present: ${hist.length > 0 || tl.length > 0}`);

      const pass =
        okWf && okApproved && posCreated && emptyMy && okTl && okAudit;
      record("Scenario 2 — Final Approve", pass, checks);
      if (!pass) overallFail = true;
    }

    // ------------------------------------------------------------------
    // Scenario 3 — Reject
    // ------------------------------------------------------------------
    {
      const requestId = await createAndSubmit(
        pool,
        criteria,
        requestorReq,
        "S3 Reject path"
      );
      const instanceId = `WF-BR-${requestId}`;
      const beforePos = (await getBudget(client, requestId)).positions.filter(
        (p) => p.source_request_id === requestId
      ).length;

      await workforcePlanningService.rejectBudgetRequest(
        pool,
        requestId,
        "Not aligned with plan",
        mockReq(l1, "Approver", "L1 Approver")
      );

      const snap = await getBudget(client, requestId);
      const instance = await getInstance(client, instanceId);
      const tasks = await getTasks(client, instanceId);
      const l2Pending = tasks.find(
        (t) =>
          /Approval Step 2/.test(t.title || "")
          && String(t.status).toLowerCase() === "pending"
          && t.active === true
      );
      const audits = await getAudits(client, requestId);
      const tl = timelineSteps(snap.queue || snap.request);
      const afterPos = snap.positions.filter(
        (p) => p.source_request_id === requestId
      ).length;

      const checks = [];
      const okWf =
        String(instance?.status) === "Rejected"
        || String(instance?.status) === "Completed";
      checks.push(`Workflow terminated: ${okWf} (${instance?.status})`);
      const okStatus = snap.request?.status === "Rejected";
      checks.push(`Budget Rejected: ${okStatus}`);
      checks.push(`No active L2 Pending: ${!l2Pending}`);
      checks.push(
        `No Approved Position: ${afterPos === beforePos} (count=${afterPos})`
      );
      const okTl =
        tl.some((s) => /Reject/i.test(s)) || audits.some((a) => /Reject/i.test(a.event_type || a.action || ""));
      checks.push(`Timeline/Audit reject evidence: ${okTl} timeline=[${tl.join(", ")}]`);
      const okAudit = audits.some((a) =>
        /Reject/i.test(`${a.event_type} ${a.action} ${a.new_value}`)
      );
      checks.push(`Audit updated: ${okAudit}`);

      const pass =
        okWf && okStatus && !l2Pending && afterPos === beforePos && okTl && okAudit;
      record("Scenario 3 — Reject", pass, checks);
      if (!pass) overallFail = true;
    }

    // ------------------------------------------------------------------
    // Scenario 4 — Clarify + Scenario 5 — Resubmit
    // ------------------------------------------------------------------
    {
      const requestId = await createAndSubmit(
        pool,
        criteria,
        requestorReq,
        "S4 Clarify path"
      );
      const instanceId = `WF-BR-${requestId}`;
      const snap0 = await getBudget(client, requestId);
      const routeSnapBefore = JSON.stringify(
        snap0.queue?.approval_route_snapshot || null
      );
      const policySnapBefore = JSON.stringify(
        snap0.queue?.approval_policy_snapshot || null
      );
      const instanceBefore = snap0.queue?.workflow_instance_id || instanceId;

      await workforcePlanningService.requestBudgetClarification(
        pool,
        requestId,
        "Need more justification detail",
        mockReq(l1, "Approver", "L1 Approver")
      );

      const snapClarify = await getBudget(client, requestId);
      const instancePaused = await getInstance(client, instanceId);
      const tasksClarify = await getTasks(client, instanceId);
      const clarifyTask = tasksClarify.find(
        (t) => String(t.task_type).toLowerCase() === "clarification"
      );
      const l1My = budgetRowsFor(await myApprovalsFor(l1), requestId);
      const requestorMy = budgetRowsFor(
        await myApprovalsFor(admin.rows[0].employee_code),
        requestId
      );

      const checks4 = [];
      const okPaused = String(instancePaused?.status) === "Paused";
      checks4.push(`Workflow paused: ${okPaused} (${instancePaused?.status})`);
      const okStatus =
        snapClarify.request?.status === "Clarification Requested";
      checks4.push(`Clarification Requested: ${okStatus}`);
      const okRequestor =
        clarifyTask
        && String(clarifyTask.status).toLowerCase() === "pending"
        && (requestorMy.length > 0
          || String(clarifyTask.assignee) === admin.rows[0].employee_code
          || String(clarifyTask.assignment_assignee)
            === admin.rows[0].employee_code);
      checks4.push(
        `Requestor clarification task: ${okRequestor} (task=${clarifyTask?.task_id}, my=${requestorMy.length})`
      );
      const okRemoved = l1My.length === 0;
      checks4.push(
        `Approver task removed from My Approvals: ${okRemoved} (l1 rows=${l1My.length})`
      );

      const pass4 = okPaused && okStatus && okRequestor && okRemoved;
      record("Scenario 4 — Clarify", pass4, checks4);
      if (!pass4) overallFail = true;

      // Scenario 5 — Resubmit
      await workforcePlanningService.createBudgetRequest(
        pool,
        {
          id: requestId,
          ...criteria,
          justification: "S4 Clarify path — clarified justification."
        },
        requestorReq
      );
      await workforcePlanningService.submitBudgetClarification(
        pool,
        requestId,
        "Updated justification for review",
        requestorReq
      );

      const snap5 = await getBudget(client, requestId);
      const instance5 = await getInstance(client, instanceId);
      const tasks5 = await getTasks(client, instanceId);
      const approvalSteps = tasks5.filter((t) =>
        /Approval Step /.test(t.title || "")
      );
      const l1Again = approvalSteps.find((t) =>
        /Approval Step 1/.test(t.title || "")
      );
      const instancesCount = await client.query(
        `SELECT COUNT(*)::int AS c FROM wf_instances WHERE instance_id = $1`,
        [instanceId]
      );

      const checks5 = [];
      const sameInstance =
        snap5.request?.workflow_instance_id === instanceBefore
        && snap5.queue?.workflow_instance_id === instanceBefore;
      checks5.push(
        `SAME workflow instance: ${sameInstance} (${snap5.request?.workflow_instance_id})`
      );
      const sameRoute =
        JSON.stringify(snap5.queue?.approval_route_snapshot || null)
        === routeSnapBefore;
      checks5.push(`SAME approval_route_snapshot: ${sameRoute}`);
      const samePolicy =
        JSON.stringify(snap5.queue?.approval_policy_snapshot || null)
        === policySnapBefore;
      checks5.push(`SAME approval_policy_snapshot: ${samePolicy}`);
      const sameL1 =
        l1Again
        && String(l1Again.assignee) === l1
        && String(l1Again.status).toLowerCase() === "pending";
      checks5.push(
        `SAME L1 Approver Pending: ${sameL1} (assignee=${l1Again?.assignee}, status=${l1Again?.status})`
      );
      const noNewWf = instancesCount.rows[0].c === 1;
      checks5.push(`No new workflow instance row: ${noNewWf}`);
      const noDupes = approvalSteps.length === 2;
      checks5.push(
        `No duplicate approval tasks: ${noDupes} (count=${approvalSteps.length})`
      );
      const resumed =
        String(instance5?.status) === "Running"
        && snap5.request?.status === "Pending Level-1 Approval";
      checks5.push(
        `Resumed Running + Pending Level-1: ${resumed} (wf=${instance5?.status}, status=${snap5.request?.status})`
      );

      const pass5 =
        sameInstance
        && sameRoute
        && samePolicy
        && sameL1
        && noNewWf
        && noDupes
        && resumed;
      record("Scenario 5 — Clarification Resubmit", pass5, checks5);
      if (!pass5) overallFail = true;
    }

    // ------------------------------------------------------------------
    // Scenario 6 — Security
    // ------------------------------------------------------------------
    {
      const requestId = await createAndSubmit(
        pool,
        criteria,
        requestorReq,
        "S6 Security"
      );
      const checks = [];
      const bad = mockReq(nonApprover, "Recruiter");

      let approveBlocked = false;
      try {
        await workforcePlanningService.approveBudgetRequest(
          pool,
          requestId,
          "nope",
          bad
        );
      } catch (error) {
        approveBlocked = error.status === 403;
        checks.push(`Approve blocked: ${approveBlocked} (status=${error.status})`);
      }
      if (!approveBlocked) checks.push("Approve blocked: false (no error)");

      let rejectBlocked = false;
      try {
        await workforcePlanningService.rejectBudgetRequest(
          pool,
          requestId,
          "nope reject",
          bad
        );
      } catch (error) {
        rejectBlocked = error.status === 403;
        checks.push(`Reject blocked: ${rejectBlocked} (status=${error.status})`);
      }
      if (!rejectBlocked) checks.push("Reject blocked: false (no error)");

      let clarifyBlocked = false;
      try {
        await workforcePlanningService.requestBudgetClarification(
          pool,
          requestId,
          "nope clarify",
          bad
        );
      } catch (error) {
        clarifyBlocked = error.status === 403;
        checks.push(`Clarify blocked: ${clarifyBlocked} (status=${error.status})`);
      }
      if (!clarifyBlocked) checks.push("Clarify blocked: false (no error)");

      const snap = await getBudget(client, requestId);
      const stillL1 = snap.request?.status === "Pending Level-1 Approval";
      checks.push(`Budget unchanged Pending Level-1: ${stillL1}`);

      const pass =
        approveBlocked && rejectBlocked && clarifyBlocked && stillL1;
      record("Scenario 6 — Security", pass, checks);
      if (!pass) overallFail = true;
    }

    // ------------------------------------------------------------------
    // Scenario 7 — Route Freeze
    // ------------------------------------------------------------------
    {
      const requestId = await createAndSubmit(
        pool,
        criteria,
        requestorReq,
        "S7 Route freeze"
      );
      const instanceId = `WF-BR-${requestId}`;
      const snap0 = await getBudget(client, requestId);
      const frozenL2 =
        (snap0.queue?.approval_route_snapshot?.steps || [])[1]
          ?.approver_employee_code || l2;

      // Modify live route L2 to a different employee
      const other = await client.query(
        `SELECT employee_code FROM user_mstr
         WHERE is_active = TRUE
           AND employee_code IS NOT NULL
           AND employee_code <> $1
           AND employee_code <> $2
         ORDER BY user_id LIMIT 1`,
        [l1, frozenL2]
      );
      if (!other.rows[0]) {
        record("Scenario 7 — Route Freeze", false, [
          "Could not find alternate employee to mutate live route"
        ]);
        overallFail = true;
      } else {
        const mutated = other.rows[0].employee_code;
        await client.query(
          `UPDATE approval_route_step
           SET approver_employee_code = $2
           WHERE route_id = $1 AND sequence_no = 2`,
          [routeId, mutated]
        );

        await workforcePlanningService.approveBudgetRequest(
          pool,
          requestId,
          "L1 with frozen route",
          mockReq(l1, "Approver", "L1 Approver")
        );

        const tasks = await getTasks(client, instanceId);
        const l2Task = tasks.find((t) => /Approval Step 2/.test(t.title || ""));
        const snap = await getBudget(client, requestId);
        const snapshotL2 =
          (snap.queue?.approval_route_snapshot?.steps || [])[1]
            ?.approver_employee_code;

        const checks = [];
        const unaffectedAssignee =
          String(l2Task?.assignee) === String(frozenL2)
          && String(l2Task?.assignee) !== String(mutated);
        checks.push(
          `L2 task assignee still frozen snapshot (${frozenL2}), not mutated (${mutated}): ${unaffectedAssignee} (actual=${l2Task?.assignee})`
        );
        const snapUnchanged = String(snapshotL2) === String(frozenL2);
        checks.push(
          `approval_route_snapshot L2 unchanged: ${snapUnchanged} (${snapshotL2})`
        );

        // Restore live route for other tests
        await client.query(
          `UPDATE approval_route_step
           SET approver_employee_code = $2
           WHERE route_id = $1 AND sequence_no = 2`,
          [routeId, frozenL2]
        );

        const pass = unaffectedAssignee && snapUnchanged;
        record("Scenario 7 — Route Freeze", pass, checks);
        if (!pass) overallFail = true;
      }
    }

    // ------------------------------------------------------------------
    // Scenario 8 — Transaction rollback
    // ------------------------------------------------------------------
    {
      const requestId = await createAndSubmit(
        pool,
        criteria,
        requestorReq,
        "S8 Transaction rollback"
      );
      const instanceId = `WF-BR-${requestId}`;
      const beforeTasks = await getTasks(client, instanceId);
      const beforeSnap = await getBudget(client, requestId);

      const original = budgetWorkflowCompletionService.handleBudgetStepActivated;
      budgetWorkflowCompletionService.handleBudgetStepActivated = async () => {
        throw Object.assign(new Error("FORCE_TX_FAIL_VERIFICATION"), {
          status: 500
        });
      };

      let threw = false;
      try {
        await workforcePlanningService.approveBudgetRequest(
          pool,
          requestId,
          "should roll back",
          mockReq(l1, "Approver", "L1 Approver")
        );
      } catch (error) {
        threw = /FORCE_TX_FAIL_VERIFICATION/.test(error.message || "");
      } finally {
        budgetWorkflowCompletionService.handleBudgetStepActivated = original;
      }

      const afterTasks = await getTasks(client, instanceId);
      const afterSnap = await getBudget(client, requestId);
      const l1Before = beforeTasks.find((t) =>
        /Approval Step 1/.test(t.title || "")
      );
      const l1After = afterTasks.find((t) =>
        /Approval Step 1/.test(t.title || "")
      );
      const l2After = afterTasks.find((t) =>
        /Approval Step 2/.test(t.title || "")
      );

      const checks = [];
      checks.push(`Approve threw forced failure: ${threw}`);
      const l1StillPending =
        String(l1After?.status).toLowerCase() === "pending"
        && l1After?.active === true;
      checks.push(
        `L1 still Pending/active (no partial): ${l1StillPending} (was=${l1Before?.status}/${l1Before?.active}, now=${l1After?.status}/${l1After?.active})`
      );
      const l2StillWaiting =
        String(l2After?.status).toLowerCase() === "waiting"
        && l2After?.active !== true;
      checks.push(
        `L2 still Waiting/inactive: ${l2StillWaiting} (${l2After?.status}/${l2After?.active})`
      );
      const statusUnchanged =
        afterSnap.request?.status === "Pending Level-1 Approval"
        && beforeSnap.request?.status === "Pending Level-1 Approval";
      checks.push(`Budget status unchanged Pending Level-1: ${statusUnchanged}`);

      const pass =
        threw && l1StillPending && l2StillWaiting && statusUnchanged;
      record("Scenario 8 — Transaction Rollback", pass, checks);
      if (!pass) overallFail = true;
    }

    // ------------------------------------------------------------------
    // Scenario 9 — Concurrency
    // ------------------------------------------------------------------
    {
      const requestId = await createAndSubmit(
        pool,
        criteria,
        requestorReq,
        "S9 Concurrency"
      );
      const instanceId = `WF-BR-${requestId}`;
      const req = mockReq(l1, "Approver", "L1 Approver");

      const settled = await Promise.allSettled([
        workforcePlanningService.approveBudgetRequest(pool, requestId, "A", req),
        workforcePlanningService.approveBudgetRequest(pool, requestId, "B", req)
      ]);

      const successes = settled.filter((s) => s.status === "fulfilled");
      const failures = settled.filter((s) => s.status === "rejected");
      const tasks = await getTasks(client, instanceId);
      const l1Task = tasks.find((t) => /Approval Step 1/.test(t.title || ""));
      const snap = await getBudget(client, requestId);

      const checks = [];
      checks.push(`Exactly one success: ${successes.length === 1} (successes=${successes.length})`);
      checks.push(
        `Other received error: ${failures.length === 1} (failures=${failures.length}, msg=${failures[0]?.reason?.message || "n/a"})`
      );
      const okState =
        String(l1Task?.status).toLowerCase() === "completed"
        && snap.request?.status === "Pending Level-2 Approval";
      checks.push(
        `Post-state single L1 completion + L2 pending status: ${okState}`
      );

      const pass =
        successes.length === 1 && failures.length === 1 && okState;
      record("Scenario 9 — Concurrency", pass, checks);
      if (!pass) overallFail = true;
    }

    // ------------------------------------------------------------------
    // Scenario 10 — UI status consistency (data sources UI reads)
    // ------------------------------------------------------------------
    {
      const requestId = await createAndSubmit(
        pool,
        criteria,
        requestorReq,
        "S10 UI status consistency"
      );
      await workforcePlanningService.approveBudgetRequest(
        pool,
        requestId,
        "L1 for UI check",
        mockReq(l1, "Approver", "L1 Approver")
      );

      const snap = await getBudget(client, requestId);
      const reqStatus = snap.request?.status;
      const queueStatus = snap.queue?.status;
      const l2My = budgetRowsFor(await myApprovalsFor(l2), requestId);
      const workspaceWouldShow = queueStatus || reqStatus;
      const dashboardSource = reqStatus; // Budget Requests / dashboard read draft status

      const checks = [];
      const identical =
        reqStatus === queueStatus
        && reqStatus === "Pending Level-2 Approval"
        && workspaceWouldShow === "Pending Level-2 Approval";
      checks.push(
        `budget_requests === approval_queue === Pending Level-2: ${identical} (request=${reqStatus}, queue=${queueStatus})`
      );
      checks.push(
        `Approval Workspace source (queue) matches: ${workspaceWouldShow === reqStatus}`
      );
      checks.push(
        `My Approvals shows L2 active for same document: ${l2My.length === 1}`
      );
      const tl = timelineSteps(snap.queue);
      const hist = historyActions(snap.queue);
      checks.push(
        `Timeline present for workspace: ${tl.length > 0} [${tl.slice(-3).join(", ")}]`
      );
      checks.push(
        `History present for workspace: ${hist.length > 0 || tl.length > 0}`
      );
      checks.push(
        `Dashboard/Budget Requests status source: ${dashboardSource}`
      );

      const pass =
        identical
        && l2My.length === 1
        && tl.length > 0
        && (hist.length > 0 || tl.length > 0);
      record("Scenario 10 — UI Status Consistency", pass, checks);
      if (!pass) overallFail = true;
    }
  } finally {
    client.release();
    await pool.end();
  }

  console.log("\n==========================================================");
  console.log("SUMMARY");
  results.forEach((r) => {
    console.log(`${r.pass ? "PASS" : "FAIL"} — ${r.scenario}`);
  });
  console.log("==========================================================");

  if (overallFail || results.some((r) => !r.pass)) {
    console.log("\nNOT READY");
    process.exitCode = 1;
  } else {
    console.log("\nREADY FOR MANUAL USER ACCEPTANCE TESTING");
    process.exitCode = 0;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
