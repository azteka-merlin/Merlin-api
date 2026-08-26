ALTER TABLE checkout_sessions ADD COLUMN plan_tier TEXT;

CREATE INDEX IF NOT EXISTS idx_checkout_sessions_plan_tier
ON checkout_sessions(plan_tier);
