const BUDGET_CHANGE_STATUS = {
  PENDING: "Pending Approval",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  CANCELLED: "Cancelled"
};

const BUDGET_CHANGE_TYPE = {
  INCREASE: "Increase",
  REDUCTION: "Reduction"
};

function isPendingBudgetChangeStatus(status) {
  return String(status || "").trim() === BUDGET_CHANGE_STATUS.PENDING;
}

module.exports = {
  BUDGET_CHANGE_STATUS,
  BUDGET_CHANGE_TYPE,
  isPendingBudgetChangeStatus
};
