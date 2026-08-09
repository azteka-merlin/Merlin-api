ALTER TABLE checkout_sessions ADD COLUMN pending_license_key TEXT;
ALTER TABLE checkout_sessions ADD COLUMN pending_name TEXT;
ALTER TABLE checkout_sessions ADD COLUMN pending_recovery_pin_hash TEXT;
ALTER TABLE checkout_sessions ADD COLUMN pending_recovery_notice_accepted_at TEXT;
ALTER TABLE checkout_sessions ADD COLUMN provider_session_url TEXT;
ALTER TABLE checkout_sessions ADD COLUMN provider_session_expires_at TEXT;

CREATE INDEX IF NOT EXISTS idx_checkout_sessions_pending_license_key
ON checkout_sessions(pending_license_key);

CREATE UNIQUE INDEX IF NOT EXISTS idx_checkout_sessions_unique_pending_license_key
ON checkout_sessions(pending_license_key)
WHERE pending_license_key IS NOT NULL;
