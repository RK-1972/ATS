/**
 * Canonical requisition req_status values.
 * Aligned with enterprise workflow terminology (Budget module standard).
 */

const REQUISITION_STATUS = {
  OPEN: "Open",
  PENDING_LEVEL_1: "Pending Level-1 Approval",
  PENDING_LEVEL_2: "Pending Level-2 Approval",
  CLARIFICATION_REQUESTED: "Clarification Requested",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  CLOSED_FILLED: "Closed - Filled",
  CLOSED_CANCELLED: "Closed - Cancelled"
};

const CLOSED_REQUISITION_STATUSES = Object.freeze([
  REQUISITION_STATUS.CLOSED_FILLED,
  REQUISITION_STATUS.CLOSED_CANCELLED
]);

function isClosedRequisitionStatus(status) {
  const normalized = String(status || "").trim();
  return CLOSED_REQUISITION_STATUSES.includes(normalized);
}

module.exports = {
  REQUISITION_STATUS,
  CLOSED_REQUISITION_STATUSES,
  isClosedRequisitionStatus
};
