CREATE TABLE IF NOT EXISTS community_vote_ip_claims (
  vote_day TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  voter_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (vote_day, ip_hash)
);

INSERT OR IGNORE INTO community_vote_ip_claims (vote_day, ip_hash, voter_hash)
SELECT vote_day, ip_hash, voter_hash
FROM community_game_votes
WHERE ip_hash IS NOT NULL
ORDER BY id;

CREATE TRIGGER IF NOT EXISTS trg_community_vote_ip_claim
AFTER INSERT ON community_game_votes
WHEN NEW.ip_hash IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO community_vote_ip_claims (vote_day, ip_hash, voter_hash)
  VALUES (NEW.vote_day, NEW.ip_hash, NEW.voter_hash);
  SELECT RAISE(ABORT, 'ip_claimed')
  WHERE (SELECT voter_hash FROM community_vote_ip_claims
         WHERE vote_day = NEW.vote_day AND ip_hash = NEW.ip_hash) <> NEW.voter_hash;
END;
