-- Re-run only visible Merlin titles that were enriched before release_date support.
UPDATE catalog_enrichment_jobs
SET status = 'pending',
  attempts = 0,
  next_attempt_at = datetime('now'),
  locked_until = NULL,
  updated_at = datetime('now')
WHERE app_id IN (
  SELECT a.app_id
  FROM catalog_availability a
  LEFT JOIN catalog_game_metadata m ON m.app_id = a.app_id
  WHERE a.available_in_merlin = 1
    AND m.release_date IS NULL
);
