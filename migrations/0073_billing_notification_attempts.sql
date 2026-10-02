CREATE TABLE IF NOT EXISTS billing_notification_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  notification_id INTEGER NOT NULL REFERENCES billing_notifications(id),
  source TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  started_at TEXT NOT NULL,
  finished_at TEXT,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_billing_notification_attempts_notification
ON billing_notification_attempts(notification_id, id);

CREATE INDEX IF NOT EXISTS idx_billing_notification_attempts_started
ON billing_notification_attempts(started_at, status);
