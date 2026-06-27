CREATE TABLE correction_votes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id TEXT NOT NULL,
  license_id INTEGER NOT NULL,
  hwid TEXT,
  vote TEXT NOT NULL CHECK(vote IN ('up', 'down')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(app_id, license_id),
  FOREIGN KEY (license_id) REFERENCES licenses(id)
);

CREATE INDEX idx_correction_votes_app_id ON correction_votes(app_id);
CREATE INDEX idx_correction_votes_license_id ON correction_votes(license_id);
CREATE INDEX idx_correction_votes_vote ON correction_votes(vote);
