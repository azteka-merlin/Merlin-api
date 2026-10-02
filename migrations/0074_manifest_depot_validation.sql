ALTER TABLE manifest_source_settings ADD COLUMN validate_depotbox INTEGER NOT NULL DEFAULT 0 CHECK (validate_depotbox IN (0, 1));
ALTER TABLE manifest_source_settings ADD COLUMN validate_ryuu INTEGER NOT NULL DEFAULT 0 CHECK (validate_ryuu IN (0, 1));
ALTER TABLE manifest_source_settings ADD COLUMN validate_steam_api INTEGER NOT NULL DEFAULT 0 CHECK (validate_steam_api IN (0, 1));
