-- Add actor_code to rm_pipeline_history for separate employee code storage.

ALTER TABLE rm_pipeline_history
  ADD COLUMN IF NOT EXISTS actor_code VARCHAR(50);
