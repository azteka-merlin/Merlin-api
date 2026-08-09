ALTER TABLE checkout_sessions ADD COLUMN checkout_ip TEXT;
ALTER TABLE checkout_sessions ADD COLUMN checkout_user_agent TEXT;
ALTER TABLE checkout_sessions ADD COLUMN checkout_country TEXT;
ALTER TABLE checkout_sessions ADD COLUMN checkout_evidence_json TEXT;

CREATE INDEX IF NOT EXISTS idx_checkout_sessions_checkout_ip
ON checkout_sessions(checkout_ip);

CREATE INDEX IF NOT EXISTS idx_checkout_sessions_checkout_country
ON checkout_sessions(checkout_country);
