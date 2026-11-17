-- Temporary collision index for one unfinished folder upload. Paths are
-- normalized by the Worker before insertion; data is never copied from a game.
CREATE TABLE custom_game_metadata_sessions (
  session_id TEXT NOT NULL,
  manifest_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','finalizing','publishing','finalized','cancelled')),
  batch_count INTEGER,
  processed_count INTEGER NOT NULL DEFAULT 0,
  objects_json TEXT NOT NULL DEFAULT '{}',
  total_size_bytes INTEGER NOT NULL DEFAULT 0,
  file_count INTEGER NOT NULL DEFAULT 0,
  active_bundle_client_id TEXT,
  active_bundle_next INTEGER NOT NULL DEFAULT 0,
  active_bundle_count INTEGER NOT NULL DEFAULT 0,
  active_bundle_members INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(session_id, manifest_id),
  UNIQUE(session_id)
);
CREATE TABLE custom_game_metadata_batches (
  session_id TEXT NOT NULL,
  manifest_id TEXT NOT NULL,
  batch_index INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  processed INTEGER NOT NULL DEFAULT 0 CHECK(processed IN (0,1)),
  part_key TEXT,
  PRIMARY KEY(session_id, manifest_id, batch_index),
  FOREIGN KEY(session_id, manifest_id) REFERENCES custom_game_metadata_sessions(session_id, manifest_id) ON DELETE CASCADE
);
CREATE TABLE custom_game_metadata_files (
  session_id TEXT NOT NULL,
  manifest_id TEXT NOT NULL,
  path TEXT NOT NULL,
  PRIMARY KEY(session_id, manifest_id, path),
  FOREIGN KEY(session_id, manifest_id) REFERENCES custom_game_metadata_sessions(session_id, manifest_id) ON DELETE CASCADE
);
-- A cancellation tombstone fences metadata batches that raced the R2 session
-- state update. Upload session IDs are unique and are never reused.
CREATE TABLE custom_game_metadata_cancelled_sessions (
  session_id TEXT PRIMARY KEY,
  cancelled_at INTEGER NOT NULL
);
CREATE TRIGGER custom_game_metadata_batch_open BEFORE INSERT ON custom_game_metadata_batches
WHEN NOT EXISTS (SELECT 1 FROM custom_game_metadata_sessions WHERE session_id=NEW.session_id AND manifest_id=NEW.manifest_id AND status='open')
 OR EXISTS (SELECT 1 FROM custom_game_metadata_cancelled_sessions WHERE session_id=NEW.session_id)
BEGIN SELECT RAISE(ABORT,'metadata_session_closed'); END;
CREATE TRIGGER custom_game_metadata_file_conflict BEFORE INSERT ON custom_game_metadata_files
WHEN EXISTS (SELECT 1 FROM custom_game_metadata_files WHERE session_id=NEW.session_id AND manifest_id=NEW.manifest_id
  AND path >= NEW.path || '/' AND path < NEW.path || '0')
 OR EXISTS (
  WITH RECURSIVE prefixes(prefix, remaining) AS (
    SELECT '', NEW.path
    UNION ALL
    SELECT prefix || substr(remaining,1,instr(remaining,'/')),
      substr(remaining,instr(remaining,'/')+1)
    FROM prefixes WHERE instr(remaining,'/') > 0
  )
  SELECT 1 FROM prefixes JOIN custom_game_metadata_files f
    ON f.session_id=NEW.session_id AND f.manifest_id=NEW.manifest_id
    AND f.path=substr(prefixes.prefix,1,length(prefixes.prefix)-1)
  WHERE prefixes.prefix != ''
 )
BEGIN SELECT RAISE(ABORT,'metadata_path_conflict'); END;
