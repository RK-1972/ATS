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
  REJECTED: "Rejected"
};

module.exports = {
  REQUISITION_STATUS
};
