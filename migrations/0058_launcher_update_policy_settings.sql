CREATE TABLE IF NOT EXISTS launcher_update_policy_settings (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  automatic_updates_enabled INTEGER NOT NULL DEFAULT 0 CHECK(automatic_updates_enabled IN (0, 1)),
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO launcher_update_policy_settings (id, automatic_updates_enabled, updated_at)
VALUES (1, 0, datetime('now'));
