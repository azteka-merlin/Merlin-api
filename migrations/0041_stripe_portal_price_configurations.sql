CREATE TABLE IF NOT EXISTS stripe_portal_price_configurations (
  target_price_id TEXT PRIMARY KEY,
  target_product_id TEXT NOT NULL,
  stripe_configuration_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
