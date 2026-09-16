const HEADCOUNT_CHANGE_STATUS = {
  PENDING: "Pending Approval",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  CANCELLED: "Cancelled"
};

const HEADCOUNT_CHANGE_TYPE = {
  INCREASE: "Increase",
  REDUCTION: "Reduction"
};

function isPendingHeadcountChangeStatus(status) {
  return String(status || "").trim() === HEADCOUNT_CHANGE_STATUS.PENDING;
}

module.exports = {
  HEADCOUNT_CHANGE_STATUS,
  HEADCOUNT_CHANGE_TYPE,
  isPendingHeadcountChangeStatus
};
