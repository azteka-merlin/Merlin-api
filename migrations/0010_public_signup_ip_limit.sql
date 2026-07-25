ALTER TABLE licenses ADD COLUMN public_signup_ip_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_licenses_public_signup_ip_hash
ON licenses(public_signup_ip_hash);
