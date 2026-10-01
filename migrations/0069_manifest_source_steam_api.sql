CREATE TABLE manifest_source_settings_new (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  primary_source TEXT NOT NULL DEFAULT 'depotbox' CHECK (primary_source IN ('depotbox', 'ryuu', 'steam-api')),
  updated_at TEXT NOT NULL
);

INSERT INTO manifest_source_settings_new (id, primary_source, updated_at)
SELECT id,
  CASE primary_source
    WHEN 'ryuu' THEN 'ryuu'
    WHEN 'contrary' THEN 'steam-api'
    ELSE 'depotbox'
  END,
  updated_at
FROM manifest_source_settings;

DROP TABLE manifest_source_settings;
ALTER TABLE manifest_source_settings_new RENAME TO manifest_source_settings;
