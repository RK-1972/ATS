/**
 * Interviewer interview row filters for Copilot suggestions (panel-scoped rows only).
 * Business calendar dates use Asia/Kolkata (IST).
 */

const {
  getBusinessCalendarDateKey,
  getInterviewBusinessCalendarDateKey
} = require("../utils/optalynxBusinessTimezone");

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

function isPendingFeedbackRow(row) {
  if (row?.feedback_submitted) {
    return false;
  }

  const status = String(row?.interview_status || "").trim();

  if (status === "Cancelled" || status === "Completed") {
    return false;
  }

  return true;
}

function filterInterviewsToday(rows, referenceDate = new Date()) {
  const today = getBusinessCalendarDateKey(referenceDate);

  return (rows || []).filter((row) => {
    if (!isActionableInterviewRow(row)) {
      return false;
    }

    return getInterviewBusinessCalendarDateKey(row) === today;
  });
}

function filterInterviewsPendingFeedback(rows) {
  return (rows || []).filter((row) => isPendingFeedbackRow(row));
}

function filterInterviewsUpcoming(rows, referenceDate = new Date()) {
  const today = getBusinessCalendarDateKey(referenceDate);

  return (rows || []).filter((row) => {
    if (!isActionableInterviewRow(row)) {
      return false;
    }

    const dateKey = getInterviewBusinessCalendarDateKey(row);

    if (!dateKey) {
      return false;
    }

    return dateKey >= today;
  });
}

module.exports = {
  getInterviewBusinessCalendarDateKey,
  isActionableInterviewRow,
  filterInterviewsToday,
  filterInterviewsPendingFeedback,
  filterInterviewsUpcoming
};
