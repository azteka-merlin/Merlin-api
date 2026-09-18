CREATE TABLE manifest_source_settings_new (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  primary_source TEXT NOT NULL DEFAULT 'depotbox' CHECK (primary_source IN ('depotbox', 'ryuu', 'contrary')),
  updated_at TEXT NOT NULL
);

INSERT INTO manifest_source_settings_new (id, primary_source, updated_at)
SELECT id,
  CASE WHEN primary_source IN ('depotbox', 'ryuu', 'contrary') THEN primary_source ELSE 'depotbox' END,
  updated_at
FROM manifest_source_settings;

DROP TABLE manifest_source_settings;
ALTER TABLE manifest_source_settings_new RENAME TO manifest_source_settings;
