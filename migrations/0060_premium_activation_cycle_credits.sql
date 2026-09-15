-- Temporary, per-cycle premium credits granted by an administrator.
-- A credit belongs only to its exact billing cycle, so it never carries into
-- the next monthly cycle or changes the Bronze plan's standard limit.
CREATE TABLE IF NOT EXISTS premium_activation_cycle_credits (
  license_id INTEGER NOT NULL,
  cycle_start TEXT NOT NULL,
  credit_count INTEGER NOT NULL DEFAULT 0 CHECK (credit_count >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (license_id, cycle_start),
  FOREIGN KEY (license_id) REFERENCES licenses(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_premium_activation_cycle_credits_license
  ON premium_activation_cycle_credits(license_id, cycle_start);
