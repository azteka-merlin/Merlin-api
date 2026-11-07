CREATE TABLE game_image_source_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  ryuu_enabled INTEGER NOT NULL DEFAULT 1 CHECK (ryuu_enabled IN (0,1)),
  hubcap_enabled INTEGER NOT NULL DEFAULT 1 CHECK (hubcap_enabled IN (0,1)),
  updated_at TEXT NOT NULL
);
INSERT INTO game_image_source_settings (id,ryuu_enabled,hubcap_enabled,updated_at)
VALUES (1,1,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
