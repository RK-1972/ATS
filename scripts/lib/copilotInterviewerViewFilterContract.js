/**
 * Reference implementation for Interviewer Home view filters (Copilot navigation).
 * Keep aligned with ats-frontend/src/components/copilot/interviewerCopilotFilters.js
 * Used by backend parity tests only — not imported by production services.
 */

const {
  getBusinessCalendarDateKey,
  getInterviewBusinessCalendarDateKey
} = require("../../utils/optalynxBusinessTimezone");

function isActionableInterviewRow(row) {
  if (row?.feedback_submitted) {
    return false;
  }

  const status = String(row?.interview_status || "").trim();

  if (status === "Cancelled" || status === "Completed") {
    return false;
  }

  return true;
}

function applyInterviewerViewFilter(rows, view, referenceDate = new Date()) {
  const list = Array.isArray(rows) ? rows : [];
  const today = getBusinessCalendarDateKey(referenceDate);

  if (view === "today") {
    return list.filter(
      (row) =>
        isActionableInterviewRow(row) &&
        getInterviewBusinessCalendarDateKey(row) === today
    );
  }

  if (view === "pending_feedback") {
    return list.filter((row) => {
      if (row?.feedback_submitted) {
        return false;
      }

      const status = String(row?.interview_status || "").trim();

      return status !== "Cancelled" && status !== "Completed";
    });
  }

  if (view === "upcoming") {
    return list.filter((row) => {
      if (!isActionableInterviewRow(row)) {
        return false;
      }

      const dateKey = getInterviewBusinessCalendarDateKey(row);

      return dateKey && dateKey >= today;
    });
  }

  return list;
}

module.exports = {
  applyInterviewerViewFilter
};
