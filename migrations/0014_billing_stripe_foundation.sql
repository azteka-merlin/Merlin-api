CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  email_normalized TEXT NOT NULL UNIQUE,
  email_verified_at TEXT,
  stripe_customer_id TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS billing_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  billing_enabled INTEGER NOT NULL DEFAULT 0,
  public_signup_enabled INTEGER NOT NULL DEFAULT 1,
  monthly_enabled INTEGER NOT NULL DEFAULT 1,
  lifetime_enabled INTEGER NOT NULL DEFAULT 1,
  monthly_price_id TEXT,
  lifetime_price_id TEXT,
  monthly_amount_cents INTEGER NOT NULL DEFAULT 0,
  lifetime_amount_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'brl',
  free_access_type TEXT NOT NULL DEFAULT 'free',
  free_duration_days INTEGER,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO billing_settings (
  id,
  billing_enabled,
  public_signup_enabled,
  monthly_enabled,
  lifetime_enabled,
  monthly_amount_cents,
  lifetime_amount_cents,
  currency,
  free_access_type,
  free_duration_days,
  updated_at
) VALUES (
  1,
  0,
  1,
  1,
  1,
  0,
  0,
  'brl',
  'free',
  NULL,
  CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS checkout_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL,
  provider TEXT NOT NULL,
  provider_session_id TEXT NOT NULL,
  provider_price_id TEXT NOT NULL,
  plan_type TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  license_id INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  FOREIGN KEY (customer_id) REFERENCES customers(id),
  FOREIGN KEY (license_id) REFERENCES licenses(id)
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL UNIQUE,
  license_id INTEGER NOT NULL UNIQUE,
  provider TEXT NOT NULL,
  provider_subscription_id TEXT NOT NULL,
  status TEXT NOT NULL,
  current_period_end TEXT,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (customer_id) REFERENCES customers(id),
  FOREIGN KEY (license_id) REFERENCES licenses(id)
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL,
  license_id INTEGER,
  provider TEXT NOT NULL,
  provider_payment_id TEXT,
  provider_checkout_session_id TEXT,
  provider_subscription_id TEXT,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL,
  payment_type TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (customer_id) REFERENCES customers(id),
  FOREIGN KEY (license_id) REFERENCES licenses(id)
);

CREATE TABLE IF NOT EXISTS payment_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  processed_at TEXT,
  raw_created_at TEXT,
  processing_status TEXT NOT NULL DEFAULT 'pending',
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE licenses ADD COLUMN customer_id INTEGER REFERENCES customers(id);
ALTER TABLE licenses ADD COLUMN access_type TEXT NOT NULL DEFAULT 'free';
ALTER TABLE licenses ADD COLUMN billing_status TEXT NOT NULL DEFAULT 'none';
ALTER TABLE licenses ADD COLUMN stripe_customer_id TEXT;
ALTER TABLE licenses ADD COLUMN stripe_subscription_id TEXT;
ALTER TABLE licenses ADD COLUMN stripe_checkout_session_id TEXT;
ALTER TABLE licenses ADD COLUMN billing_current_period_end TEXT;
ALTER TABLE licenses ADD COLUMN billing_cancel_at_period_end INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS idx_licenses_unique_email_contact
ON licenses(lower(contact))
WHERE contact_type = 'email';

CREATE INDEX IF NOT EXISTS idx_licenses_customer_id ON licenses(customer_id);
CREATE INDEX IF NOT EXISTS idx_licenses_access_type ON licenses(access_type);
CREATE INDEX IF NOT EXISTS idx_licenses_billing_status ON licenses(billing_status);
CREATE INDEX IF NOT EXISTS idx_licenses_stripe_customer_id ON licenses(stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_licenses_stripe_subscription_id ON licenses(stripe_subscription_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_checkout_sessions_provider_session
ON checkout_sessions(provider, provider_session_id);

CREATE INDEX IF NOT EXISTS idx_checkout_sessions_customer_id ON checkout_sessions(customer_id);
CREATE INDEX IF NOT EXISTS idx_checkout_sessions_status ON checkout_sessions(status);

CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_provider_subscription
ON subscriptions(provider, provider_subscription_id);

CREATE INDEX IF NOT EXISTS idx_subscriptions_customer_id ON subscriptions(customer_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_license_id ON subscriptions(license_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);

CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_provider_payment
ON payments(provider, provider_payment_id)
WHERE provider_payment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payments_customer_id ON payments(customer_id);
CREATE INDEX IF NOT EXISTS idx_payments_license_id ON payments(license_id);
CREATE INDEX IF NOT EXISTS idx_payments_provider_checkout_session
ON payments(provider, provider_checkout_session_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_events_provider_event
ON payment_events(provider, provider_event_id);

CREATE INDEX IF NOT EXISTS idx_payment_events_processing_status
ON payment_events(processing_status);
