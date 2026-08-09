ALTER TABLE checkout_sessions ADD COLUMN provider_subscription_id TEXT;
ALTER TABLE checkout_sessions ADD COLUMN payment_status TEXT;

CREATE INDEX IF NOT EXISTS idx_checkout_sessions_provider_subscription
ON checkout_sessions(provider, provider_subscription_id);
