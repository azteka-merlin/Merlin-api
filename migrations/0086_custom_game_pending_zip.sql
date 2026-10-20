-- A ZIP can be indexed without replacing the package visible in the Launcher.
-- Only one unpublished replacement is kept per game.
ALTER TABLE custom_games ADD COLUMN pending_archive_key TEXT;
ALTER TABLE custom_games ADD COLUMN pending_source_etag TEXT;
ALTER TABLE custom_games ADD COLUMN pending_data_json TEXT;
ALTER TABLE custom_games ADD COLUMN pending_base_archive_key TEXT;
ALTER TABLE custom_games ADD COLUMN pending_created_at TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_games_pending_archive_key
  ON custom_games(pending_archive_key) WHERE pending_archive_key IS NOT NULL;

-- Publication must still refer to the exact staged source and active base.
-- The API clears pending_source_etag in the same D1 batch after this guarded update.
CREATE TRIGGER custom_game_pending_publish_guard
BEFORE UPDATE OF pending_archive_key ON custom_games
WHEN NEW.pending_archive_key IS NULL AND NEW.pending_source_etag IS NOT NULL
  AND (OLD.pending_archive_key IS NULL OR OLD.pending_archive_key != NEW.archive_key
    OR OLD.pending_source_etag != NEW.pending_source_etag
    OR OLD.archive_key != OLD.pending_base_archive_key)
BEGIN SELECT RAISE(ABORT, 'custom_game_pending_changed'); END;
