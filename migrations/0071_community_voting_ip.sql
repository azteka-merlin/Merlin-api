ALTER TABLE community_game_votes ADD COLUMN ip_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_community_game_votes_ip_day
ON community_game_votes(ip_hash, vote_day);
