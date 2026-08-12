CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  internal_name TEXT NOT NULL,
  title TEXT NOT NULL,
  body_text TEXT NOT NULL,
  image_key TEXT,
  image_filename TEXT,
  image_content_type TEXT,
  image_size_bytes INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 0,
  starts_at TEXT,
  ends_at TEXT,
  frequency TEXT NOT NULL DEFAULT 'always' CHECK (frequency IN ('always', 'once_per_day', 'once')),
  allow_dismiss_forever INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_announcements_active_window
ON announcements(active, starts_at, ends_at);

CREATE TABLE IF NOT EXISTS announcement_user_state (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  announcement_id INTEGER NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  license_id INTEGER NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
  first_viewed_at TEXT,
  last_viewed_at TEXT,
  view_count INTEGER NOT NULL DEFAULT 0,
  dismissed_forever INTEGER NOT NULL DEFAULT 0,
  dismissed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (announcement_id, license_id)
);

CREATE INDEX IF NOT EXISTS idx_announcement_user_state_license
ON announcement_user_state(license_id);

CREATE INDEX IF NOT EXISTS idx_announcement_user_state_announcement
ON announcement_user_state(announcement_id);
