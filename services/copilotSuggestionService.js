/**
 * Copilot quick-action personalization from JWT employee context only.
 * Reuses work assignments, workspace flags, and existing capability auth.
 */

const workAssignmentService = require("./workAssignmentService");
const workspaceResolverService = require("./workspaceResolverService");
const hiringManagerIdentityService = require("./hiringManagerIdentityService");
const { assertCanAssignRecruiters } = require("./requisitionCapabilityAuth");
const legacyOperationalAdapter = require("./legacyOperationalAdapter");
const {
  filterInterviewsToday,
  filterInterviewsPendingFeedback,
  filterInterviewsUpcoming
} = require("./copilotInterviewFilters");

/** Regression baseline — original V1 quick-action ids and phrases (must not change). */
const LEGACY_COPILOT_ACTION_IDS = Object.freeze([
  "requisitions",
  "candidates",
  "interview",
  "todays-interviews",
  "assign-recruiter",
  "map-candidate",
  "conduct-interview"
]);

const ROLE_FOCUSED_ACTION_IDS = Object.freeze([
  "my-interviews-today",
  "my-pending-interview-feedback",
  "my-upcoming-interviews",
  "ta-lead-team-requisitions",
  "ta-lead-recruiter-workload",
  "ta-lead-recruitment-bottlenecks",
  "admin-employee-responsibility-clearance",
  "admin-manage-compensation-structures",
  "admin-operational-exceptions"
]);

const COPILOT_ACTION_IDS = Object.freeze([
  ...ROLE_FOCUSED_ACTION_IDS,
  ...LEGACY_COPILOT_ACTION_IDS
]);

const ACTION_INPUT_TEXT = Object.freeze({
  "my-interviews-today": "Open My Interviews Today",
  "my-pending-interview-feedback": "Open My Pending Interview Feedback",
  "my-upcoming-interviews": "Open My Upcoming Interviews",
  "ta-lead-team-requisitions": "Open My Team Requisitions",
  "ta-lead-recruiter-workload": "Open Recruiter Workload",
  "ta-lead-recruitment-bottlenecks": "Open Recruitment Bottlenecks",
  "admin-employee-responsibility-clearance": "Open Employee Responsibility Clearance",
  "admin-manage-compensation-structures": "Open Manage Compensation Structures",
  "admin-operational-exceptions": "Open Operational Exceptions",
  requisitions: "Show My Requisitions",
  candidates: "Show Java Candidates",
  interview: "Schedule Interview",
  "todays-interviews": "Show Today's Interviews",
  "assign-recruiter": "Assign Recruiter",
  "map-candidate": "Map Candidate",
  "conduct-interview": "Conduct Interview"
});

const TA_LEAD_ROLES = new Set(["TA Lead", "TA Leader"]);

function isAdminRole(roleName) {
  return String(roleName || "").trim().toLowerCase() === "admin";
}

function isTaLeadRole(roleName) {
  return TA_LEAD_ROLES.has(String(roleName || "").trim());
}

function filterConductActionableInterviews(rows) {
  return (rows || []).filter((row) => {
    if (row?.feedback_submitted) {
      return false;
    }

    const status = String(row?.interview_status || "").trim();

    if (status === "Cancelled" || status === "Completed") {
      return false;
    }

    return true;
  });
}

async function countActiveRecruiterAssignments(pool, employeeCode) {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS count
     FROM rm_recruiter_assignments
     WHERE recruiter_code = $1
       AND is_active = true`,
    [employeeCode]
  );

  return Number(result.rows[0]?.count || 0);
}

async function resolveEmployeeWorkspace(pool, employeeCode, userRow) {
  let workspace = {};

  try {
    const resolved = await workspaceResolverService.resolveWorkspace(
      pool,
      employeeCode
    );
    workspace = resolved?.workspace || {};
  } catch (workspaceError) {
    console.error("[copilot] workspace resolution failed", {
      employee_code: employeeCode,
      message: workspaceError.message
    });
    workspace = {};
  }

  try {
    await hiringManagerIdentityService.resolveBoundHiringManager(pool, {
      user: {
        employee_code: employeeCode,
        email_id: userRow?.email_id
      }
    });
    workspace = { ...workspace, showHiringManagerWorkspace: true };
  } catch (_hmError) {
    // Optional HM binding
  }

  if (isTaLeadRole(userRow?.role_name)) {
    workspace = { ...workspace, showTaLeadWorkspace: true };
  }

  return workspace;
}

async function canAssignRecruiters(pool, req) {
  try {
    await assertCanAssignRecruiters(pool, req);
    return true;
  } catch (_error) {
    return false;
  }
}

async function loadInterviewerPanelRows(pool, employeeCode) {
  const panelResult = await pool.query(
    `SELECT panel_id
     FROM interview_panel_mstr
     WHERE employee_code = $1
       AND is_active = true
     LIMIT 1`,
    [employeeCode]
  );

  if (!panelResult.rows.length) {
    return [];
  }

  const panelId = panelResult.rows[0].panel_id;

  return legacyOperationalAdapter.listMyInterviewsForLegacyApi(pool, panelId);
}

async function countConductActionableInterviews(pool, employeeCode) {
  const rows = await loadInterviewerPanelRows(pool, employeeCode);
  return filterConductActionableInterviews(rows).length;
}

function dedupeIds(ids) {
  return [...new Set(ids)].filter((id) => COPILOT_ACTION_IDS.includes(id));
}

/**
 * Build deduplicated quick-action ids for the authenticated employee.
 * @param {object} pool
 * @param {object} req - Express request with verifyToken-populated req.user
 */
async function buildPersonalizedSuggestions(pool, req) {
  const employeeCode = String(req.user?.employee_code || "").trim();

  if (!employeeCode) {
    const error = new Error("Employee context is required.");
    error.status = 401;
    throw error;
  }

  const userResult = await pool.query(
    `SELECT employee_code, email_id, role_name, full_name, is_active
     FROM user_mstr
     WHERE employee_code = $1
     LIMIT 1`,
    [employeeCode]
  );

  const userRow = userResult.rows[0];

  if (!userRow || userRow.is_active !== true) {
    const error = new Error("Account is inactive.");
    error.status = 403;
    throw error;
  }

  const workspace = await resolveEmployeeWorkspace(pool, employeeCode, {
    ...userRow,
    email_id: userRow.email_id || req.user?.email_id
  });

  const recruiterAssignmentCount = await countActiveRecruiterAssignments(
    pool,
    employeeCode
  );

  const isAdmin = isAdminRole(userRow.role_name);
  const isRecruitment =
    workspace.showRecruitmentWorkspace === true ||
    recruiterAssignmentCount > 0 ||
    isAdmin;

  const canAssign = await canAssignRecruiters(pool, req);
  const canTaLeadOperate =
    workspace.showTaLeadWorkspace === true || (await canAssignRecruiters(pool, req));

  const interviewerRows = await loadInterviewerPanelRows(pool, employeeCode);
  const hasInterviewerPanel = interviewerRows.length > 0;
  const isInterviewerScope =
    workspace.showInterviewWorkspace === true || hasInterviewerPanel;

  const todayCount = filterInterviewsToday(interviewerRows).length;
  const pendingFeedbackCount = filterInterviewsPendingFeedback(interviewerRows).length;
  const upcomingCount = filterInterviewsUpcoming(interviewerRows).length;
  const conductCount = filterConductActionableInterviews(interviewerRows).length;

  const ids = [];

  if (isInterviewerScope && todayCount > 0) {
    ids.push("my-interviews-today");
  }

  if (isInterviewerScope && pendingFeedbackCount > 0) {
    ids.push("my-pending-interview-feedback");
  }

  if (isInterviewerScope && upcomingCount > 0) {
    ids.push("my-upcoming-interviews");
  }

  if (canTaLeadOperate) {
    ids.push("ta-lead-team-requisitions", "ta-lead-recruiter-workload");
    ids.push("ta-lead-recruitment-bottlenecks");
  }

  if (isAdmin) {
    ids.push(
      "admin-employee-responsibility-clearance",
      "admin-manage-compensation-structures",
      "admin-operational-exceptions"
    );
  }

  if (isRecruitment) {
    ids.push("requisitions");
  }

  if (
    isRecruitment ||
    workspace.showHiringManagerWorkspace === true ||
    isAdmin
  ) {
    ids.push("candidates");
  }

  if (isRecruitment) {
    ids.push("interview", "todays-interviews");
  }

  if (canAssign) {
    ids.push("assign-recruiter");
  }

  if (recruiterAssignmentCount > 0) {
    ids.push("map-candidate");
  }

  if (conductCount > 0) {
    ids.push("conduct-interview");
  }

  const uniqueIds = dedupeIds(ids);

  const suggestions = uniqueIds.map((id) => ({
    id,
    inputText: ACTION_INPUT_TEXT[id]
  }));

  return {
    employee_code: employeeCode,
    suggestions,
    meta: {
      generated_at: new Date().toISOString(),
      recruiter_assignment_count: recruiterAssignmentCount,
      conduct_interview_count: conductCount,
      interviewer_today_count: todayCount,
      interviewer_pending_feedback_count: pendingFeedbackCount,
      interviewer_upcoming_count: upcomingCount
    }
  };
}

module.exports = {
  LEGACY_COPILOT_ACTION_IDS,
  ROLE_FOCUSED_ACTION_IDS,
  COPILOT_ACTION_IDS,
  ACTION_INPUT_TEXT,
  buildPersonalizedSuggestions,
  filterConductActionableInterviews
};
