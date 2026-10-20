ALTER TABLE custom_games ADD COLUMN origin TEXT NOT NULL DEFAULT 'native' CHECK (origin IN ('native', 'port'));
ALTER TABLE custom_games ADD COLUMN repository_url TEXT NOT NULL DEFAULT '';
ALTER TABLE custom_games ADD COLUMN discord_url TEXT NOT NULL DEFAULT '';
ALTER TABLE custom_games ADD COLUMN protected_paths_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE custom_games ADD COLUMN version_label TEXT NOT NULL DEFAULT '';
ALTER TABLE custom_games ADD COLUMN tracked_release_tag TEXT NOT NULL DEFAULT '';
ALTER TABLE custom_games ADD COLUMN deleted_at TEXT;
ALTER TABLE custom_games ADD COLUMN storage_revision INTEGER NOT NULL DEFAULT 0;

CREATE TABLE custom_game_versions (
  game_id TEXT NOT NULL,
  archive_key TEXT NOT NULL,
  package_type TEXT NOT NULL CHECK (package_type IN ('zip', 'folder')),
  archive_size INTEGER NOT NULL,
  executable_path TEXT,
  origin TEXT NOT NULL DEFAULT 'native',
  protected_paths_json TEXT NOT NULL DEFAULT '[]',
  version_label TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  retired_at TEXT,
  delete_after TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired', 'deleting', 'deleted')),
  legacy_hold INTEGER NOT NULL DEFAULT 0 CHECK (legacy_hold IN (0, 1)),
  PRIMARY KEY (game_id, archive_key)
);
CREATE INDEX idx_custom_game_versions_cleanup ON custom_game_versions(status, delete_after);
CREATE INDEX idx_custom_game_versions_legacy ON custom_game_versions(game_id, legacy_hold);

-- Keep a stable baseline for clients that cannot pin requests to a version.
-- A client without the new protocol must never receive mixed ZIP ranges.
INSERT INTO custom_game_versions
  (game_id,archive_key,package_type,archive_size,executable_path,origin,protected_paths_json,version_label,legacy_hold)
SELECT id,archive_key,COALESCE(package_type,'zip'),archive_size,executable_path,origin,protected_paths_json,version_label,1
FROM custom_games WHERE archive_key NOT LIKE 'draft/%';

CREATE TABLE custom_game_download_sessions (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL,
  archive_key TEXT NOT NULL,
  license_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (game_id, archive_key) REFERENCES custom_game_versions(game_id, archive_key)
);
CREATE INDEX idx_custom_game_sessions_active
  ON custom_game_download_sessions(game_id, archive_key, completed_at, expires_at);

-- A concurrent save cannot resurrect a game removed after its form was read.
CREATE TRIGGER custom_game_tombstone_is_immutable
BEFORE UPDATE ON custom_games WHEN OLD.deleted_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'custom_game_deleted'); END;

-- A collector has exclusive ownership after claiming a package for deletion.
CREATE TRIGGER custom_game_cannot_publish_deleted_package
BEFORE UPDATE OF archive_key ON custom_games
WHEN EXISTS (SELECT 1 FROM custom_game_versions v WHERE v.game_id=NEW.id
  AND v.archive_key=NEW.archive_key AND v.status IN ('deleting','deleted'))
BEGIN SELECT RAISE(ABORT, 'custom_game_version_unavailable'); END;

CREATE TRIGGER custom_game_storage_revision_guard
BEFORE UPDATE OF storage_revision ON custom_games
WHEN NEW.storage_revision != OLD.storage_revision AND NEW.storage_revision != OLD.storage_revision + 1
BEGIN SELECT RAISE(ABORT, 'custom_game_storage_changed'); END;

CREATE TRIGGER custom_game_publish_during_cleanup
BEFORE UPDATE OF archive_key ON custom_games
WHEN EXISTS (SELECT 1 FROM custom_game_versions v WHERE v.game_id=NEW.id AND v.status='deleting')
BEGIN SELECT RAISE(ABORT, 'custom_game_storage_changed'); END;
