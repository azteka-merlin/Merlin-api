-- Separate game state from archive availability: an announced game may not
-- have a package yet, while an ordinary game can temporarily lose its package.
ALTER TABLE premium_games ADD COLUMN coming_soon INTEGER NOT NULL DEFAULT 0 CHECK (coming_soon IN (0, 1));
ALTER TABLE premium_games ADD COLUMN available_at TEXT;
ALTER TABLE premium_activations ADD COLUMN retry_of INTEGER REFERENCES premium_activations(id);
ALTER TABLE premium_activations ADD COLUMN operation_id TEXT;
CREATE UNIQUE INDEX idx_premium_activation_operation ON premium_activations(license_id,operation_id) WHERE operation_id IS NOT NULL;
CREATE INDEX idx_premium_activations_retry_of ON premium_activations(retry_of);

CREATE TABLE premium_retry_grants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  activation_id INTEGER NOT NULL REFERENCES premium_activations(id),
  license_id INTEGER NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
  app_id TEXT NOT NULL REFERENCES premium_games(app_id) ON DELETE CASCADE,
  granted_by INTEGER NOT NULL,
  granted_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('available', 'processing', 'used', 'expired', 'canceled', 'review')),
  retry_activation_id INTEGER REFERENCES premium_activations(id),
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_premium_retry_open_per_activation ON premium_retry_grants(activation_id)
  WHERE status IN ('available', 'processing', 'review');
CREATE INDEX idx_premium_retry_owner ON premium_retry_grants(license_id, app_id, status, expires_at);
CREATE INDEX idx_premium_retry_status ON premium_retry_grants(status,expires_at);

CREATE TABLE premium_wishlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  license_id INTEGER NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
  app_id TEXT NOT NULL REFERENCES premium_games(app_id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  phone TEXT,
  phone_consent_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  removed_at TEXT,
  CHECK ((phone IS NULL AND phone_consent_at IS NULL) OR (phone IS NOT NULL AND phone_consent_at IS NOT NULL)),
  UNIQUE (license_id, app_id)
);
CREATE INDEX idx_premium_wishlist_game ON premium_wishlist(app_id, removed_at);

CREATE TABLE premium_slot_watches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  license_id INTEGER NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
  app_id TEXT NOT NULL REFERENCES premium_games(app_id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('watching', 'sent', 'canceled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (license_id, app_id)
);
CREATE INDEX idx_premium_slot_watches_game ON premium_slot_watches(app_id, status);

CREATE TABLE premium_notification_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  license_id INTEGER NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
  app_id TEXT NOT NULL REFERENCES premium_games(app_id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('game_available', 'slot_available')),
  dedupe_key TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('scheduled', 'sending', 'sent', 'failed', 'canceled')),
  scheduled_at TEXT NOT NULL,
  sent_at TEXT,
  last_error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  slot_at TEXT,
  source_updated_at TEXT NOT NULL,
  lease_until TEXT,
  payload_json TEXT,
  first_attempt_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_premium_notification_due ON premium_notification_outbox(status, scheduled_at);

CREATE TRIGGER premium_wishlist_launch AFTER UPDATE OF coming_soon ON premium_games
WHEN OLD.coming_soon=1 AND NEW.coming_soon=0 AND NEW.enabled=1
BEGIN
  INSERT OR IGNORE INTO premium_notification_outbox
    (license_id,app_id,kind,dedupe_key,email,status,scheduled_at,source_updated_at,created_at,updated_at)
    SELECT license_id,app_id,'game_available',
      'launch:'||NEW.app_id||':'||NEW.updated_at||':'||id,email,'scheduled',NEW.updated_at,updated_at,NEW.updated_at,NEW.updated_at
    FROM premium_wishlist WHERE app_id=NEW.app_id AND removed_at IS NULL;
END;

CREATE TABLE premium_operations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  license_id INTEGER NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  reservation_id INTEGER REFERENCES premium_activations(id),
  status TEXT NOT NULL CHECK(status IN ('pending','active','failed','review')),
  cooldown_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(license_id,operation_id)
);
CREATE INDEX idx_premium_operation_owner ON premium_operations(license_id,app_id,status);
CREATE INDEX idx_premium_operation_pending ON premium_operations(status,created_at);
CREATE TRIGGER premium_operation_link AFTER INSERT ON premium_activations
WHEN NEW.operation_id IS NOT NULL
BEGIN
  UPDATE premium_operations SET reservation_id=NEW.id,updated_at=NEW.updated_at
    WHERE license_id=NEW.license_id AND operation_id=NEW.operation_id AND status='pending';
END;
CREATE TRIGGER premium_operation_complete AFTER UPDATE OF status ON premium_activations
WHEN NEW.status='active'
BEGIN
  UPDATE premium_operations SET status='active',cooldown_until=NEW.cooldown_until,updated_at=NEW.updated_at
    WHERE reservation_id=NEW.id AND status IN ('pending','review');
END;
CREATE TRIGGER premium_operation_fail AFTER UPDATE OF status ON premium_activations
WHEN NEW.status='failed'
BEGIN
  UPDATE premium_operations SET status='failed',updated_at=NEW.updated_at
    WHERE reservation_id=NEW.id AND status='pending';
END;

-- A retry owns the previous slot while the previous activation stays intact.
CREATE TRIGGER premium_retry_reservation BEFORE INSERT ON premium_activations
WHEN NEW.retry_of IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM premium_retry_grants g WHERE g.activation_id=NEW.retry_of
      AND g.license_id=NEW.license_id AND g.app_id=NEW.app_id
      AND g.status='processing' AND g.retry_activation_id IS NULL
  ) THEN RAISE(ABORT,'Premium retry authorization unavailable') END;
END;
CREATE TRIGGER premium_retry_link AFTER INSERT ON premium_activations
WHEN NEW.retry_of IS NOT NULL
BEGIN
  UPDATE premium_retry_grants SET retry_activation_id=NEW.id
    WHERE activation_id=NEW.retry_of AND status='processing' AND retry_activation_id IS NULL;
END;
CREATE TRIGGER premium_retry_complete AFTER UPDATE OF status ON premium_activations
WHEN NEW.status='active' AND OLD.status='processing' AND NEW.retry_of IS NOT NULL
BEGIN
  UPDATE premium_activations SET status='expired',updated_at=NEW.updated_at WHERE id=NEW.retry_of AND status='active';
  UPDATE premium_retry_grants SET status='used',updated_at=NEW.updated_at
    WHERE retry_activation_id=NEW.id AND status='processing';
END;
