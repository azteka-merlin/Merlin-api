CREATE TABLE IF NOT EXISTS games_catalog (
  app_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  cover_url TEXT,
  cover_source TEXT,
  tags_json TEXT,
  nsfw INTEGER NOT NULL DEFAULT 0,
  drm INTEGER NOT NULL DEFAULT 0,
  added_at TEXT,
  updated_at TEXT,
  catalog_source TEXT NOT NULL DEFAULT 'ryuu',
  catalog_synced_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS games_catalog_fts
USING fts5(
  name,
  app_id UNINDEXED,
  content='games_catalog',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS games_catalog_ai
AFTER INSERT ON games_catalog
BEGIN
  INSERT INTO games_catalog_fts(rowid, name, app_id)
  VALUES (new.rowid, new.name, new.app_id);
END;

CREATE TRIGGER IF NOT EXISTS games_catalog_ad
AFTER DELETE ON games_catalog
BEGIN
  INSERT INTO games_catalog_fts(games_catalog_fts, rowid, name, app_id)
  VALUES ('delete', old.rowid, old.name, old.app_id);
END;

CREATE TRIGGER IF NOT EXISTS games_catalog_au
AFTER UPDATE ON games_catalog
BEGIN
  INSERT INTO games_catalog_fts(games_catalog_fts, rowid, name, app_id)
  VALUES ('delete', old.rowid, old.name, old.app_id);
  INSERT INTO games_catalog_fts(rowid, name, app_id)
  VALUES (new.rowid, new.name, new.app_id);
END;
