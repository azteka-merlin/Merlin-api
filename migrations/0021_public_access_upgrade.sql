ALTER TABLE checkout_sessions ADD COLUMN operation_type TEXT;
ALTER TABLE checkout_sessions ADD COLUMN upgrade_license_id INTEGER REFERENCES licenses(id);
ALTER TABLE checkout_sessions ADD COLUMN upgrade_subscription_id TEXT;
ALTER TABLE checkout_sessions ADD COLUMN upgrade_processed_at TEXT;
ALTER TABLE checkout_sessions ADD COLUMN upgrade_cancel_error TEXT;

CREATE INDEX IF NOT EXISTS idx_checkout_sessions_operation_type
ON checkout_sessions(operation_type);

CREATE INDEX IF NOT EXISTS idx_checkout_sessions_upgrade_license
ON checkout_sessions(upgrade_license_id);

CREATE INDEX IF NOT EXISTS idx_checkout_sessions_upgrade_subscription
ON checkout_sessions(upgrade_subscription_id);

UPDATE licenses
SET access_type = CASE
      WHEN COALESCE(access_type, 'free') = 'paid_lifetime' THEN 'paid_lifetime'
      ELSE 'legacy_lifetime'
    END,
    billing_status = CASE
      WHEN COALESCE(access_type, 'free') = 'paid_lifetime' THEN COALESCE(NULLIF(billing_status, ''), 'active')
      ELSE 'none'
    END,
    expires_at = '9999-12-31T00:00:00.000Z',
    billing_current_period_end = NULL,
    billing_cancel_at_period_end = 0,
    updated_at = CURRENT_TIMESTAMP
WHERE status = 'active'
  AND COALESCE(access_type, 'free') <> 'monthly_subscription';
