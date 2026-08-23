ALTER TABLE licenses ADD COLUMN activation_usage_reset_at TEXT;

CREATE INDEX IF NOT EXISTS idx_licenses_activation_usage_reset_at ON licenses(activation_usage_reset_at);
