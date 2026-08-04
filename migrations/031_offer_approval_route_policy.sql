-- OPTALYNX Offer Approval Route Policy — integration seed for route resolver.
-- Required so approvalRouteResolverService.resolveApprovalRoute('OFFER', ...) can match
-- the existing "Offer Approval" route (same pattern as Budget route policies).

BEGIN;

INSERT INTO approval_route_policy (
  route_id,
  department,
  designation,
  grade,
  min_amount,
  max_amount,
  is_active,
  effective_from,
  created_by
)
SELECT
  r.route_id,
  NULL,
  NULL,
  NULL,
  0,
  NULL,
  TRUE,
  CURRENT_DATE,
  'Migration 031'
FROM approval_route_mstr r
WHERE LOWER(TRIM(r.applies_to)) = 'offer'
  AND LOWER(TRIM(r.status)) = 'active'
  AND NOT EXISTS (
    SELECT 1
    FROM approval_route_policy p
    WHERE p.route_id = r.route_id
      AND p.is_active = TRUE
  )
ORDER BY r.route_id
LIMIT 1;

COMMIT;
