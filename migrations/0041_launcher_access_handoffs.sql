CREATE TABLE IF NOT EXISTS launcher_access_handoffs (
  id TEXT PRIMARY KEY,
  license_id INTEGER NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  FOREIGN KEY (license_id) REFERENCES licenses(id)
);

CREATE INDEX IF NOT EXISTS idx_launcher_access_handoffs_expires
ON launcher_access_handoffs(expires_at);
