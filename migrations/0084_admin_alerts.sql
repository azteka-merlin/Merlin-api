CREATE TABLE IF NOT EXISTS admin_alerts (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  severity TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  active_key TEXT UNIQUE,
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  first_occurred_at TEXT NOT NULL,
  last_occurred_at TEXT NOT NULL,
  acknowledged_at TEXT,
  acknowledged_by INTEGER,
  resolved_at TEXT,
  resolved_by INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (acknowledged_by) REFERENCES admin_users(id),
  FOREIGN KEY (resolved_by) REFERENCES admin_users(id)
);

CREATE INDEX IF NOT EXISTS idx_admin_alerts_status_last
ON admin_alerts(status, last_occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_alerts_type_last
ON admin_alerts(type, last_occurred_at DESC);

CREATE TABLE IF NOT EXISTS admin_alert_events (
  id TEXT PRIMARY KEY,
  alert_id TEXT NOT NULL,
  source TEXT NOT NULL,
  license_id INTEGER,
  app_id TEXT,
  game_name TEXT,
  message TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  FOREIGN KEY (alert_id) REFERENCES admin_alerts(id) ON DELETE CASCADE,
  FOREIGN KEY (license_id) REFERENCES licenses(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_alert_events_alert_time
ON admin_alert_events(alert_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS admin_push_subscriptions (
  id TEXT PRIMARY KEY,
  admin_user_id INTEGER NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (admin_user_id) REFERENCES admin_users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_admin_push_subscriptions_user
ON admin_push_subscriptions(admin_user_id);
