CREATE TABLE IF NOT EXISTS custom_games (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  install_name TEXT NOT NULL,
  admin_note TEXT NOT NULL DEFAULT '',
  admin_notes_json TEXT NOT NULL DEFAULT '{}',
  image_key TEXT NOT NULL,
  image_position_x INTEGER NOT NULL DEFAULT 50,
  image_position_y INTEGER NOT NULL DEFAULT 50,
  image_zoom REAL NOT NULL DEFAULT 1,
  archive_key TEXT NOT NULL UNIQUE,
  archive_size INTEGER NOT NULL,
  executable_path TEXT,
  published INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_games_install_name ON custom_games(install_name);
CREATE INDEX IF NOT EXISTS idx_custom_games_published ON custom_games(published, name);
