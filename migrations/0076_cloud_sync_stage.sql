-- Gateway credentials authorize access, but never own or namespace saves.
CREATE TABLE IF NOT EXISTS cloud_sync_clients (
  access_key_id TEXT PRIMARY KEY,
  license_id INTEGER NOT NULL,
  hwid_digest TEXT NOT NULL,
  created_at TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  revoked_at TEXT,
  FOREIGN KEY (license_id) REFERENCES licenses(id)
);

CREATE INDEX IF NOT EXISTS idx_cloud_sync_clients_license
  ON cloud_sync_clients(license_id, lease_expires_at);

CREATE TABLE IF NOT EXISTS cloud_sync_daily_uploads (
  access_key_id TEXT NOT NULL,
  day TEXT NOT NULL,
  bytes_uploaded INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (access_key_id, day),
  FOREIGN KEY (access_key_id) REFERENCES cloud_sync_clients(access_key_id)
);
