CREATE TABLE IF NOT EXISTS fix_import_control (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  scan_token TEXT,
  scan_until INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO fix_import_control(id) VALUES(1);
CREATE TABLE IF NOT EXISTS fix_import_jobs (
  app_id TEXT PRIMARY KEY,
  position INTEGER NOT NULL UNIQUE,
  name TEXT NOT NULL,
  source_url TEXT NOT NULL,
  filename TEXT NOT NULL,
  source_size TEXT,
  status TEXT NOT NULL CHECK(status IN ('missing','queued','processing','migrated','failed','skipped')),
  phase TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  processed_bytes INTEGER NOT NULL DEFAULT 0,
  total_bytes INTEGER NOT NULL DEFAULT 0,
  object_key TEXT,
  sha256 TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS fix_import_jobs_pending ON fix_import_jobs(status,position);
