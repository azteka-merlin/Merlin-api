ALTER TABLE licenses ADD COLUMN revoked_origin TEXT;
ALTER TABLE licenses ADD COLUMN revoked_event_id TEXT;

ALTER TABLE checkout_sessions ADD COLUMN reactivation_license_id INTEGER REFERENCES licenses(id);

UPDATE licenses
SET revoked_origin = 'stripe_refund',
    revoked_event_id = substr(revoked_reason, 15)
WHERE status = 'revoked'
  AND revoked_origin IS NULL
  AND revoked_reason LIKE 'stripe_refund:%';

UPDATE licenses
SET revoked_origin = 'stripe_dispute',
    revoked_event_id = CASE
      WHEN instr(substr(revoked_reason, 16), ':') > 0
        THEN substr(substr(revoked_reason, 16), 1, instr(substr(revoked_reason, 16), ':') - 1)
      ELSE substr(revoked_reason, 16)
    END
WHERE status = 'revoked'
  AND revoked_origin IS NULL
  AND revoked_reason LIKE 'stripe_dispute:%';

UPDATE licenses
SET revoked_origin = 'admin'
WHERE status = 'revoked'
  AND revoked_origin IS NULL;

CREATE INDEX IF NOT EXISTS idx_licenses_revoked_origin ON licenses(revoked_origin);
CREATE INDEX IF NOT EXISTS idx_licenses_revoked_event_id ON licenses(revoked_event_id);
CREATE INDEX IF NOT EXISTS idx_checkout_sessions_reactivation_license_id
ON checkout_sessions(reactivation_license_id);
