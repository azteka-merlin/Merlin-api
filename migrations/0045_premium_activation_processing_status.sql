-- The API claims a reservation before completing it. Preserve every existing
-- row and index while allowing that intermediate state in the D1 constraint.
CREATE TABLE premium_activations_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  license_id INTEGER NOT NULL,
  app_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('reserved', 'processing', 'active', 'expired', 'failed')),
  reserved_at TEXT,
  activated_at TEXT,
  cooldown_until TEXT,
  failure_stage TEXT,
  failure_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (license_id) REFERENCES licenses(id),
  FOREIGN KEY (app_id) REFERENCES premium_games(app_id)
);

INSERT INTO premium_activations_new (
  id,
  license_id,
  app_id,
  status,
  reserved_at,
  activated_at,
  cooldown_until,
  failure_stage,
  failure_reason,
  created_at,
  updated_at
)
SELECT
  id,
  license_id,
  app_id,
  status,
  reserved_at,
  activated_at,
  cooldown_until,
  failure_stage,
  failure_reason,
  created_at,
  updated_at
FROM premium_activations;

DROP TABLE premium_activations;
ALTER TABLE premium_activations_new RENAME TO premium_activations;

CREATE INDEX idx_premium_activations_app_id ON premium_activations(app_id);
CREATE INDEX idx_premium_activations_license_id ON premium_activations(license_id);
CREATE INDEX idx_premium_activations_status ON premium_activations(status);
CREATE INDEX idx_premium_activations_cooldown_until ON premium_activations(cooldown_until);
CREATE INDEX idx_premium_activations_app_status_cooldown ON premium_activations(app_id, status, cooldown_until);
CREATE INDEX idx_premium_activations_license_app_status ON premium_activations(license_id, app_id, status);
CREATE INDEX idx_premium_activations_license_status ON premium_activations(license_id, status);
