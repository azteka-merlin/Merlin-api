CREATE INDEX IF NOT EXISTS idx_catalog_enrichment_jobs_due
ON catalog_enrichment_jobs (status, next_attempt_at, locked_until);

CREATE INDEX IF NOT EXISTS idx_catalog_game_metadata_denuvo_checked
ON catalog_game_metadata (denuvo, checked_at);
