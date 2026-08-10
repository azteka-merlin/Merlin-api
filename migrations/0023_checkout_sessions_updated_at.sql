ALTER TABLE checkout_sessions ADD COLUMN updated_at TEXT;

UPDATE checkout_sessions
SET updated_at = COALESCE(completed_at, created_at, CURRENT_TIMESTAMP)
WHERE updated_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_checkout_sessions_updated_at
ON checkout_sessions(updated_at);
