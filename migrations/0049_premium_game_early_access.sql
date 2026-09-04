CREATE TABLE IF NOT EXISTS premium_game_early_access (
  app_id TEXT NOT NULL,
  license_id INTEGER NOT NULL,
  granted_at TEXT NOT NULL,
  PRIMARY KEY (app_id, license_id),
  FOREIGN KEY (app_id) REFERENCES premium_games(app_id) ON DELETE CASCADE,
  FOREIGN KEY (license_id) REFERENCES licenses(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_premium_game_early_access_license_id
  ON premium_game_early_access(license_id);
