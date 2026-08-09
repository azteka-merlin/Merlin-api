ALTER TABLE checkout_sessions ADD COLUMN idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_checkout_sessions_idempotency_key
ON checkout_sessions(idempotency_key)
WHERE idempotency_key IS NOT NULL;
