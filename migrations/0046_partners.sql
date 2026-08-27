CREATE TABLE IF NOT EXISTS public_partners (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  image_key TEXT,
  image_filename TEXT,
  image_content_type TEXT,
  image_size_bytes INTEGER NOT NULL DEFAULT 0,
  image_crop_x REAL,
  image_crop_y REAL,
  image_crop_width REAL,
  image_crop_height REAL,
  youtube_url TEXT,
  tiktok_url TEXT,
  twitch_url TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_public_partners_active_order
ON public_partners(active, sort_order, id);
