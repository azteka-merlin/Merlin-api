CREATE TABLE IF NOT EXISTS billing_plan_prices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL DEFAULT 'stripe',
  payment_method TEXT NOT NULL,
  plan_tier TEXT NOT NULL,
  billing_period TEXT NOT NULL,
  provider_price_id TEXT,
  amount_cents INTEGER,
  currency TEXT NOT NULL DEFAULT 'brl',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_plan_prices_unique
ON billing_plan_prices(provider, payment_method, plan_tier, billing_period);

CREATE INDEX IF NOT EXISTS idx_billing_plan_prices_price_id
ON billing_plan_prices(provider, provider_price_id)
WHERE provider_price_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS subscription_plan_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  license_id INTEGER NOT NULL REFERENCES licenses(id),
  customer_id INTEGER,
  provider TEXT NOT NULL DEFAULT 'stripe',
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT NOT NULL,
  stripe_subscription_item_id TEXT,
  stripe_schedule_id TEXT,
  stripe_invoice_id TEXT,
  stripe_payment_intent_id TEXT,
  current_plan_tier TEXT,
  target_plan_tier TEXT NOT NULL,
  current_billing_period TEXT,
  target_billing_period TEXT NOT NULL,
  current_price_id TEXT,
  target_price_id TEXT NOT NULL,
  change_type TEXT NOT NULL,
  timing TEXT NOT NULL,
  status TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  effective_at TEXT,
  applied_at TEXT,
  canceled_at TEXT,
  failure_reason TEXT,
  raw_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_subscription_plan_changes_license
ON subscription_plan_changes(license_id, status);

CREATE INDEX IF NOT EXISTS idx_subscription_plan_changes_subscription
ON subscription_plan_changes(stripe_subscription_id, status);

CREATE INDEX IF NOT EXISTS idx_subscription_plan_changes_schedule
ON subscription_plan_changes(stripe_schedule_id)
WHERE stripe_schedule_id IS NOT NULL;
