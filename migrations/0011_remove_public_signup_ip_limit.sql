DROP INDEX IF EXISTS idx_licenses_public_signup_ip_hash;

ALTER TABLE licenses DROP COLUMN public_signup_ip_hash;
