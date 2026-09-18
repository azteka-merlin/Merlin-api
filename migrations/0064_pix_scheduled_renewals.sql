-- Pix renewals paid shortly before expiry are confirmed immediately, but their
-- entitlement begins only when the current paid period ends.
ALTER TABLE checkout_sessions ADD COLUMN scheduled_renewal_license_id INTEGER REFERENCES licenses(id);
ALTER TABLE checkout_sessions ADD COLUMN renewal_effective_at TEXT;
ALTER TABLE checkout_sessions ADD COLUMN renewal_applied_at TEXT;

CREATE INDEX IF NOT EXISTS idx_checkout_sessions_pix_scheduled_renewal
ON checkout_sessions(scheduled_renewal_license_id, payment_status, renewal_effective_at)
WHERE scheduled_renewal_license_id IS NOT NULL;
