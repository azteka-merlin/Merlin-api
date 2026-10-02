CREATE TABLE IF NOT EXISTS community_game_votes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id TEXT NOT NULL,
  voter_hash TEXT NOT NULL,
  vote_day TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (voter_hash, vote_day, app_id)
);

CREATE INDEX IF NOT EXISTS idx_community_game_votes_app_id ON community_game_votes(app_id);
CREATE INDEX IF NOT EXISTS idx_community_game_votes_voter_day ON community_game_votes(voter_hash, vote_day);
