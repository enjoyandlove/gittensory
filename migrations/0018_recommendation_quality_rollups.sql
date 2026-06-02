ALTER TABLE product_usage_daily_rollups
  ADD COLUMN quality_by_role_outcome_json TEXT NOT NULL DEFAULT '[]';
