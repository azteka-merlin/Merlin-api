CREATE TABLE premium_games (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  cover_url TEXT,
  archive_key TEXT NOT NULL,
  activation_limit INTEGER NOT NULL DEFAULT 5,
  enabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(activation_limit > 0),
  CHECK(enabled IN (0, 1))
);

CREATE TABLE premium_activations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  license_id INTEGER NOT NULL,
  app_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('reserved', 'active', 'expired', 'failed')),
  reserved_at TEXT,
  activated_at TEXT,
  cooldown_until TEXT,
  failure_stage TEXT,
  failure_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (license_id) REFERENCES licenses(id),
  FOREIGN KEY (app_id) REFERENCES premium_games(app_id)
);

CREATE INDEX idx_premium_games_app_id ON premium_games(app_id);
CREATE INDEX idx_premium_games_enabled ON premium_games(enabled);

CREATE INDEX idx_premium_activations_app_id ON premium_activations(app_id);
CREATE INDEX idx_premium_activations_license_id ON premium_activations(license_id);
CREATE INDEX idx_premium_activations_status ON premium_activations(status);
CREATE INDEX idx_premium_activations_cooldown_until ON premium_activations(cooldown_until);
CREATE INDEX idx_premium_activations_app_status_cooldown ON premium_activations(app_id, status, cooldown_until);
CREATE INDEX idx_premium_activations_license_app_status ON premium_activations(license_id, app_id, status);
