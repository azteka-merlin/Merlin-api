ALTER TABLE licenses ADD COLUMN license_type TEXT NOT NULL DEFAULT 'normal';
ALTER TABLE licenses ADD COLUMN normal_activation_limit INTEGER;
ALTER TABLE licenses ADD COLUMN premium_activation_limit INTEGER;

CREATE INDEX IF NOT EXISTS idx_licenses_license_type ON licenses(license_type);
CREATE INDEX IF NOT EXISTS idx_user_activity_license_action_app ON user_activity_logs(license_id, action, app_id);
CREATE INDEX IF NOT EXISTS idx_premium_activations_license_status ON premium_activations(license_id, status);
