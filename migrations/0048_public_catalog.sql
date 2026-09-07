CREATE TABLE IF NOT EXISTS catalog_games (
  app_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  cover_url TEXT,
  discovered_from TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_catalog_games_normalized_name ON catalog_games(normalized_name);

CREATE TABLE IF NOT EXISTS catalog_game_metadata (
  app_id TEXT PRIMARY KEY,
  category TEXT NOT NULL DEFAULT 'reviewing' CHECK(category IN ('premium', 'standard', 'reviewing')),
  denuvo INTEGER CHECK(denuvo IN (0, 1)),
  drm_notice TEXT,
  drm_source TEXT,
  checked_at TEXT,
  expires_at TEXT,
  retry_after TEXT
);

CREATE TABLE IF NOT EXISTS catalog_availability (
  app_id TEXT PRIMARY KEY,
  available_in_merlin INTEGER NOT NULL DEFAULT 0 CHECK(available_in_merlin IN (0, 1)),
  premium_game_enabled INTEGER NOT NULL DEFAULT 0 CHECK(premium_game_enabled IN (0, 1)),
  eligible_correction INTEGER NOT NULL DEFAULT 0 CHECK(eligible_correction IN (0, 1)),
  checked_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS catalog_enrichment_jobs (
  app_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'retry', 'completed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  locked_until TEXT,
  updated_at TEXT NOT NULL
);

INSERT INTO catalog_games (app_id, name, normalized_name, cover_url, discovered_from, first_seen_at, last_seen_at)
SELECT app_id, name, lower(name), cover_url, 'games_catalog', datetime('now'), datetime('now')
FROM games_catalog
WHERE 1 = 1
ON CONFLICT(app_id) DO NOTHING;

INSERT INTO catalog_games (app_id, name, normalized_name, cover_url, discovered_from, first_seen_at, last_seen_at)
SELECT app_id, name, lower(name), cover_url, 'premium_registry', datetime('now'), datetime('now')
FROM premium_games
WHERE 1 = 1
ON CONFLICT(app_id) DO UPDATE SET
  name = excluded.name,
  cover_url = COALESCE(excluded.cover_url, catalog_games.cover_url),
  discovered_from = 'premium_registry',
  last_seen_at = excluded.last_seen_at;

INSERT INTO catalog_game_metadata (app_id, category, denuvo, drm_source, checked_at)
SELECT app_id, 'premium', 1, 'premium_registry', datetime('now')
FROM premium_games
WHERE 1 = 1
ON CONFLICT(app_id) DO UPDATE SET
  category = 'premium', denuvo = 1, drm_source = 'premium_registry', checked_at = excluded.checked_at;

INSERT INTO catalog_availability (app_id, available_in_merlin, premium_game_enabled, eligible_correction, checked_at)
SELECT app_id, enabled, enabled, 0, datetime('now')
FROM premium_games
WHERE 1 = 1
ON CONFLICT(app_id) DO UPDATE SET
  available_in_merlin = excluded.available_in_merlin,
  premium_game_enabled = excluded.premium_game_enabled,
  checked_at = excluded.checked_at;

INSERT INTO catalog_game_metadata (app_id)
SELECT app_id FROM catalog_games
WHERE 1 = 1
ON CONFLICT(app_id) DO NOTHING;

INSERT INTO catalog_enrichment_jobs (app_id, status, next_attempt_at, updated_at)
SELECT app_id, 'pending', datetime('now'), datetime('now')
FROM catalog_games
WHERE app_id NOT IN (SELECT app_id FROM catalog_game_metadata WHERE category = 'premium')
  AND 1 = 1
ON CONFLICT(app_id) DO NOTHING;
