const recruitmentService = require("./recruitmentService");
const {
  MILESTONE_KEYS,
  loadLifecycleContext,
  resolveBudgetWorkflowInstanceId
} = require("./hiringControlTowerLifecycle");

const VALID_MILESTONE_KEYS = new Set(Object.values(MILESTONE_KEYS));
const MAX_LIST = 20;

const UNSUPPORTED_FIELDS = [
  "sla_hours",
  "sla_remaining_hours",
  "completion_pct",
  "ai_recommendations",
  "notification_deliveries",
  "business_rule_execution",
  "formal_hire_completion"
];

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function normalizeStatus(value) {
  return String(value || "").trim();
}

function formatDisplayDate(value) {
  if (!value) {
    return null;
  }

  const parsed = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    return String(value);
  }

  return parsed.toISOString();
}

function detail(label, value, availability = "real") {
  const text = value === null || value === undefined || String(value).trim() === ""
    ? "Not available"
    : String(value);

  return { label, value: text, availability };
}

function metric(key, label, value, subtitle = "", availability = "real") {
  return {
    key,
    label,
    value: value === null || value === undefined ? "Not available" : String(value),
    subtitle,
    availability
  };
}

function truncateList(items, max = MAX_LIST) {
  if (!items?.length) {
    return { items: [], truncated: false };
  }

  if (items.length <= max) {
    return { items, truncated: false };
  }

  return { items: items.slice(0, max), truncated: true };
}

async function resolveEmployeeDisplayNames(pool, employeeCodes = []) {
  const codes = [...new Set(
    employeeCodes.map((code) => String(code || "").trim()).filter(Boolean)
  )];

  if (!codes.length) {
    return new Map();
  }

  const result = await pool.query(
    `SELECT employee_code, full_name
     FROM user_mstr
     WHERE employee_code = ANY($1::varchar[])`,
    [codes]
  );

  return new Map(
    result.rows.map((row) => [row.employee_code, row.full_name || row.employee_code])
  );
}

async function resolveCandidateNames(pool, candidateIds = []) {
  const ids = [...new Set(
    candidateIds.map((id) => String(id || "").trim()).filter(Boolean)
  )];

  if (!ids.length) {
    return new Map();
  }

  const result = await pool.query(
    `SELECT candidate_id, candidate_code,
            COALESCE(NULLIF(TRIM(first_name || ' ' || last_name), ''), candidate_code) AS display_name
     FROM cand_mstr
     WHERE candidate_id::text = ANY($1::varchar[])
        OR candidate_code = ANY($1::varchar[])`,
    [ids]
  );

  const map = new Map();

  for (const row of result.rows) {
    map.set(String(row.candidate_id), row.display_name);
    if (row.candidate_code) {
      map.set(String(row.candidate_code), row.display_name);
    }
  }

  return map;
}

async function resolveApprovalRouteName(pool, routeId) {
  if (!routeId) {
    return null;
  }

  const result = await pool.query(
    `SELECT route_name
     FROM approval_route_mstr
     WHERE route_id = $1
     LIMIT 1`,
    [routeId]
  );

  return result.rows[0]?.route_name || null;
}

async function loadWorkflowInspectorSections(pool, instanceId, statusLabel) {
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
      `SELECT history_id, event_type, stage_key, actor, actor_role, action, comments, recorded_on
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

  const nameMap = await resolveEmployeeDisplayNames(
    pool,
    tasksResult.rows.map((row) => row.assignee).filter(Boolean)
  );

  const pendingTask = tasksResult.rows.find(
    (task) => normalizeStatus(task.status) === "Pending"
  );

  const approvalSteps = tasksResult.rows
    .filter((task) => /approval|approve/i.test(String(task.title || "")))
    .map((task, index) => ({
      step: index + 1,
      title: task.title,
      approver_name: nameMap.get(task.assignee) || task.assignee || null,
      approver_employee_code: task.assignee || null,
      approver_role: task.assignee_role || null,
      status: task.status,
      action_on: formatDisplayDate(task.completed_on),
      availability: "real"
    }));

  const { items: timeline, truncated } = truncateList(
    historyResult.rows.map((event) => ({
      event_type: event.event_type,
      action: event.action,
      actor: event.actor || null,
      actor_role: event.actor_role || null,
      recorded_on: formatDisplayDate(event.recorded_on),
      comment: event.comments || null,
      availability: "real"
    }))
  );

  return {
    instance_id: instance.instance_id,
    workflow_code: instance.workflow_code || null,
    status: instance.status || statusLabel || null,
    pending_task: pendingTask
      ? {
          title: pendingTask.title,
          assignee: nameMap.get(pendingTask.assignee) || pendingTask.assignee || null,
          assignee_role: pendingTask.assignee_role || null,
          due_at: formatDisplayDate(pendingTask.due_at),
          availability: "real"
        }
      : null,
    approval_steps: approvalSteps,
    timeline,
    timeline_truncated: truncated,
    clarification_rounds: [],
    availability: "real"
  };
}

async function loadOfferHistory(pool, offerIds) {
  if (!offerIds.length) {
    return { items: [], truncated: false };
  }

  const result = await pool.query(
    `SELECT history_id, offer_id, event_type, actor, actor_role,
            from_status, to_status, comments, created_on
     FROM om_offer_history
     WHERE offer_id = ANY($1::varchar[])
     ORDER BY created_on DESC, history_id DESC
     LIMIT $2`,
    [offerIds, MAX_LIST + 1]
  );

  return truncateList(
    result.rows.map((row) => ({
      offer_id: row.offer_id,
      event_type: row.event_type,
      actor: row.actor || null,
      actor_role: row.actor_role || null,
      from_status: row.from_status || null,
      to_status: row.to_status || null,
      comment: row.comments || null,
      recorded_on: formatDisplayDate(row.created_on),
      availability: "real"
    }))
  );
}

function buildBudgetSubmittedSections(ctx, workflow) {
  const { budgetRequest, summary } = ctx;
  const sections = {
    key_metrics: [],
    details: [],
    related_records: {},
    history: [],
    navigation: []
  };

  if (!budgetRequest) {
    sections.details.push(
      detail("Budget request", "No linked budget request", "real")
    );
    return sections;
  }

  sections.key_metrics = [
    metric("budget_status", "Budget status", budgetRequest.status, "Current request state"),
    metric(
      "proposed_budget",
      "Proposed budget",
      budgetRequest.proposed_budget != null ? String(budgetRequest.proposed_budget) : "Not available",
      "Submitted amount"
    )
  ];

  sections.details = [
    detail("Request ID", budgetRequest.request_id),
    detail("Status", budgetRequest.status),
    detail("Submitted on", formatDisplayDate(budgetRequest.submitted_on)),
    detail("Submitted by", budgetRequest.submitted_by, "partial"),
    detail("Current approver", budgetRequest.current_approver, "partial"),
    detail("Workflow instance", budgetRequest.workflow_instance_id || resolveBudgetWorkflowInstanceId(budgetRequest), "real")
  ];

  if (workflow) {
    sections.workflow = workflow;
    sections.history = workflow.timeline || [];
  }

  if (summary?.offerCount != null) {
    sections.details.push(detail("Linked requisition offers", String(summary.offerCount), "derived"));
  }

  return sections;
}

function buildBudgetApprovedSections(ctx, workflow) {
  const { approvedPosition, budgetRequest } = ctx;
  const sections = {
    key_metrics: [],
    details: [],
    related_records: {},
    history: [],
    navigation: []
  };

  if (!approvedPosition && !budgetRequest) {
    sections.details.push(detail("Approved position", "No linked approved position", "real"));
    return sections;
  }

  if (approvedPosition) {
    sections.key_metrics = [
      metric("position_status", "Position status", approvedPosition.status, "Catalogue state"),
      metric(
        "budget_approved",
        "Budget approved",
        approvedPosition.budget_approved != null
          ? String(approvedPosition.budget_approved)
          : "Not available"
      )
    ];

    sections.details = [
      detail("Position ID", approvedPosition.position_id),
      detail("Status", approvedPosition.status),
      detail("Budget approved", approvedPosition.budget_approved),
      detail("Last modified", formatDisplayDate(approvedPosition.modified_on)),
      detail("Source request", budgetRequest?.request_id || "Not available", "real")
    ];
  } else {
    sections.details = [
      detail("Budget status", budgetRequest?.status || "Not available")
    ];
  }

  if (workflow) {
    sections.workflow = workflow;
    sections.history = workflow.timeline || [];
  }

  return sections;
}

async function buildRequisitionCreatedSectionsWithPool(pool, ctx) {
  const { requisition } = ctx;
  const nameMap = await resolveEmployeeDisplayNames(pool, [requisition.created_by]);
  const createdByName = nameMap.get(requisition.created_by) || requisition.created_by || "Not available";

  return {
    key_metrics: [
      metric("req_status", "Status", requisition.req_status, "Current requisition state"),
      metric("headcount", "Headcount", requisition.headcount ?? "Not available")
    ],
    details: [
      detail("Requisition code", requisition.requisition_code),
      detail("Position title", requisition.position_title || requisition.approved_position_title),
      detail("Department", requisition.department || requisition.approved_department),
      detail("Grade", requisition.grade || requisition.approved_grade),
      detail("Hiring manager", requisition.hiring_manager),
      detail("Created on", formatDisplayDate(requisition.created_on)),
      detail("Created by", createdByName, requisition.created_by ? "partial" : "unsupported"),
      detail("Priority", requisition.priority_level),
      detail("Target date", formatDisplayDate(requisition.target_date))
    ],
    related_records: {},
    history: [],
    navigation: []
  };
}

async function buildRequisitionSubmittedSections(pool, ctx, workflow) {
  const { requisition } = ctx;
  const nameMap = await resolveEmployeeDisplayNames(pool, [requisition.created_by]);

  const sections = {
    key_metrics: [
      metric("submission", "Submission", requisition.requestor_submitted_on ? "Recorded" : "Not recorded", "Submission signal"),
      metric("req_status", "Status", requisition.req_status)
    ],
    details: [
      detail("Submitted on", formatDisplayDate(requisition.requestor_submitted_on)),
      detail("Requestor", nameMap.get(requisition.created_by) || requisition.created_by, "partial"),
      detail("Current status", requisition.req_status),
      detail("Workflow instance", requisition.workflow_instance_id)
    ],
    related_records: {},
    history: [],
    navigation: []
  };

  if (workflow) {
    sections.workflow = workflow;
    sections.history = workflow.timeline || [];
  }

  return sections;
}

async function buildRequisitionApprovedSections(pool, ctx, workflow) {
  const routeName = await resolveApprovalRouteName(pool, requisitionRouteId(ctx.requisition));

  const sections = {
    key_metrics: [
      metric("approval", "Approval", ctx.requisition.req_status, "Requisition approval state")
    ],
    details: [
      detail("Approved status", ctx.requisition.req_status),
      detail("Last modified", formatDisplayDate(ctx.requisition.modified_on)),
      detail("Approval route", routeName || ctx.requisition.approval_route_id, routeName ? "real" : "partial")
    ],
    related_records: {},
    history: [],
    navigation: []
  };

  if (workflow) {
    sections.workflow = workflow;
    sections.history = workflow.timeline || [];
  }

  return sections;
}

function requisitionRouteId(requisition) {
  return requisition.approval_route_id || null;
}

async function buildRecruiterAssignedSections(pool, ctx) {
  const active = ctx.activeAssignments;
  const nameMap = await resolveEmployeeDisplayNames(
    pool,
    active.flatMap((row) => [row.recruiter_code, row.assigned_by]).filter(Boolean)
  );

  const { items, truncated } = truncateList(
    active.map((row) => ({
      assignment_id: row.assignment_id,
      recruiter_code: row.recruiter_code,
      recruiter_name: nameMap.get(row.recruiter_code) || row.recruiter_code,
      assigned_on: formatDisplayDate(row.assigned_on),
      assigned_by: nameMap.get(row.assigned_by) || row.assigned_by || "Not available",
      availability: "real"
    }))
  );

  return {
    key_metrics: [
      metric("recruiter_count", "Active recruiters", String(active.length), "Assigned to requisition")
    ],
    details: [
      detail("Assignment rule", "Active rows in rm_recruiter_assignments", "real")
    ],
    related_records: {
      recruiters: items,
      recruiters_truncated: truncated
    },
    history: [],
    navigation: []
  };
}

async function buildCandidatePipelineSections(pool, ctx) {
  const { activeMappings, summary } = ctx;
  const candidateNames = await resolveCandidateNames(
    pool,
    activeMappings.map((row) => row.candidate_id)
  );

  const { items, truncated } = truncateList(
    activeMappings.map((row) => ({
      mapping_id: row.mapping_id,
      candidate_id: row.candidate_id,
      candidate_code: row.candidate_code,
      candidate_name: candidateNames.get(String(row.candidate_id)) || row.candidate_code || row.candidate_id,
      stage_name: row.stage_name,
      applied_on: formatDisplayDate(row.applied_on),
      modified_on: formatDisplayDate(row.modified_on),
      availability: "real"
    }))
  );

  const stageBreakdown = summary.candidateStageSummary
    ? Object.entries(summary.candidateStageSummary)
      .map(([stage, count]) => `${stage} (${count})`)
      .join(", ")
    : "Not available";

  return {
    key_metrics: [
      metric("active_candidates", "Active candidates", String(summary.activeCandidateCount), "Current pipeline"),
      metric("stage_groups", "Stage groups", String(Object.keys(summary.candidateStageSummary || {}).length), "Distinct stages")
    ],
    details: [
      detail("Stage breakdown", stageBreakdown, "derived"),
      detail(
        "Primary candidate",
        summary.primaryCandidate
          ? `${summary.primaryCandidate.candidate_id} · ${summary.primaryCandidate.stage_name}`
          : "Not available",
        "derived"
      ),
      detail("Selection rule", ctx.metadata.primaryCandidateRule, "derived")
    ],
    related_records: {
      candidates: items,
      candidates_truncated: truncated
    },
    history: [],
    navigation: []
  };
}

async function buildInterviewProgressSections(pool, ctx) {
  const { interviews, summary } = ctx;

  const { items, truncated } = truncateList(
    interviews.map((row) => ({
      interview_id: row.interview_id,
      candidate_id: row.candidate_id,
      round_type: row.round_type,
      interview_status: row.interview_status,
      feedback_submitted: row.feedback_submitted === true,
      final_outcome: row.final_outcome || null,
      modified_on: formatDisplayDate(row.modified_on || row.created_on),
      availability: "real"
    }))
  );

  return {
    key_metrics: [
      metric("interviews", "Interviews", String(summary.interviewCount)),
      metric("scheduled", "Scheduled", String(summary.scheduledInterviewCount)),
      metric("completed", "Completed", String(summary.completedInterviewCount)),
      metric("feedback_pending", "Feedback pending", String(summary.feedbackPendingCount))
    ],
    details: [
      detail("Required rounds", "Not defined in schema", "unsupported"),
      detail("Feedback detail", "Summary counts only in Stage Inspector V1", "partial")
    ],
    related_records: {
      interviews: items,
      interviews_truncated: truncated
    },
    history: [],
    navigation: []
  };
}

async function buildOfferProgressSections(pool, ctx) {
  const { offers } = ctx;
  const offerIds = offers.map((row) => row.offer_id);
  const historyPack = await loadOfferHistory(pool, offerIds);
  const primary = offers[0] || null;

  const { items, truncated } = truncateList(
    offers.map((row) => ({
      offer_id: row.offer_id,
      candidate_id: row.candidate_id,
      offer_status: row.offer_status,
      offered_ctc: row.offered_ctc,
      approved_budget: row.approved_budget,
      variance_pct: row.variance_pct,
      workflow_instance_id: row.workflow_instance_id,
      modified_on: formatDisplayDate(row.modified_on),
      availability: "real"
    }))
  );

  let offerWorkflow = null;

  if (primary?.workflow_instance_id) {
    offerWorkflow = await loadWorkflowInspectorSections(
      pool,
      primary.workflow_instance_id,
      primary.offer_status
    );
  }

  const sections = {
    key_metrics: [
      metric("offers", "Offers", String(offers.length)),
      metric(
        "primary_status",
        "Primary offer status",
        primary?.offer_status || "Not available",
        primary?.offer_id || ""
      ),
      metric(
        "variance",
        "Primary variance",
        primary?.variance_pct != null ? `${primary.variance_pct}%` : "Not available",
        "Offer vs approved budget",
        primary?.variance_pct != null ? "real" : "unsupported"
      )
    ],
    details: [
      detail("Primary offer", primary?.offer_id || "Not available"),
      detail("Offered CTC", primary?.offered_ctc),
      detail("Approved budget", primary?.approved_budget),
      detail("Selection rule", ctx.metadata.primaryOfferRule, "derived")
    ],
    related_records: {
      offers: items,
      offers_truncated: truncated
    },
    history: historyPack.items,
    history_truncated: historyPack.truncated,
    navigation: []
  };

  if (offerWorkflow) {
    sections.workflow = offerWorkflow;
  }

  return sections;
}

async function buildHireOutcomeSections(pool, ctx) {
  const { offers, acceptances, activeMappings, metadata } = ctx;
  const acceptedOffer = offers.find(
    (offer) => normalizeStatus(offer.offer_status) === "Accepted"
  );
  const acceptanceRow = acceptances.find(
    (row) => normalizeStatus(row.response_status) === "Accepted"
  );
  const joinedMappings = activeMappings.filter((row) => /join/i.test(String(row.stage_name || "")));

  const sections = {
    key_metrics: [
      metric(
        "outcome",
        "Outcome",
        acceptanceRow || acceptedOffer ? "Offer accepted" : "Not accepted",
        acceptanceRow || acceptedOffer ? "Recorded acceptance" : "No acceptance recorded",
        acceptanceRow || acceptedOffer ? "real" : "derived"
      )
    ],
    details: [
      detail("Accepted on", formatDisplayDate(acceptanceRow?.accepted_on || acceptedOffer?.modified_on)),
      detail("Pre-onboarding status", acceptanceRow?.pre_onboarding_status || "Not available", acceptanceRow ? "real" : "unsupported"),
      detail("Formal hire completion", "Not supported in current schema", "unsupported")
    ],
    related_records: {
      acceptance: acceptanceRow
        ? {
            offer_id: acceptanceRow.offer_id,
            response_status: acceptanceRow.response_status,
            accepted_on: formatDisplayDate(acceptanceRow.accepted_on),
            declined_on: formatDisplayDate(acceptanceRow.declined_on),
            pre_onboarding_status: acceptanceRow.pre_onboarding_status,
            availability: "real"
          }
        : null,
      accepted_offer: acceptedOffer
        ? {
            offer_id: acceptedOffer.offer_id,
            offer_status: acceptedOffer.offer_status,
            candidate_id: acceptedOffer.candidate_id,
            availability: "real"
          }
        : null
    },
    history: [],
    navigation: []
  };

  if (joinedMappings.length) {
    sections.details.push(
      detail(
        "Joined signal",
        `${joinedMappings.length} active mapping(s) with joined-stage text`,
        "derived"
      )
    );
    sections.details.push(
      detail(
        "Joined signal note",
        "Derived from pipeline stage text; may not be formally recorded.",
        "derived"
      )
    );
  }

  if (metadata.joinedSignalFragile) {
    sections.details.push(
      detail("Data quality", "Joined detection is fragile", "derived")
    );
  }

  return sections;
}

async function buildSectionsForMilestone(pool, milestoneKey, ctx) {
  const budgetInstanceId = resolveBudgetWorkflowInstanceId(ctx.budgetRequest);
  const budgetWorkflow = await loadWorkflowInspectorSections(
    pool,
    budgetInstanceId,
    ctx.budgetRequest?.status
  );
  const reqWorkflow = await loadWorkflowInspectorSections(
    pool,
    ctx.requisition.workflow_instance_id,
    ctx.requisition.req_status
  );

  switch (milestoneKey) {
    case MILESTONE_KEYS.BUDGET_SUBMITTED:
      return buildBudgetSubmittedSections(ctx, budgetWorkflow);
    case MILESTONE_KEYS.BUDGET_APPROVED:
      return buildBudgetApprovedSections(ctx, budgetWorkflow);
    case MILESTONE_KEYS.REQUISITION_CREATED:
      return buildRequisitionCreatedSectionsWithPool(pool, ctx);
    case MILESTONE_KEYS.REQUISITION_SUBMITTED:
      return buildRequisitionSubmittedSections(pool, ctx, reqWorkflow);
    case MILESTONE_KEYS.REQUISITION_APPROVED:
      return buildRequisitionApprovedSections(pool, ctx, reqWorkflow);
    case MILESTONE_KEYS.RECRUITER_ASSIGNED:
      return buildRecruiterAssignedSections(pool, ctx);
    case MILESTONE_KEYS.CANDIDATE_PIPELINE:
      return buildCandidatePipelineSections(pool, ctx);
    case MILESTONE_KEYS.INTERVIEW_PROGRESS:
      return buildInterviewProgressSections(pool, ctx);
    case MILESTONE_KEYS.OFFER_PROGRESS:
      return buildOfferProgressSections(pool, ctx);
    case MILESTONE_KEYS.HIRE_OUTCOME:
      return buildHireOutcomeSections(pool, ctx);
    default:
      throw httpError("Invalid milestone key.", 400);
  }
}

function pruneEmptySections(sections) {
  const result = {};

  if (sections.key_metrics?.length) {
    result.key_metrics = sections.key_metrics;
  }

  if (sections.details?.length) {
    result.details = sections.details;
  }

  if (sections.workflow) {
    result.workflow = sections.workflow;
  }

  const related = sections.related_records || {};
  const relatedKeys = Object.keys(related).filter(
    (key) => !key.endsWith("_truncated") && related[key] != null
      && !(Array.isArray(related[key]) && related[key].length === 0)
  );

  if (relatedKeys.length) {
    result.related_records = related;

    for (const key of Object.keys(related)) {
      if (key.endsWith("_truncated") && related[key]) {
        result.related_records[key] = true;
      }
    }
  }

  if (sections.history?.length) {
    result.history = sections.history;
  }

  if (sections.history_truncated) {
    result.history_truncated = true;
  }

  if (sections.navigation?.length) {
    result.navigation = sections.navigation;
  }

  return result;
}

async function buildStageInspectorSnapshot(pool, requisitionCode, milestoneKey) {
  const code = String(requisitionCode || "").trim();
  const key = String(milestoneKey || "").trim();

  if (!code) {
    throw httpError("Requisition code is required.", 400);
  }

  if (!VALID_MILESTONE_KEYS.has(key)) {
    throw httpError("Invalid milestone key.", 400);
  }

  const requisition = await recruitmentService.loadRequisitionByCode(pool, code);

  if (!requisition) {
    throw httpError("Requisition not found.", 404);
  }

  const ctx = await loadLifecycleContext(pool, requisition);
  const milestone = ctx.milestones.find((item) => item.key === key);

  if (!milestone) {
    throw httpError("Milestone not found.", 404);
  }

  const rawSections = await buildSectionsForMilestone(pool, key, ctx);
  const sections = pruneEmptySections(rawSections);

  return {
    requisition_code: code,
    milestone,
    sections,
    metadata: {
      unsupported_fields: UNSUPPORTED_FIELDS,
      joined_signal_fragile: ctx.metadata.joinedSignalFragile === true
    }
  };
}

module.exports = {
  VALID_MILESTONE_KEYS,
  MAX_LIST,
  UNSUPPORTED_FIELDS,
  buildStageInspectorSnapshot
};
