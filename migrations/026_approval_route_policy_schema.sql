-- OPTALYNX Enterprise Approval Route Policy Resolver — Phase 1
-- Maps Budget Request criteria to an existing Approval Route.

BEGIN;

CREATE TABLE IF NOT EXISTS approval_route_policy (
  policy_id BIGSERIAL PRIMARY KEY,
  route_id BIGINT NOT NULL
    REFERENCES approval_route_mstr (route_id) ON DELETE CASCADE,
  department VARCHAR(255) NOT NULL,
  designation VARCHAR(255) NOT NULL,
  grade VARCHAR(50) NOT NULL,
  minimum_budget NUMERIC(15, 2) NOT NULL DEFAULT 0,
  maximum_budget NUMERIC(15, 2),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
  effective_to DATE,
  created_by VARCHAR(100),
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by VARCHAR(100),
  updated_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_approval_route_policy_budget_range
    CHECK (
      minimum_budget >= 0
      AND (maximum_budget IS NULL OR maximum_budget >= minimum_budget)
    ),
  CONSTRAINT chk_approval_route_policy_effective_range
    CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE INDEX IF NOT EXISTS idx_approval_route_policy_lookup
  ON approval_route_policy (
    LOWER(department),
    LOWER(designation),
    LOWER(grade),
    is_active,
    effective_from,
    effective_to
  );

CREATE INDEX IF NOT EXISTS idx_approval_route_policy_route_id
  ON approval_route_policy (route_id);

COMMIT;
