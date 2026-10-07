/**
 * Resolves budget request fields that match a live active BUDGET approval-route policy.
 * Uses the same resolver as submitBudgetRequest — no product rule changes.
 */
const approvalRouteResolverService = require("../../services/approvalRouteResolverService");

function pickFirstText(value, arrayValue) {
  if (Array.isArray(arrayValue) && arrayValue.length) {
    const text = String(arrayValue[0] || "").trim();
    if (text) {
      return text;
    }
  }

  const legacy = String(value || "").trim();
  return legacy || null;
}

function pickAmount(minAmount, maxAmount) {
  const min = minAmount != null ? Number(minAmount) : null;
  const max = maxAmount != null ? Number(maxAmount) : null;

  if (min != null && max != null && Number.isFinite(min) && Number.isFinite(max)) {
    if (min === max) {
      return min;
    }
    return min + Math.max(1, Math.floor((max - min) / 2));
  }

  if (min != null && Number.isFinite(min)) {
    return min + 1000;
  }

  if (max != null && Number.isFinite(max)) {
    return Math.max(1, max - 1000);
  }

  return 500000;
}

async function loadActiveBudgetPolicies(pool) {
  const result = await pool.query(
    `SELECT
       p.policy_id,
       p.route_id,
       p.department,
       p.designation,
       p.designations,
       p.grade,
       p.grades,
       p.min_amount,
       p.max_amount
     FROM approval_route_policy p
     INNER JOIN approval_route_mstr r
       ON r.route_id = p.route_id
     WHERE p.is_active = TRUE
       AND LOWER(TRIM(r.status)) = 'active'
       AND (
         LOWER(TRIM(r.applies_to)) LIKE '%budget%'
         OR UPPER(SPLIT_PART(REGEXP_REPLACE(TRIM(r.applies_to), '[^A-Za-z0-9]+', '_', 'g'), '_', 1)) = 'BUDGET'
       )
       AND p.effective_from <= CURRENT_DATE
       AND (p.effective_to IS NULL OR p.effective_to >= CURRENT_DATE)
     ORDER BY p.policy_id ASC`
  );

  return result.rows;
}

/**
 * @returns {Promise<{ department, position, grade, proposed_budget, headcount, justification, priority, route_id }>}
 */
async function buildBudgetRequestCriteriaFromLiveConfig(pool, options = {}) {
  const policies = await loadActiveBudgetPolicies(pool);

  if (!policies.length) {
    throw new Error("No active BUDGET approval-route policies found in database.");
  }

  for (const policy of policies) {
    const department = pickFirstText(policy.department, null);
    const designation = pickFirstText(policy.designation, policy.designations);
    const grade = pickFirstText(policy.grade, policy.grades);
    const amount = pickAmount(policy.min_amount, policy.max_amount);

    const resolveCriteria = {
      department,
      designation,
      grade,
      amount
    };

    try {
      const routeId = await approvalRouteResolverService.resolveApprovalRoute(
        pool,
        "BUDGET",
        resolveCriteria
      );

      return {
        department,
        position: designation,
        grade,
        proposed_budget: amount,
        headcount: options.headcount ?? 1,
        justification:
          options.justification || "Budget verification scenario (live route policy).",
        priority: options.priority || "Medium",
        route_id: routeId,
        policy_id: policy.policy_id
      };
    } catch (_error) {
      continue;
    }
  }

  throw new Error(
    "No BUDGET policy row resolves to exactly one active route with current master data."
  );
}

module.exports = {
  buildBudgetRequestCriteriaFromLiveConfig,
  loadActiveBudgetPolicies
};
