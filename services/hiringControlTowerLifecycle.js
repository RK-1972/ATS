const { REQUISITION_STATUS } = require("../constants/requisitionStatus");

const MILESTONE_KEYS = {
  BUDGET_SUBMITTED: "budget_submitted",
  BUDGET_APPROVED: "budget_approved",
  REQUISITION_CREATED: "requisition_created",
  REQUISITION_SUBMITTED: "requisition_submitted",
  REQUISITION_APPROVED: "requisition_approved",
  RECRUITER_ASSIGNED: "recruiter_assigned",
  CANDIDATE_PIPELINE: "candidate_pipeline",
  INTERVIEW_PROGRESS: "interview_progress",
  OFFER_PROGRESS: "offer_progress",
  HIRE_OUTCOME: "hire_outcome"
};

const BUDGET_PENDING_STATUSES = new Set([
  "Pending Level-1 Approval",
  "Pending Level-2 Approval"
]);

const BUDGET_BLOCKED_STATUSES = new Set([
  "Clarification Requested",
  "Rejected"
]);

const OFFER_TERMINAL_STATUSES = new Set([
  "Released",
  "Accepted",
  "Declined",
  "Withdrawn"
]);

const PRIMARY_CANDIDATE_RULE =
  "Most recently modified active rm_candidate_mappings row for the requisition.";

const PRIMARY_OFFER_RULE =
  "Most recently modified om_offers row for the requisition.";

function toIso(value) {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  const text = String(value).trim();
  if (!text) {
    return null;
  }

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? text : parsed.toISOString();
}

function normalizeStatus(value) {
  return String(value || "").trim();
}

function isJoinedStage(stageName) {
  return /join/i.test(String(stageName || ""));
}

function buildMilestone({
  key,
  label,
  status,
  timestamp = null,
  dueAt = null,
  sla = null,
  source = null,
  reason = null
}) {
  return {
    key,
    label,
    status,
    timestamp: toIso(timestamp),
    dueAt: toIso(dueAt),
    sla,
    source,
    reason
  };
}

async function loadBudgetChain(pool, requisition) {
  if (!requisition?.approved_position_id) {
    return { approvedPosition: null, budgetRequest: null };
  }

  const positionResult = await pool.query(
    `SELECT position_id, source_request_id, status, budget_approved, modified_on
     FROM wp_approved_positions
     WHERE position_id = $1`,
    [requisition.approved_position_id]
  );

  const approvedPosition = positionResult.rows[0] || null;

  if (!approvedPosition?.source_request_id) {
    return { approvedPosition, budgetRequest: null };
  }

  const budgetResult = await pool.query(
    `SELECT request_id, status, submitted_on, submitted_by, workflow_instance_id,
            current_approver, proposed_budget, modified_on
     FROM wp_budget_requests
     WHERE request_id = $1`,
    [approvedPosition.source_request_id]
  );

  return {
    approvedPosition,
    budgetRequest: budgetResult.rows[0] || null
  };
}

async function loadWorkflowSummary(pool, instanceId) {
  if (!instanceId) {
    return null;
  }

  const [instanceResult, tasksResult, historyResult] = await Promise.all([
    pool.query(
      `SELECT instance_id, workflow_code, status, current_stage_key, started_on, completed_on
       FROM wf_instances
       WHERE instance_id = $1`,
      [instanceId]
    ),
    pool.query(
      `SELECT task_id, title, status, assignee, assignee_role, due_at, completed_on, created_on
       FROM wf_tasks
       WHERE instance_id = $1
       ORDER BY created_on ASC, task_id ASC`,
      [instanceId]
    ),
    pool.query(
      `SELECT event_type, action, actor, recorded_on
       FROM wf_history
       WHERE instance_id = $1
       ORDER BY recorded_on ASC, history_id ASC`,
      [instanceId]
    )
  ]);

  const instance = instanceResult.rows[0];
  if (!instance) {
    return null;
  }

  const pendingTask = tasksResult.rows.find(
    (task) => normalizeStatus(task.status) === "Pending"
  );

  return {
    instance,
    tasks: tasksResult.rows,
    history: historyResult.rows,
    pendingDueAt: pendingTask?.due_at || null
  };
}

function resolveBudgetWorkflowInstanceId(budgetRequest) {
  if (!budgetRequest) {
    return null;
  }

  return budgetRequest.workflow_instance_id || `WF-BR-${budgetRequest.request_id}`;
}

function hasWorkflowSubmissionSignal(workflowSummary) {
  if (!workflowSummary) {
    return false;
  }

  if (workflowSummary.instance?.started_on) {
    return true;
  }

  return workflowSummary.history.some((event) => {
    const type = normalizeStatus(event.event_type).toLowerCase();
    const action = normalizeStatus(event.action).toLowerCase();
    return type.includes("submit") || action.includes("submit");
  });
}

function buildBudgetSubmittedMilestone(budgetRequest, budgetWorkflow) {
  if (!budgetRequest) {
    return buildMilestone({
      key: MILESTONE_KEYS.BUDGET_SUBMITTED,
      label: "Budget Submitted",
      status: "Not Applicable",
      source: "wp_budget_requests",
      reason: "No linked budget request for this requisition."
    });
  }

  const status = normalizeStatus(budgetRequest.status);
  const submittedOn = budgetRequest.submitted_on;
  const workflowSubmitted = hasWorkflowSubmissionSignal(budgetWorkflow);

  if (BUDGET_BLOCKED_STATUSES.has(status)) {
    return buildMilestone({
      key: MILESTONE_KEYS.BUDGET_SUBMITTED,
      label: "Budget Submitted",
      status: "Blocked",
      timestamp: submittedOn || budgetWorkflow?.instance?.started_on || null,
      dueAt: budgetWorkflow?.pendingDueAt || null,
      sla: null,
      source: "wp_budget_requests.status",
      reason: `Budget request is ${status}.`
    });
  }

  if (submittedOn || workflowSubmitted || BUDGET_PENDING_STATUSES.has(status) || status === "Approved") {
    return buildMilestone({
      key: MILESTONE_KEYS.BUDGET_SUBMITTED,
      label: "Budget Submitted",
      status: "Completed",
      timestamp: submittedOn || budgetWorkflow?.instance?.started_on || null,
      dueAt: budgetWorkflow?.pendingDueAt || null,
      sla: null,
      source: submittedOn
        ? "wp_budget_requests.submitted_on"
        : "wf_instances.started_on",
      reason: submittedOn
        ? "Budget request submitted."
        : "Budget workflow started without explicit submitted_on."
    });
  }

  if (status === "Draft") {
    return buildMilestone({
      key: MILESTONE_KEYS.BUDGET_SUBMITTED,
      label: "Budget Submitted",
      status: "Not Started",
      source: "wp_budget_requests.status",
      reason: "Budget request remains in Draft."
    });
  }

  return buildMilestone({
    key: MILESTONE_KEYS.BUDGET_SUBMITTED,
    label: "Budget Submitted",
    status: "Not Started",
    source: "wp_budget_requests",
    reason: "Budget submission is not evidenced by submitted_on or workflow history."
  });
}

function buildBudgetApprovedMilestone(budgetRequest, approvedPosition, budgetWorkflow) {
  if (!budgetRequest && !approvedPosition) {
    return buildMilestone({
      key: MILESTONE_KEYS.BUDGET_APPROVED,
      label: "Budget Approved",
      status: "Not Applicable",
      source: "wp_approved_positions",
      reason: "No linked approved position or budget request."
    });
  }

  const budgetStatus = normalizeStatus(budgetRequest?.status);
  const positionStatus = normalizeStatus(approvedPosition?.status);

  if (BUDGET_BLOCKED_STATUSES.has(budgetStatus)) {
    return buildMilestone({
      key: MILESTONE_KEYS.BUDGET_APPROVED,
      label: "Budget Approved",
      status: "Blocked",
      timestamp: budgetWorkflow?.instance?.completed_on || budgetRequest?.modified_on || null,
      source: "wp_budget_requests.status",
      reason: `Budget request is ${budgetStatus}.`
    });
  }

  if (budgetStatus === "Approved" || (approvedPosition && positionStatus === "Active")) {
    return buildMilestone({
      key: MILESTONE_KEYS.BUDGET_APPROVED,
      label: "Budget Approved",
      status: "Completed",
      timestamp: approvedPosition?.modified_on || budgetWorkflow?.instance?.completed_on || null,
      source: "wp_approved_positions",
      reason: approvedPosition
        ? "Approved position exists in catalogue."
        : "Budget request status is Approved."
    });
  }

  if (BUDGET_PENDING_STATUSES.has(budgetStatus)) {
    return buildMilestone({
      key: MILESTONE_KEYS.BUDGET_APPROVED,
      label: "Budget Approved",
      status: "In Progress",
      timestamp: budgetRequest?.submitted_on || budgetWorkflow?.instance?.started_on || null,
      dueAt: budgetWorkflow?.pendingDueAt || null,
      sla: null,
      source: "wp_budget_requests.status",
      reason: `Budget approval is ${budgetStatus}.`
    });
  }

  return buildMilestone({
    key: MILESTONE_KEYS.BUDGET_APPROVED,
    label: "Budget Approved",
    status: "Not Started",
    source: "wp_budget_requests.status",
    reason: "Budget has not reached an approved state."
  });
}

function buildRequisitionCreatedMilestone(requisition) {
  return buildMilestone({
    key: MILESTONE_KEYS.REQUISITION_CREATED,
    label: "Requisition Created",
    status: "Completed",
    timestamp: requisition.created_on,
    source: "rm_requisitions.created_on",
    reason: "Requisition record exists."
  });
}

function buildRequisitionSubmittedMilestone(requisition, reqWorkflow) {
  const reqStatus = normalizeStatus(requisition.req_status);
  const submittedOn = requisition.requestor_submitted_on;
  const workflowSubmitted = hasWorkflowSubmissionSignal(reqWorkflow);

  if (reqStatus === REQUISITION_STATUS.REJECTED) {
    return buildMilestone({
      key: MILESTONE_KEYS.REQUISITION_SUBMITTED,
      label: "Requisition Submitted",
      status: "Blocked",
      timestamp: submittedOn || reqWorkflow?.instance?.started_on || null,
      source: "rm_requisitions.req_status",
      reason: "Requisition is Rejected."
    });
  }

  if (reqStatus === REQUISITION_STATUS.CLARIFICATION_REQUESTED) {
    return buildMilestone({
      key: MILESTONE_KEYS.REQUISITION_SUBMITTED,
      label: "Requisition Submitted",
      status: "Blocked",
      timestamp: submittedOn || reqWorkflow?.instance?.started_on || null,
      dueAt: reqWorkflow?.pendingDueAt || null,
      source: "rm_requisitions.req_status",
      reason: "Requisition is awaiting clarification."
    });
  }

  if (submittedOn || workflowSubmitted) {
    return buildMilestone({
      key: MILESTONE_KEYS.REQUISITION_SUBMITTED,
      label: "Requisition Submitted",
      status: "Completed",
      timestamp: submittedOn || reqWorkflow?.instance?.started_on || null,
      dueAt: reqWorkflow?.pendingDueAt || null,
      sla: null,
      source: submittedOn
        ? "rm_requisitions.requestor_submitted_on"
        : "wf_history",
      reason: submittedOn
        ? "Requestor submission timestamp recorded."
        : "Submission evidenced by requisition workflow history."
    });
  }

  if (
    reqStatus === REQUISITION_STATUS.PENDING_LEVEL_1
    || reqStatus === REQUISITION_STATUS.PENDING_LEVEL_2
  ) {
    return buildMilestone({
      key: MILESTONE_KEYS.REQUISITION_SUBMITTED,
      label: "Requisition Submitted",
      status: "Not Started",
      source: "rm_requisitions.requestor_submitted_on",
      reason: "Requisition is in approval, but submission is not explicitly recorded."
    });
  }

  if (reqStatus === REQUISITION_STATUS.APPROVED) {
    return buildMilestone({
      key: MILESTONE_KEYS.REQUISITION_SUBMITTED,
      label: "Requisition Submitted",
      status: "Not Started",
      source: "rm_requisitions.requestor_submitted_on",
      reason: "Requisition is Approved, but submission cannot be proven from available signals."
    });
  }

  return buildMilestone({
    key: MILESTONE_KEYS.REQUISITION_SUBMITTED,
    label: "Requisition Submitted",
    status: "Not Started",
    source: "rm_requisitions.requestor_submitted_on",
    reason: "Requisition has not been submitted."
  });
}

function buildRequisitionApprovedMilestone(requisition, reqWorkflow) {
  const reqStatus = normalizeStatus(requisition.req_status);

  if (reqStatus === REQUISITION_STATUS.REJECTED) {
    return buildMilestone({
      key: MILESTONE_KEYS.REQUISITION_APPROVED,
      label: "Requisition Approved",
      status: "Blocked",
      timestamp: requisition.modified_on,
      source: "rm_requisitions.req_status",
      reason: "Requisition is Rejected."
    });
  }

  if (reqStatus === REQUISITION_STATUS.CLARIFICATION_REQUESTED) {
    return buildMilestone({
      key: MILESTONE_KEYS.REQUISITION_APPROVED,
      label: "Requisition Approved",
      status: "Blocked",
      timestamp: requisition.modified_on,
      dueAt: reqWorkflow?.pendingDueAt || null,
      source: "rm_requisitions.req_status",
      reason: "Requisition is awaiting clarification."
    });
  }

  if (reqStatus === REQUISITION_STATUS.APPROVED) {
    return buildMilestone({
      key: MILESTONE_KEYS.REQUISITION_APPROVED,
      label: "Requisition Approved",
      status: "Completed",
      timestamp: requisition.modified_on,
      source: "rm_requisitions.req_status",
      reason: "Requisition status is Approved."
    });
  }

  if (
    reqStatus === REQUISITION_STATUS.PENDING_LEVEL_1
    || reqStatus === REQUISITION_STATUS.PENDING_LEVEL_2
  ) {
    return buildMilestone({
      key: MILESTONE_KEYS.REQUISITION_APPROVED,
      label: "Requisition Approved",
      status: "In Progress",
      timestamp: requisition.modified_on,
      dueAt: reqWorkflow?.pendingDueAt || null,
      sla: null,
      source: "rm_requisitions.req_status",
      reason: `Requisition approval is ${reqStatus}.`
    });
  }

  return buildMilestone({
    key: MILESTONE_KEYS.REQUISITION_APPROVED,
    label: "Requisition Approved",
    status: "Not Started",
    source: "rm_requisitions.req_status",
    reason: `Current requisition status is ${reqStatus || "Unknown"}.`
  });
}

function buildRecruiterAssignedMilestone(assignments, requisitionApproved) {
  if (!requisitionApproved) {
    return buildMilestone({
      key: MILESTONE_KEYS.RECRUITER_ASSIGNED,
      label: "Recruiter Assigned",
      status: "Not Applicable",
      source: "rm_recruiter_assignments",
      reason: "Requisition is not Approved yet."
    });
  }

  const activeAssignments = assignments.filter((row) => row.is_active === true);

  if (!activeAssignments.length) {
    return buildMilestone({
      key: MILESTONE_KEYS.RECRUITER_ASSIGNED,
      label: "Recruiter Assigned",
      status: "Not Started",
      source: "rm_recruiter_assignments",
      reason: "No active recruiter assignment."
    });
  }

  const latest = activeAssignments.reduce((current, row) => {
    if (!current) {
      return row;
    }

    return new Date(row.assigned_on) > new Date(current.assigned_on) ? row : current;
  }, null);

  return buildMilestone({
    key: MILESTONE_KEYS.RECRUITER_ASSIGNED,
    label: "Recruiter Assigned",
    status: "Completed",
    timestamp: latest?.assigned_on || null,
    source: "rm_recruiter_assignments",
    reason: `${activeAssignments.length} active recruiter assignment(s).`
  });
}

function buildCandidatePipelineMilestone(mappings, requisitionApproved) {
  if (!requisitionApproved) {
    return buildMilestone({
      key: MILESTONE_KEYS.CANDIDATE_PIPELINE,
      label: "Candidate Pipeline",
      status: "Not Applicable",
      source: "rm_candidate_mappings",
      reason: "Requisition is not Approved yet."
    });
  }

  const activeMappings = mappings.filter((row) => row.is_active === true);

  if (!activeMappings.length) {
    return buildMilestone({
      key: MILESTONE_KEYS.CANDIDATE_PIPELINE,
      label: "Candidate Pipeline",
      status: "Not Started",
      source: "rm_candidate_mappings",
      reason: "No active candidate mappings."
    });
  }

  const joinedCount = activeMappings.filter((row) => isJoinedStage(row.stage_name)).length;
  const offerStageCount = activeMappings.filter((row) => /offer/i.test(row.stage_name || "")).length;

  return buildMilestone({
    key: MILESTONE_KEYS.CANDIDATE_PIPELINE,
    label: "Candidate Pipeline",
    status: "In Progress",
    timestamp: activeMappings[0]?.applied_on || null,
    source: "rm_candidate_mappings",
    reason: `${activeMappings.length} active candidate(s); ${offerStageCount} in offer stage; ${joinedCount} with joined-stage text.`
  });
}

function buildInterviewProgressMilestone(interviews, activeCandidateCount) {
  if (activeCandidateCount === 0) {
    return buildMilestone({
      key: MILESTONE_KEYS.INTERVIEW_PROGRESS,
      label: "Interview Progress",
      status: "Not Applicable",
      source: "im_interviews",
      reason: "No active candidates on this requisition."
    });
  }

  if (!interviews.length) {
    return buildMilestone({
      key: MILESTONE_KEYS.INTERVIEW_PROGRESS,
      label: "Interview Progress",
      status: "Not Started",
      source: "im_interviews",
      reason: "No interviews recorded."
    });
  }

  const completedCount = interviews.filter(
    (row) => row.feedback_submitted === true || normalizeStatus(row.interview_status) === "Completed"
  ).length;
  const scheduledCount = interviews.filter(
    (row) => normalizeStatus(row.interview_status) === "Scheduled"
  ).length;
  const feedbackPendingCount = interviews.filter(
    (row) => row.feedback_submitted !== true && normalizeStatus(row.interview_status) !== "Completed"
  ).length;

  const allRecordedComplete = completedCount === interviews.length;

  return buildMilestone({
    key: MILESTONE_KEYS.INTERVIEW_PROGRESS,
    label: "Interview Progress",
    status: allRecordedComplete ? "Completed" : "In Progress",
    timestamp: interviews[0]?.modified_on || interviews[0]?.created_on || null,
    source: "im_interviews",
    reason: `${interviews.length} interview(s): ${scheduledCount} scheduled, ${completedCount} completed, ${feedbackPendingCount} feedback pending. Required rounds are not defined in schema.`
  });
}

function buildOfferProgressMilestone(offers, activeCandidateCount) {
  if (activeCandidateCount === 0 && !offers.length) {
    return buildMilestone({
      key: MILESTONE_KEYS.OFFER_PROGRESS,
      label: "Offer Progress",
      status: "Not Applicable",
      source: "om_offers",
      reason: "No candidates or offers on this requisition."
    });
  }

  if (!offers.length) {
    return buildMilestone({
      key: MILESTONE_KEYS.OFFER_PROGRESS,
      label: "Offer Progress",
      status: "Not Started",
      source: "om_offers",
      reason: "No offers recorded."
    });
  }

  const primaryOffer = offers[0];
  const offerStatus = normalizeStatus(primaryOffer.offer_status);

  if (offerStatus === "Draft") {
    return buildMilestone({
      key: MILESTONE_KEYS.OFFER_PROGRESS,
      label: "Offer Progress",
      status: "In Progress",
      timestamp: primaryOffer.created_on,
      source: "om_offers.offer_status",
      reason: `${offers.length} offer(s); primary offer is Draft.`
    });
  }

  if (/pending/i.test(offerStatus)) {
    return buildMilestone({
      key: MILESTONE_KEYS.OFFER_PROGRESS,
      label: "Offer Progress",
      status: "In Progress",
      timestamp: primaryOffer.modified_on,
      source: "om_offers.offer_status",
      reason: `${offers.length} offer(s); primary offer is ${offerStatus}.`
    });
  }

  if (offerStatus === "Approved") {
    return buildMilestone({
      key: MILESTONE_KEYS.OFFER_PROGRESS,
      label: "Offer Progress",
      status: "In Progress",
      timestamp: primaryOffer.modified_on,
      source: "om_offers.offer_status",
      reason: `${offers.length} offer(s); primary offer is Approved and not yet released.`
    });
  }

  if (OFFER_TERMINAL_STATUSES.has(offerStatus)) {
    return buildMilestone({
      key: MILESTONE_KEYS.OFFER_PROGRESS,
      label: "Offer Progress",
      status: "Completed",
      timestamp: primaryOffer.modified_on,
      source: "om_offers.offer_status",
      reason: `${offers.length} offer(s); primary offer is ${offerStatus}.`
    });
  }

  return buildMilestone({
    key: MILESTONE_KEYS.OFFER_PROGRESS,
    label: "Offer Progress",
    status: "In Progress",
    timestamp: primaryOffer.modified_on,
    source: "om_offers.offer_status",
    reason: `${offers.length} offer(s); primary offer status is ${offerStatus || "Unknown"}.`
  });
}

function buildHireOutcomeMilestone(offers, acceptances, mappings) {
  if (!offers.length) {
    return buildMilestone({
      key: MILESTONE_KEYS.HIRE_OUTCOME,
      label: "Hire Outcome",
      status: "Not Applicable",
      source: "om_offer_acceptance",
      reason: "No offers on this requisition."
    });
  }

  const acceptedOffer = offers.find(
    (offer) => normalizeStatus(offer.offer_status) === "Accepted"
  );
  const acceptanceRow = acceptances.find(
    (row) => normalizeStatus(row.response_status) === "Accepted"
  );

  const joinedMappings = mappings.filter(
    (row) => row.is_active === true && isJoinedStage(row.stage_name)
  );

  if (acceptedOffer || acceptanceRow) {
    return buildMilestone({
      key: MILESTONE_KEYS.HIRE_OUTCOME,
      label: "Hire Outcome",
      status: "Completed",
      timestamp: acceptanceRow?.accepted_on || acceptedOffer?.modified_on || null,
      source: acceptanceRow ? "om_offer_acceptance.accepted_on" : "om_offers.offer_status",
      reason: joinedMappings.length
        ? "Offer accepted; joined-stage text also present (derived, fragile)."
        : "Offer accepted."
    });
  }

  const releasedOffer = offers.find(
    (offer) => normalizeStatus(offer.offer_status) === "Released"
  );

  if (releasedOffer) {
    return buildMilestone({
      key: MILESTONE_KEYS.HIRE_OUTCOME,
      label: "Hire Outcome",
      status: "In Progress",
      timestamp: releasedOffer.modified_on,
      source: "om_offers.offer_status",
      reason: joinedMappings.length
        ? "Offer released; joined-stage text exists but acceptance is not recorded (derived, fragile)."
        : "Offer released; acceptance not recorded."
    });
  }

  if (joinedMappings.length) {
    return buildMilestone({
      key: MILESTONE_KEYS.HIRE_OUTCOME,
      label: "Hire Outcome",
      status: "In Progress",
      timestamp: joinedMappings[0]?.modified_on || null,
      source: "rm_candidate_mappings.stage_name",
      reason: "Joined-stage text detected without recorded offer acceptance (derived, fragile)."
    });
  }

  return buildMilestone({
    key: MILESTONE_KEYS.HIRE_OUTCOME,
    label: "Hire Outcome",
    status: "Not Started",
    source: "om_offer_acceptance",
    reason: "No offer acceptance recorded."
  });
}

async function loadLifecycleContext(pool, requisition) {
  const requisitionCode = requisition.requisition_code;
  const requisitionApproved =
    normalizeStatus(requisition.req_status) === REQUISITION_STATUS.APPROVED;

  const [budgetChain, assignmentsResult, mappingsResult, interviewsResult, offersResult] =
    await Promise.all([
      loadBudgetChain(pool, requisition),
      pool.query(
        `SELECT assignment_id, recruiter_code, assigned_on, assigned_by, is_active
         FROM rm_recruiter_assignments
         WHERE requisition_code = $1
         ORDER BY assigned_on DESC`,
        [requisitionCode]
      ),
      pool.query(
        `SELECT mapping_id, candidate_id, candidate_code, stage_name, is_active,
                applied_on, modified_on
         FROM rm_candidate_mappings
         WHERE requisition_code = $1
         ORDER BY modified_on DESC NULLS LAST, applied_on DESC`,
        [requisitionCode]
      ),
      pool.query(
        `SELECT interview_id, candidate_id, round_type, interview_status,
                feedback_submitted, final_outcome, created_on, modified_on
         FROM im_interviews
         WHERE requisition_code = $1
         ORDER BY modified_on DESC NULLS LAST, created_on DESC`,
        [requisitionCode]
      ),
      pool.query(
        `SELECT offer_id, candidate_id, mapping_id, offer_status, offered_ctc,
                approved_budget, variance_pct, workflow_instance_id,
                created_on, modified_on
         FROM om_offers
         WHERE requisition_code = $1
         ORDER BY modified_on DESC NULLS LAST, created_on DESC`,
        [requisitionCode]
      )
    ]);

  const { approvedPosition, budgetRequest } = budgetChain;
  const assignments = assignmentsResult.rows;
  const mappings = mappingsResult.rows;
  const interviews = interviewsResult.rows;
  const offers = offersResult.rows;

  const offerIds = offers.map((row) => row.offer_id);
  let acceptances = [];

  if (offerIds.length) {
    const acceptanceResult = await pool.query(
      `SELECT offer_id, response_status, accepted_on, declined_on, pre_onboarding_status
       FROM om_offer_acceptance
       WHERE offer_id = ANY($1::varchar[])`,
      [offerIds]
    );
    acceptances = acceptanceResult.rows;
  }

  const [budgetWorkflow, reqWorkflow] = await Promise.all([
    loadWorkflowSummary(pool, resolveBudgetWorkflowInstanceId(budgetRequest)),
    loadWorkflowSummary(pool, requisition.workflow_instance_id)
  ]);

  const activeMappings = mappings.filter((row) => row.is_active === true);
  const activeAssignments = assignments.filter((row) => row.is_active === true);

  const milestones = [
    buildBudgetSubmittedMilestone(budgetRequest, budgetWorkflow),
    buildBudgetApprovedMilestone(budgetRequest, approvedPosition, budgetWorkflow),
    buildRequisitionCreatedMilestone(requisition),
    buildRequisitionSubmittedMilestone(requisition, reqWorkflow),
    buildRequisitionApprovedMilestone(requisition, reqWorkflow),
    buildRecruiterAssignedMilestone(assignments, requisitionApproved),
    buildCandidatePipelineMilestone(mappings, requisitionApproved),
    buildInterviewProgressMilestone(interviews, activeMappings.length),
    buildOfferProgressMilestone(offers, activeMappings.length),
    buildHireOutcomeMilestone(offers, acceptances, mappings)
  ];

  const stageSummary = activeMappings.reduce((acc, row) => {
    const stage = normalizeStatus(row.stage_name) || "Unknown";
    acc[stage] = (acc[stage] || 0) + 1;
    return acc;
  }, {});

  return {
    requisition,
    requisitionApproved,
    budgetRequest,
    approvedPosition,
    budgetWorkflow,
    reqWorkflow,
    assignments,
    mappings,
    interviews,
    offers,
    acceptances,
    activeMappings,
    activeAssignments,
    milestones,
    summary: {
      activeCandidateCount: activeMappings.length,
      recruiterCount: activeAssignments.length,
      interviewCount: interviews.length,
      offerCount: offers.length,
      scheduledInterviewCount: interviews.filter(
        (row) => normalizeStatus(row.interview_status) === "Scheduled"
      ).length,
      completedInterviewCount: interviews.filter(
        (row) => row.feedback_submitted === true || normalizeStatus(row.interview_status) === "Completed"
      ).length,
      feedbackPendingCount: interviews.filter(
        (row) => row.feedback_submitted !== true && normalizeStatus(row.interview_status) !== "Completed"
      ).length,
      candidateStageSummary: stageSummary,
      assignedRecruiters: activeAssignments.map((row) => row.recruiter_code),
      primaryCandidate: activeMappings[0]
        ? {
            mapping_id: activeMappings[0].mapping_id,
            candidate_id: activeMappings[0].candidate_id,
            stage_name: activeMappings[0].stage_name
          }
        : null,
      primaryOffer: offers[0]
        ? {
            offer_id: offers[0].offer_id,
            offer_status: offers[0].offer_status,
            candidate_id: offers[0].candidate_id
          }
        : null
    },
    metadata: {
      aggregationNotes: [
        "Lifecycle is aggregated server-side from existing operational tables.",
        "Interview completion does not assume required round counts.",
        "Joined detection from pipeline stage text is derived and fragile."
      ],
      primaryCandidateRule: PRIMARY_CANDIDATE_RULE,
      primaryOfferRule: PRIMARY_OFFER_RULE,
      joinedSignalFragile: activeMappings.some((row) => isJoinedStage(row.stage_name))
    }
  };
}

async function buildLifecycleSnapshot(pool, requisition) {
  const ctx = await loadLifecycleContext(pool, requisition);

  return {
    requisition: {
      requisition_code: requisition.requisition_code,
      position_title: requisition.position_title || requisition.approved_position_title || null,
      department: requisition.department || requisition.approved_department || null,
      grade: requisition.grade || requisition.approved_grade || null,
      req_status: requisition.req_status || null
    },
    milestones: ctx.milestones,
    summary: ctx.summary,
    metadata: ctx.metadata
  };
}

module.exports = {
  MILESTONE_KEYS,
  PRIMARY_CANDIDATE_RULE,
  PRIMARY_OFFER_RULE,
  loadLifecycleContext,
  buildLifecycleSnapshot,
  resolveBudgetWorkflowInstanceId
};
