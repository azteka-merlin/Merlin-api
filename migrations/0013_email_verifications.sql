CREATE TABLE IF NOT EXISTS email_verifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  email_normalized TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  provider TEXT NOT NULL DEFAULT 'resend',
  verify_attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  cooldown_until TEXT NOT NULL,
  last_sent_at TEXT NOT NULL,
  verified_at TEXT,
  used_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_email_verifications_email_status
ON email_verifications(email_normalized, status);

CREATE INDEX IF NOT EXISTS idx_email_verifications_created_at
ON email_verifications(created_at);
