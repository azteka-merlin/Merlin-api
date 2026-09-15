ALTER TABLE licenses ADD COLUMN hwid_reset_at TEXT;

CREATE INDEX IF NOT EXISTS idx_licenses_hwid_reset_at
ON licenses(hwid_reset_at);
