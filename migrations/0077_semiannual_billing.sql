-- Opt-in only: existing environments keep the six-month plan unavailable.
ALTER TABLE billing_settings ADD COLUMN semiannual_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE billing_settings ADD COLUMN pix_semiannual_enabled INTEGER NOT NULL DEFAULT 0;
