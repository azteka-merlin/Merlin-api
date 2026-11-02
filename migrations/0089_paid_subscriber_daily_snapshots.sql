CREATE TABLE paid_subscriber_daily_snapshots (
  day TEXT NOT NULL,
  tier TEXT NOT NULL CHECK (tier IN ('bronze','prata','ouro')),
  subscribers INTEGER NOT NULL CHECK (subscribers >= 0),
  sampled_at TEXT NOT NULL,
  PRIMARY KEY (day, tier)
);
