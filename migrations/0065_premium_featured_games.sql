ALTER TABLE premium_games ADD COLUMN featured INTEGER NOT NULL DEFAULT 0;
ALTER TABLE premium_games ADD COLUMN featured_at TEXT;

CREATE INDEX IF NOT EXISTS idx_premium_games_featured
  ON premium_games(enabled DESC, featured DESC, featured_at DESC);
