-- Supports the BI queries that aggregate successful normal and Premium
-- activations by license and time window.
CREATE INDEX IF NOT EXISTS idx_user_activity_usage_analytics
  ON user_activity_logs(license_id, status, action, created_at);
