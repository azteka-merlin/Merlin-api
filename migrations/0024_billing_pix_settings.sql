ALTER TABLE billing_settings ADD COLUMN pix_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE billing_settings ADD COLUMN pix_monthly_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE billing_settings ADD COLUMN pix_lifetime_enabled INTEGER NOT NULL DEFAULT 1;
