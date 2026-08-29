CREATE TABLE IF NOT EXISTS manifest_source_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  primary_source TEXT NOT NULL DEFAULT 'depotbox' CHECK (primary_source IN ('depotbox', 'ryuu')),
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO manifest_source_settings (id, primary_source, updated_at)
VALUES (1, 'depotbox', CURRENT_TIMESTAMP);
