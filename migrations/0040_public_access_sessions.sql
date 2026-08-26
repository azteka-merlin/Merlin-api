CREATE TABLE IF NOT EXISTS public_access_sessions (
  id TEXT PRIMARY KEY,
  license_id INTEGER NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  user_agent_hash TEXT NOT NULL,
  remember_device INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  revoked_at TEXT,
  revoke_reason TEXT,
  FOREIGN KEY (license_id) REFERENCES licenses(id)
);

CREATE INDEX IF NOT EXISTS idx_public_access_sessions_license
ON public_access_sessions(license_id);

CREATE INDEX IF NOT EXISTS idx_public_access_sessions_expires
ON public_access_sessions(expires_at);
