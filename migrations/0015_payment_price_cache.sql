CREATE TABLE IF NOT EXISTS payment_price_cache (
  provider TEXT NOT NULL,
  provider_price_id TEXT NOT NULL,
  product_name TEXT,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  recurring_interval TEXT,
  active INTEGER NOT NULL DEFAULT 0,
  raw_json TEXT NOT NULL,
  synced_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (provider, provider_price_id)
);

CREATE INDEX IF NOT EXISTS idx_payment_price_cache_synced_at
ON payment_price_cache(synced_at);
