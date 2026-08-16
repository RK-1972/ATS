const { REQUISITION_STATUS } = require("../constants/requisitionStatus");

const APPROVAL_TIME_WINDOW_DAYS = 90;
const TIME_TO_HIRE_WINDOW_DAYS = 365;
const DEFAULT_VARIANCE_THRESHOLD = 10;

const KPI_DEFINITIONS = {
  activeProcesses:
    "Approved requisitions with active recruiter assignment, active candidates, or non-terminal offers.",
  pendingApprovals:
    "Open approval workflow tasks on running workflow instances.",
  clarifications:
    "Deduplicated open clarification items across requisitions, budget requests, and paused workflows.",
  budgetExceptions:
    "Offers exceeding configured budget variance threshold and not declined or withdrawn.",
  avgApprovalTimeHours:
    "Average completed approval-task duration over the rolling approval window.",
  configuredApprovalSlaHours:
    "Average configured SLA hours from published workflow stage definitions.",
  avgTimeToHireDays:
    "Average days from requisition creation to recorded offer acceptance.",
  recruiterWorkload:
    "Average active candidates per active recruiter."
};

function roundNumber(value, decimals = 1) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return null;
  }

  const factor = 10 ** decimals;
  return Math.round(Number(value) * factor) / factor;
}

async function loadVarianceThreshold(pool) {
  const result = await pool.query(
    `SELECT COALESCE(max_budget_variance_pct, $1)::float AS threshold
     FROM pc_budget_governance
     ORDER BY modified_on DESC NULLS LAST
     LIMIT 1`,
    [DEFAULT_VARIANCE_THRESHOLD]
  );

  return result.rows[0]?.threshold ?? DEFAULT_VARIANCE_THRESHOLD;
}

async function countActiveProcesses(pool) {
  const result = await pool.query(
    `SELECT COUNT(DISTINCT r.requisition_code)::int AS total
     FROM rm_requisitions r
     WHERE r.req_status = $1
       AND (
         EXISTS (
           SELECT 1
           FROM rm_recruiter_assignments a
           WHERE a.requisition_code = r.requisition_code
             AND a.is_active = TRUE
         )
         OR EXISTS (
           SELECT 1
           FROM rm_candidate_mappings m
           WHERE m.requisition_code = r.requisition_code
             AND m.is_active = TRUE
         )
         OR EXISTS (
           SELECT 1
           FROM om_offers o
           WHERE o.requisition_code = r.requisition_code
             AND COALESCE(o.offer_status, '') NOT IN ('Declined', 'Withdrawn')
         )
       )`,
    [REQUISITION_STATUS.APPROVED]
  );

  return result.rows[0]?.total ?? 0;
}

async function countPendingApprovals(pool) {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS total
     FROM wf_tasks t
     INNER JOIN wf_assignments a ON a.task_id = t.task_id
     INNER JOIN wf_instances i ON i.instance_id = t.instance_id
     WHERE LOWER(COALESCE(t.status, '')) = 'pending'
       AND a.active = TRUE
       AND (
         t.task_type IS NULL
         OR BTRIM(t.task_type) = ''
         OR LOWER(t.task_type) = 'approval'
       )
       AND LOWER(COALESCE(i.status, '')) = 'running'`
  );

  return result.rows[0]?.total ?? 0;
}

async function countClarifications(pool) {
  const result = await pool.query(
    `WITH clarification_items AS (
       SELECT DISTINCT dedupe_key
       FROM (
         SELECT COALESCE(
           NULLIF(BTRIM(r.workflow_instance_id), ''),
           'REQ:' || r.requisition_code
         ) AS dedupe_key
         FROM rm_requisitions r
         WHERE r.req_status = $1

         UNION ALL

         SELECT COALESCE(
           NULLIF(BTRIM(b.workflow_instance_id), ''),
           'BR:' || b.request_id
         ) AS dedupe_key
         FROM wp_budget_requests b
         WHERE b.status = $1

         UNION ALL

         SELECT i.instance_id AS dedupe_key
         FROM wf_instances i
         WHERE LOWER(COALESCE(i.status, '')) = 'paused'
           AND (
             LOWER(COALESCE(i.execution_context #>> '{clarification,status}', '')) = 'requested'
             OR EXISTS (
               SELECT 1
               FROM wf_tasks t
               WHERE t.instance_id = i.instance_id
                 AND LOWER(COALESCE(t.status, '')) = 'waiting for clarification'
             )
           )
       ) items
       WHERE dedupe_key IS NOT NULL
         AND BTRIM(dedupe_key) <> ''
     )
     SELECT COUNT(*)::int AS total
     FROM clarification_items`,
    [REQUISITION_STATUS.CLARIFICATION_REQUESTED]
  );

  return result.rows[0]?.total ?? 0;
}

async function countBudgetExceptions(pool, threshold) {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS total
     FROM om_offers o
     WHERE COALESCE(o.variance_pct, 0) > $1
       AND COALESCE(o.offer_status, '') NOT IN ('Declined', 'Withdrawn')`,
    [threshold]
  );

  return result.rows[0]?.total ?? 0;
}

async function computeAvgApprovalTime(pool) {
  const result = await pool.query(
    `SELECT
       AVG(
         EXTRACT(EPOCH FROM (
           t.completed_on - COALESCE(assign.assigned_on, t.created_on)
         )) / 3600.0
       ) AS avg_hours,
       COUNT(*)::int AS cohort_size
     FROM wf_tasks t
     LEFT JOIN LATERAL (
       SELECT MIN(a.assigned_on) AS assigned_on
       FROM wf_assignments a
       WHERE a.task_id = t.task_id
     ) assign ON TRUE
     WHERE LOWER(COALESCE(t.task_type, 'approval')) = 'approval'
       AND t.completed_on IS NOT NULL
       AND COALESCE(assign.assigned_on, t.created_on) IS NOT NULL
       AND t.completed_on >= NOW() - ($1::text || ' days')::interval`,
    [APPROVAL_TIME_WINDOW_DAYS]
  );

  const row = result.rows[0] || {};
  const cohortSize = row.cohort_size ?? 0;

  return {
    avgApprovalTimeHours: cohortSize > 0 ? roundNumber(row.avg_hours, 1) : null,
    approvalTimeCohortSize: cohortSize,
    approvalTimeWindowDays: APPROVAL_TIME_WINDOW_DAYS
  };
}

async function computeConfiguredApprovalSla(pool) {
  const result = await pool.query(
    `SELECT AVG(s.sla_hours)::float AS avg_sla
     FROM wf_stages s
     INNER JOIN wf_definitions d ON d.workflow_code = s.workflow_code
     WHERE s.sla_hours IS NOT NULL
       AND s.sla_hours > 0
       AND COALESCE(s.is_approval_stage, FALSE) = TRUE`
  );

  const avgSla = result.rows[0]?.avg_sla;

  if (avgSla === null || avgSla === undefined || Number.isNaN(Number(avgSla))) {
    return null;
  }

  return roundNumber(avgSla, 1);
}

async function computeAvgTimeToHire(pool) {
  const result = await pool.query(
    `SELECT
       AVG(
         EXTRACT(EPOCH FROM (acc.accepted_on - r.created_on)) / 86400.0
       ) AS avg_days,
       COUNT(*)::int AS cohort_size
     FROM om_offer_acceptance acc
     INNER JOIN om_offers o ON o.offer_id = acc.offer_id
     INNER JOIN rm_requisitions r ON r.requisition_code = o.requisition_code
     WHERE LOWER(COALESCE(acc.response_status, '')) = 'accepted'
       AND acc.accepted_on IS NOT NULL
       AND r.created_on IS NOT NULL
       AND acc.accepted_on >= NOW() - ($1::text || ' days')::interval`,
    [TIME_TO_HIRE_WINDOW_DAYS]
  );

  const row = result.rows[0] || {};
  const cohortSize = row.cohort_size ?? 0;

  return {
    avgTimeToHireDays: cohortSize > 0 ? roundNumber(row.avg_days, 1) : null,
    timeToHireCohortSize: cohortSize,
    timeToHireWindowDays: TIME_TO_HIRE_WINDOW_DAYS
  };
}

async function computeRecruiterWorkload(pool) {
  const result = await pool.query(
    `SELECT
       COUNT(DISTINCT a.recruiter_code)::int AS recruiter_count,
       COUNT(m.mapping_id)::int AS active_candidate_count
     FROM rm_recruiter_assignments a
     LEFT JOIN rm_candidate_mappings m
       ON m.requisition_code = a.requisition_code
      AND m.is_active = TRUE
     WHERE a.is_active = TRUE`
  );

  const row = result.rows[0] || {};
  const recruiterCount = row.recruiter_count ?? 0;
  const activeCandidateCount = row.active_candidate_count ?? 0;

  return {
    recruiterWorkload:
      recruiterCount > 0
        ? roundNumber(activeCandidateCount / recruiterCount, 1)
        : null,
    recruiterCount,
    activeCandidateCount
  };
}

async function buildExecutiveKpiSnapshot(pool) {
  const varianceThreshold = await loadVarianceThreshold(pool);

  const [
    activeProcesses,
    pendingApprovals,
    clarifications,
    budgetExceptions,
    approvalTime,
    configuredApprovalSlaHours,
    timeToHire,
    recruiterWorkload
  ] = await Promise.all([
    countActiveProcesses(pool),
    countPendingApprovals(pool),
    countClarifications(pool),
    countBudgetExceptions(pool, varianceThreshold),
    computeAvgApprovalTime(pool),
    computeConfiguredApprovalSla(pool),
    computeAvgTimeToHire(pool),
    computeRecruiterWorkload(pool)
  ]);

  return {
    kpis: {
      activeProcesses,
      pendingApprovals,
      clarifications,
      budgetExceptions,
      avgApprovalTimeHours: approvalTime.avgApprovalTimeHours,
      configuredApprovalSlaHours,
      avgTimeToHireDays: timeToHire.avgTimeToHireDays,
      recruiterWorkload: recruiterWorkload.recruiterWorkload
    },
    metadata: {
      computedAt: new Date().toISOString(),
      windowDays: APPROVAL_TIME_WINDOW_DAYS,
      approvalTimeCohortSize: approvalTime.approvalTimeCohortSize,
      approvalTimeWindowDays: approvalTime.approvalTimeWindowDays,
      timeToHireCohortSize: timeToHire.timeToHireCohortSize,
      timeToHireWindowDays: timeToHire.timeToHireWindowDays,
      recruiterCount: recruiterWorkload.recruiterCount,
      activeCandidateCount: recruiterWorkload.activeCandidateCount,
      budgetVarianceThresholdPct: varianceThreshold,
      definitions: KPI_DEFINITIONS,
      unsupportedNotes: [
        "Executive KPIs are enterprise-wide and do not change with requisition selection.",
        "Average time to hire uses offer acceptance records only.",
        "Configured SLA is separate from average approval time."
      ]
    }
  };
}

module.exports = {
  APPROVAL_TIME_WINDOW_DAYS,
  TIME_TO_HIRE_WINDOW_DAYS,
  KPI_DEFINITIONS,
  buildExecutiveKpiSnapshot
};
