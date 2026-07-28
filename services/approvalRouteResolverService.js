const approvalRouteRepository = require("../repositories/approvalRouteRepository");

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function normalizeOptionalText(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const text = String(value).trim();
  return text ? text : null;
}

function normalizeOptionalAmount(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) {
    throw httpError(
      "criteria.amount must be a valid non-negative number when provided.",
      400
    );
  }

  return amount;
}

function normalizeCriteria(criteria = {}) {
  return {
    department: normalizeOptionalText(criteria.department),
    designation: normalizeOptionalText(criteria.designation),
    grade: normalizeOptionalText(criteria.grade),
    amount: normalizeOptionalAmount(criteria.amount)
  };
}

function formatCriteria(documentType, criteria) {
  return [
    `documentType "${documentType}"`,
    `Department ${criteria.department === null ? "(any)" : `"${criteria.department}"`}`,
    `Designation ${criteria.designation === null ? "(any)" : `"${criteria.designation}"`}`,
    `Grade ${criteria.grade === null ? "(any)" : `"${criteria.grade}"`}`,
    `Amount ${criteria.amount === null ? "(any)" : `"${criteria.amount}"`}`
  ].join(", ");
}

/**
 * Stateless Approval Route resolver.
 * Returns exactly one route_id for the given document type + criteria.
 * Does not create tasks, update documents, approve, or notify.
 *
 * @param {object} pool
 * @param {string} documentType
 * @param {object} criteria
 * @returns {Promise<number|string>} route_id
 */
async function resolveApprovalRoute(pool, documentType, criteria = {}) {
  const normalizedDocumentType = String(documentType || "").trim();

  if (!normalizedDocumentType) {
    throw httpError("documentType is required to resolve an Approval Route.", 400);
  }

  const normalizedCriteria = normalizeCriteria(criteria);

  const matches = await approvalRouteRepository.findMatchingActiveRoutes(
    pool,
    normalizedDocumentType,
    normalizedCriteria
  );

  if (matches.length === 0) {
    throw httpError(
      `No active Approval Route matches ${formatCriteria(normalizedDocumentType, normalizedCriteria)}.`,
      400
    );
  }

  if (matches.length > 1) {
    const routeIds = matches.map((route) => route.route_id).join(", ");
    throw httpError(
      `Multiple active Approval Routes match ${formatCriteria(normalizedDocumentType, normalizedCriteria)}. Matching route IDs: ${routeIds}. Configure non-overlapping route policies.`,
      400
    );
  }

  return matches[0].route_id;
}

module.exports = {
  resolveApprovalRoute
};
