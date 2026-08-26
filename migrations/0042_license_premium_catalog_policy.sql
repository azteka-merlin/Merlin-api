-- The date is a single global catalog policy. A license only stores whether
-- that policy applies to it; it never stores its own cutoff timestamp.
ALTER TABLE licenses ADD COLUMN premium_catalog_restricted INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_licenses_premium_catalog_restricted
ON licenses(premium_catalog_restricted);

ALTER TABLE billing_settings ADD COLUMN premium_catalog_cutoff_at TEXT;

-- One row per Bronze monthly cycle. The counter is incremented atomically when
-- completePremiumActivation succeeds, so two simultaneous completions cannot take
-- the same remaining Bronze activation.
CREATE TABLE IF NOT EXISTS premium_activation_cycle_usage (
  license_id INTEGER NOT NULL,
  cycle_start TEXT NOT NULL,
  activation_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (license_id, cycle_start),
  FOREIGN KEY (license_id) REFERENCES licenses(id)
);
