/**
 * Responsibility inventory and preflight for employee lifecycle (V1).
 */

const RESPONSIBILITY_CATEGORIES = {
  WORK_ASSIGNMENT: "WORK_ASSIGNMENT",
  RECRUITER_ASSIGNMENT: "RECRUITER_ASSIGNMENT",
  CANDIDATE_OWNERSHIP: "CANDIDATE_OWNERSHIP",
  CANDIDATE_TRANSFER_REQUEST: "CANDIDATE_TRANSFER_REQUEST",
  WORKFLOW_TASK: "WORKFLOW_TASK",
  INTERVIEW_PANEL: "INTERVIEW_PANEL"
};

const REQUIRED_ACTIONS = {
  SUSPEND_ON_DEACTIVATE: "SUSPEND_ON_DEACTIVATE",
  UNASSIGN_OR_REPLACE_RECRUITER: "UNASSIGN_OR_REPLACE_RECRUITER",
  TRANSFER_CANDIDATE_OWNERSHIP: "TRANSFER_CANDIDATE_OWNERSHIP",
  RESOLVE_TRANSFER_REQUEST: "RESOLVE_TRANSFER_REQUEST",
  REASSIGN_WORKFLOW_TASK: "REASSIGN_WORKFLOW_TASK",
  REPLACE_INTERVIEW_PANEL: "REPLACE_INTERVIEW_PANEL"
};

async function listEligibleSuccessors(pool, category, excludeEmployeeCode) {
  const exclude = String(excludeEmployeeCode || "").trim();

  if (
    category === RESPONSIBILITY_CATEGORIES.RECRUITER_ASSIGNMENT ||
    category === RESPONSIBILITY_CATEGORIES.CANDIDATE_OWNERSHIP
  ) {
    const result = await pool.query(
      `SELECT employee_code, full_name, role_name
       FROM user_mstr
       WHERE is_active = TRUE
         AND role_name = 'Recruiter'
         AND ($1 = '' OR employee_code <> $1)
       ORDER BY full_name`,
      [exclude]
    );
    return result.rows;
  }

  if (category === RESPONSIBILITY_CATEGORIES.INTERVIEW_PANEL) {
    const result = await pool.query(
      `SELECT employee_code, full_name, role_name, email_id
       FROM user_mstr
       WHERE is_active = TRUE
         AND ($1 = '' OR employee_code <> $1)
         AND (
           role_name IN ('Interviewer', 'Recruiter', 'TA Lead', 'TA Leader', 'Admin')
           OR secondary_role = 'Interviewer'
         )
       ORDER BY full_name`,
      [exclude]
    );
    return result.rows;
  }

  const result = await pool.query(
    `SELECT employee_code, full_name, role_name
     FROM user_mstr
     WHERE is_active = TRUE
       AND ($1 = '' OR employee_code <> $1)
     ORDER BY full_name`,
    [exclude]
  );

  return result.rows;
}

async function fetchWorkAssignments(pool, employeeCode) {
  const result = await pool.query(
    `SELECT
       ewa.employee_work_assignment_id AS record_id,
       ewa.work_assignment_id,
       wa.assignment_code,
       wa.assignment_name,
       ewa.effective_from,
       ewa.effective_to,
       ewa.is_active
     FROM employee_work_assignment ewa
     INNER JOIN work_assignment_mstr wa
       ON wa.work_assignment_id = ewa.work_assignment_id
     WHERE ewa.employee_code = $1
       AND ewa.is_active = TRUE
     ORDER BY wa.display_order, wa.assignment_code`,
    [employeeCode]
  );

  const successors = await listEligibleSuccessors(
    pool,
    RESPONSIBILITY_CATEGORIES.WORK_ASSIGNMENT,
    employeeCode
  );

  return result.rows.map((row) => ({
    category: RESPONSIBILITY_CATEGORIES.WORK_ASSIGNMENT,
    record_id: String(row.record_id),
    label: row.assignment_name || row.assignment_code,
    current_owner_employee_code: employeeCode,
    required_action: REQUIRED_ACTIONS.SUSPEND_ON_DEACTIVATE,
    blocking: false,
    metadata: row,
    eligible_successors: successors
  }));
}

async function fetchRecruiterAssignments(pool, employeeCode) {
  const result = await pool.query(
    `SELECT
       assignment_id AS record_id,
       requisition_code,
       req_id,
       recruiter_code,
       assigned_on
     FROM rm_recruiter_assignments
     WHERE recruiter_code = $1
       AND is_active = TRUE
     ORDER BY assigned_on DESC`,
    [employeeCode]
  );

  const successors = await listEligibleSuccessors(
    pool,
    RESPONSIBILITY_CATEGORIES.RECRUITER_ASSIGNMENT,
    employeeCode
  );

  return result.rows.map((row) => ({
    category: RESPONSIBILITY_CATEGORIES.RECRUITER_ASSIGNMENT,
    record_id: String(row.record_id),
    label: `Recruiter on ${row.requisition_code || row.req_id}`,
    current_owner_employee_code: row.recruiter_code,
    required_action: REQUIRED_ACTIONS.UNASSIGN_OR_REPLACE_RECRUITER,
    blocking: true,
    metadata: row,
    eligible_successors: successors
  }));
}

async function fetchCandidateOwnership(pool, employeeCode) {
  const result = await pool.query(
    `SELECT
       candidate_id AS record_id,
       first_name,
       last_name,
       email_id,
       candidate_container,
       owner_employee_code
     FROM cand_mstr
     WHERE owner_employee_code = $1
     ORDER BY candidate_id`,
    [employeeCode]
  );

  const successors = await listEligibleSuccessors(
    pool,
    RESPONSIBILITY_CATEGORIES.CANDIDATE_OWNERSHIP,
    employeeCode
  );

  return result.rows.map((row) => ({
    category: RESPONSIBILITY_CATEGORIES.CANDIDATE_OWNERSHIP,
    record_id: String(row.record_id),
    label: `${row.first_name || ""} ${row.last_name || ""}`.trim() || row.email_id,
    current_owner_employee_code: row.owner_employee_code,
    required_action: REQUIRED_ACTIONS.TRANSFER_CANDIDATE_OWNERSHIP,
    blocking: true,
    metadata: row,
    eligible_successors: successors
  }));
}

async function fetchPendingTransferRequests(pool, employeeCode) {
  const result = await pool.query(
    `SELECT
       r.request_id AS record_id,
       r.candidate_id,
       r.from_recruiter_id,
       r.to_recruiter_id,
       r.status,
       c.first_name,
       c.last_name
     FROM rm_candidate_transfer_requests r
     LEFT JOIN cand_mstr c ON c.candidate_id = r.candidate_id
     WHERE r.status = 'Pending'
       AND (
         r.from_recruiter_id = $1
         OR r.to_recruiter_id = $1
       )
     ORDER BY r.request_id`,
    [employeeCode]
  );

  const successors = await listEligibleSuccessors(
    pool,
    RESPONSIBILITY_CATEGORIES.CANDIDATE_TRANSFER_REQUEST,
    employeeCode
  );

  return result.rows.map((row) => ({
    category: RESPONSIBILITY_CATEGORIES.CANDIDATE_TRANSFER_REQUEST,
    record_id: String(row.record_id),
    label: `Transfer request #${row.record_id} (${row.first_name || ""} ${row.last_name || ""})`.trim(),
    current_owner_employee_code: employeeCode,
    required_action: REQUIRED_ACTIONS.RESOLVE_TRANSFER_REQUEST,
    blocking: true,
    metadata: row,
    eligible_successors: successors
  }));
}

async function fetchPendingWorkflowTasks(pool, employeeCode) {
  const result = await pool.query(
    `SELECT
       t.task_id AS record_id,
       t.title,
       t.status,
       t.task_type,
       t.stage_key,
       t.assignee,
       t.assignee_role,
       i.workflow_code,
       i.instance_id
     FROM wf_tasks t
     INNER JOIN wf_instances i ON i.instance_id = t.instance_id
     WHERE LOWER(t.status) = 'pending'
       AND t.assignee = $1
     ORDER BY t.task_id`,
    [employeeCode]
  );

  const successors = await listEligibleSuccessors(
    pool,
    RESPONSIBILITY_CATEGORIES.WORKFLOW_TASK,
    employeeCode
  );

  return result.rows.map((row) => ({
    category: RESPONSIBILITY_CATEGORIES.WORKFLOW_TASK,
    record_id: String(row.record_id),
    label: row.title || `Task ${row.record_id}`,
    current_owner_employee_code: row.assignee,
    required_action: REQUIRED_ACTIONS.REASSIGN_WORKFLOW_TASK,
    blocking: true,
    metadata: row,
    eligible_successors: successors
  }));
}

async function fetchFutureInterviewPanels(pool, employeeCode) {
  const userResult = await pool.query(
    `SELECT email_id, full_name FROM user_mstr WHERE employee_code = $1`,
    [employeeCode]
  );
  const email = String(userResult.rows[0]?.email_id || "").trim().toLowerCase();

  if (!email) {
    return [];
  }

  const result = await pool.query(
    `SELECT DISTINCT
       i.interview_id AS record_id,
       i.interview_date,
       i.round_type,
       TRIM(CONCAT(COALESCE(cm.first_name, ''), ' ', COALESCE(cm.last_name, ''))) AS candidate_name,
       p.panel_id,
       p.interviewer_name,
       p.interviewer_email,
       p.assignment_status
     FROM im_interviews i
     INNER JOIN im_panel_assignments p
       ON p.interview_id = i.interview_id
      AND p.assignment_status <> 'Reassigned'
     LEFT JOIN cand_mstr cm ON cm.candidate_id = i.candidate_id
     WHERE LOWER(p.interviewer_email) = $1
       AND p.assignment_status IN ('Pending', 'Accepted')
       AND i.interview_date >= CURRENT_DATE
     ORDER BY i.interview_date, i.interview_id`,
    [email]
  );

  const successors = await listEligibleSuccessors(
    pool,
    RESPONSIBILITY_CATEGORIES.INTERVIEW_PANEL,
    employeeCode
  );

  return result.rows.map((row) => ({
    category: RESPONSIBILITY_CATEGORIES.INTERVIEW_PANEL,
    record_id: String(row.record_id),
    label: `${row.round_type || "Interview"} — ${row.candidate_name || row.record_id}`,
    current_owner_employee_code: employeeCode,
    required_action: REQUIRED_ACTIONS.REPLACE_INTERVIEW_PANEL,
    blocking: true,
    metadata: row,
    eligible_successors: successors
  }));
}

async function buildResponsibilityPreflight(pool, employeeCode) {
  const code = String(employeeCode || "").trim();

  if (!code) {
    const error = new Error("employeeCode is required.");
    error.status = 400;
    throw error;
  }

  const userResult = await pool.query(
    `SELECT employee_code, full_name, email_id, role_name, is_active
     FROM user_mstr
     WHERE employee_code = $1`,
    [code]
  );

  if (!userResult.rows.length) {
    const error = new Error(`User not found: ${code}`);
    error.status = 404;
    throw error;
  }

  const [
    workAssignments,
    recruiterAssignments,
    candidateOwnership,
    transferRequests,
    workflowTasks,
    interviewPanels
  ] = await Promise.all([
    fetchWorkAssignments(pool, code),
    fetchRecruiterAssignments(pool, code),
    fetchCandidateOwnership(pool, code),
    fetchPendingTransferRequests(pool, code),
    fetchPendingWorkflowTasks(pool, code),
    fetchFutureInterviewPanels(pool, code)
  ]);

  const items = [
    ...workAssignments,
    ...recruiterAssignments,
    ...candidateOwnership,
    ...transferRequests,
    ...workflowTasks,
    ...interviewPanels
  ];

  const blockingItems = items.filter((item) => item.blocking);
  const countsByCategory = items.reduce((acc, item) => {
    acc[item.category] = (acc[item.category] || 0) + 1;
    return acc;
  }, {});

  const exceptionResult = await pool.query(
    `SELECT exception_id, status, reason, created_on
     FROM employee_responsibility_clearance_exception
     WHERE employee_code = $1
       AND status = 'Open'
     ORDER BY created_on DESC
     LIMIT 1`,
    [code]
  ).catch(() => ({ rows: [] }));

  return {
    employee: userResult.rows[0],
    items,
    summary: {
      total_count: items.length,
      blocking_count: blockingItems.length,
      counts_by_category: countsByCategory
    },
    open_clearance_exception: exceptionResult.rows[0] || null
  };
}

async function listOrganizationClearanceQueue(pool) {
  const exceptions = await pool.query(
    `SELECT e.*, u.full_name, u.email_id, u.role_name
     FROM employee_responsibility_clearance_exception e
     INNER JOIN user_mstr u ON u.employee_code = e.employee_code
     WHERE e.status = 'Open'
     ORDER BY e.created_on DESC`
  ).catch(() => ({ rows: [] }));

  const inactiveUsers = await pool.query(
    `SELECT employee_code, full_name, email_id, role_name, updated_on
     FROM user_mstr
     WHERE is_active = FALSE
     ORDER BY updated_on DESC NULLS LAST
     LIMIT 200`
  );

  const queue = [];

  for (const row of exceptions.rows) {
    const preflight = await buildResponsibilityPreflight(pool, row.employee_code);
    queue.push({
      type: "emergency_exception",
      employee_code: row.employee_code,
      full_name: row.full_name,
      exception: row,
      preflight_summary: preflight.summary
    });
  }

  for (const user of inactiveUsers.rows) {
    const hasException = exceptions.rows.some(
      (ex) => ex.employee_code === user.employee_code
    );
    const preflight = await buildResponsibilityPreflight(pool, user.employee_code);

    if (preflight.summary.blocking_count > 0 || hasException) {
      queue.push({
        type: hasException ? "emergency_exception" : "inactive_with_responsibilities",
        employee_code: user.employee_code,
        full_name: user.full_name,
        exception: hasException
          ? exceptions.rows.find((ex) => ex.employee_code === user.employee_code)
          : null,
        preflight_summary: preflight.summary
      });
    }
  }

  const seen = new Set();
  const deduped = queue.filter((entry) => {
    if (seen.has(entry.employee_code)) {
      return false;
    }
    seen.add(entry.employee_code);
    return true;
  });

  return deduped;
}

module.exports = {
  RESPONSIBILITY_CATEGORIES,
  REQUIRED_ACTIONS,
  buildResponsibilityPreflight,
  listOrganizationClearanceQueue,
  listEligibleSuccessors,
  assertSuccessorActive: async function assertSuccessorActive(pool, successorCode) {
    const code = String(successorCode || "").trim();
    if (!code) {
      const error = new Error("Successor employee code is required.");
      error.status = 400;
      throw error;
    }
    const result = await pool.query(
      `SELECT employee_code, is_active FROM user_mstr WHERE employee_code = $1`,
      [code]
    );
    if (!result.rows.length || result.rows[0].is_active !== true) {
      const error = new Error("Successor must be an active employee.");
      error.status = 400;
      throw error;
    }
    return result.rows[0];
  }
};
