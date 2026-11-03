-- Provider selection is durable: a retry must not switch back to Brevo after fallback.
-- Only hashes and delivery metadata are stored here, never message bodies/codes/keys.
CREATE TABLE email_delivery_routes (
  delivery_key TEXT PRIMARY KEY,
  payload_hash TEXT NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('pending', 'brevo', 'resend')),
  provider_started_at TEXT,
  brevo_reserved_at TEXT,
  recipient_count INTEGER NOT NULL DEFAULT 1,
  message_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_email_delivery_brevo_quota ON email_delivery_routes(brevo_reserved_at);
