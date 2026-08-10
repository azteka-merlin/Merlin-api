ALTER TABLE checkout_sessions ADD COLUMN provider_payment_id TEXT;
ALTER TABLE checkout_sessions ADD COLUMN provider_external_reference TEXT;
ALTER TABLE checkout_sessions ADD COLUMN provider_qr_code TEXT;
ALTER TABLE checkout_sessions ADD COLUMN provider_qr_code_base64 TEXT;
ALTER TABLE checkout_sessions ADD COLUMN provider_ticket_url TEXT;
ALTER TABLE checkout_sessions ADD COLUMN provider_raw_status TEXT;
ALTER TABLE checkout_sessions ADD COLUMN provider_status_detail TEXT;
ALTER TABLE checkout_sessions ADD COLUMN provider_environment TEXT;
ALTER TABLE checkout_sessions ADD COLUMN processed_at TEXT;
ALTER TABLE payment_events ADD COLUMN raw_payload TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_checkout_sessions_provider_external_reference
ON checkout_sessions(provider, provider_external_reference)
WHERE provider_external_reference IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_checkout_sessions_provider_payment_id
ON checkout_sessions(provider, provider_payment_id)
WHERE provider_payment_id IS NOT NULL;
