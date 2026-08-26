ALTER TABLE billing_settings ADD COLUMN annual_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE billing_settings ADD COLUMN pix_annual_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE billing_settings ADD COLUMN annual_price_id TEXT;
ALTER TABLE billing_settings ADD COLUMN pix_annual_price_id TEXT;
