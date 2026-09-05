-- OPTALYNX Report Builder — V1.2 Semantic Reporting (dimensions, measures, aggregations)
-- Extends rb_field with governed semantic metadata. Run via scripts/runMigrations.js

BEGIN;

ALTER TABLE rb_field
  ADD COLUMN IF NOT EXISTS is_dimension BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE rb_field
  ADD COLUMN IF NOT EXISTS is_measure BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE rb_field
  ADD COLUMN IF NOT EXISTS supported_aggregations JSONB;

ALTER TABLE rb_field
  ADD COLUMN IF NOT EXISTS default_aggregation VARCHAR(30);

ALTER TABLE rb_field
  ADD COLUMN IF NOT EXISTS null_display_label VARCHAR(100);

ALTER TABLE rb_field
  ADD COLUMN IF NOT EXISTS supports_date_grain BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE rb_field
  ADD COLUMN IF NOT EXISTS dimension_order INT;

-- Dimensions: groupable business attributes
UPDATE rb_field f
SET
  is_dimension = f.is_groupable,
  supports_date_grain = (f.data_type = 'date'),
  dimension_order = CASE f.code
    WHEN 'stage_name' THEN 10
    WHEN 'applied_on' THEN 20
    WHEN 'created_on' THEN 20
    WHEN 'department' THEN 30
    WHEN 'req_status' THEN 30
    WHEN 'assigned_recruiter_name' THEN 40
    WHEN 'source_type' THEN 50
    WHEN 'location' THEN 60
    ELSE NULL
  END,
  null_display_label = CASE
    WHEN f.code = 'assigned_recruiter_name' THEN 'Unassigned'
    ELSE NULL
  END
FROM rb_dataset d
WHERE f.dataset_id = d.dataset_id
  AND d.code IN ('CANDIDATE_PIPELINE', 'REQUISITION_SUMMARY');

-- Measures: governed numeric calculations
UPDATE rb_field f
SET
  is_measure = TRUE,
  supported_aggregations = v.aggregations::jsonb,
  default_aggregation = v.default_agg
FROM rb_dataset d
CROSS JOIN (
  VALUES
    ('candidate_id', '["COUNT","COUNT_DISTINCT"]', 'COUNT_DISTINCT'),
    ('mapping_id', '["COUNT","COUNT_DISTINCT"]', 'COUNT'),
    ('candidate_code', '["COUNT","COUNT_DISTINCT"]', 'COUNT_DISTINCT'),
    ('requisition_code', '["COUNT","COUNT_DISTINCT"]', 'COUNT_DISTINCT'),
    ('total_experience', '["AVG","MIN","MAX","COUNT"]', 'AVG'),
    ('headcount', '["SUM","AVG","MIN","MAX","COUNT"]', 'SUM')
) AS v(code, aggregations, default_agg)
WHERE f.dataset_id = d.dataset_id
  AND f.code = v.code
  AND d.code IN ('CANDIDATE_PIPELINE', 'REQUISITION_SUMMARY');

-- Requisition-only measure fields
UPDATE rb_field f
SET
  is_measure = TRUE,
  supported_aggregations = '["SUM","AVG","MIN","MAX","COUNT"]'::jsonb,
  default_aggregation = 'SUM'
FROM rb_dataset d
WHERE f.dataset_id = d.dataset_id
  AND d.code = 'REQUISITION_SUMMARY'
  AND f.code = 'headcount';

COMMIT;
