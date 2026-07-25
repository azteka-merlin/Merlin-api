ALTER TABLE licenses RENAME COLUMN phone TO contact;

ALTER TABLE licenses ADD COLUMN contact_type TEXT NOT NULL DEFAULT 'phone';
ALTER TABLE licenses ADD COLUMN source TEXT NOT NULL DEFAULT 'admin';
ALTER TABLE licenses ADD COLUMN recovery_pin_hash TEXT;
ALTER TABLE licenses ADD COLUMN recovery_notice_accepted_at TEXT;

CREATE INDEX IF NOT EXISTS idx_licenses_source ON licenses(source);
CREATE INDEX IF NOT EXISTS idx_licenses_contact ON licenses(contact_type, contact);

CREATE TABLE IF NOT EXISTS public_signup_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0,
  duration_amount INTEGER NOT NULL DEFAULT 30,
  duration_unit TEXT NOT NULL DEFAULT 'days',
  is_lifetime INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO public_signup_settings (
  id,
  enabled,
  duration_amount,
  duration_unit,
  is_lifetime,
  updated_at
) VALUES (
  1,
  0,
  30,
  'days',
  0,
  CURRENT_TIMESTAMP
);
