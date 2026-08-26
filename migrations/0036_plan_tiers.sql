ALTER TABLE billing_settings ADD COLUMN plans_enabled INTEGER NOT NULL DEFAULT 0;

ALTER TABLE licenses ADD COLUMN plan_tier TEXT;
ALTER TABLE licenses ADD COLUMN billing_current_period_start TEXT;

UPDATE licenses
SET plan_tier = 'ouro'
WHERE COALESCE(license_type, 'normal') <> 'test'
  AND plan_tier IS NULL;

ALTER TABLE premium_games ADD COLUMN access_bronze_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE premium_games ADD COLUMN access_prata_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE premium_games ADD COLUMN access_ouro_enabled INTEGER NOT NULL DEFAULT 1;
