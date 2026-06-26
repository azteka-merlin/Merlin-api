CREATE TABLE user_activity_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  license_id INTEGER NOT NULL,
  license_key TEXT NOT NULL,
  user_name TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT NOT NULL,
  app_id TEXT,
  game_name TEXT,
  ip_address TEXT,
  hwid TEXT,
  reason TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (license_id) REFERENCES licenses(id)
);

CREATE INDEX idx_user_activity_license_id ON user_activity_logs(license_id);
CREATE INDEX idx_user_activity_action ON user_activity_logs(action);
CREATE INDEX idx_user_activity_status ON user_activity_logs(status);
CREATE INDEX idx_user_activity_app_id ON user_activity_logs(app_id);
CREATE INDEX idx_user_activity_created_at ON user_activity_logs(created_at);
