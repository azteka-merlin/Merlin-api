CREATE TABLE IF NOT EXISTS catalog_sync_state (
  sync_key TEXT PRIMARY KEY,
  source_hash TEXT NOT NULL,
  synced_at TEXT NOT NULL
);
