ALTER TABLE catalog_game_metadata ADD COLUMN release_date TEXT;

CREATE INDEX IF NOT EXISTS idx_catalog_metadata_release_date
  ON catalog_game_metadata(release_date DESC);

-- Prioritize visible Merlin titles so their release dates are populated first.
INSERT INTO catalog_enrichment_jobs (app_id, status, next_attempt_at, updated_at)
SELECT a.app_id, 'pending', datetime('now'), datetime('now')
FROM catalog_availability a
LEFT JOIN catalog_game_metadata m ON m.app_id = a.app_id
WHERE a.available_in_merlin = 1
  AND m.release_date IS NULL
ON CONFLICT(app_id) DO NOTHING;
