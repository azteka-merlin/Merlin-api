CREATE TABLE IF NOT EXISTS game_image_metadata_cache (
  app_id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  image_url TEXT NOT NULL DEFAULT '',
  expires_at INTEGER NOT NULL
);
