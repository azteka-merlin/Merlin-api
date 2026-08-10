ALTER TABLE billing_settings ADD COLUMN monthly_card_trial_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE billing_settings ADD COLUMN monthly_card_trial_days INTEGER NOT NULL DEFAULT 30;
