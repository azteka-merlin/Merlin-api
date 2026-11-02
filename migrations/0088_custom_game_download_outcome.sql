-- Historical closed sessions cannot distinguish completion from cancellation.
ALTER TABLE custom_game_download_sessions ADD COLUMN outcome TEXT CHECK (outcome IN ('completed','canceled'));
CREATE INDEX idx_custom_game_sessions_created ON custom_game_download_sessions(created_at, game_id);
