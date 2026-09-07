-- These were resolved before the Steam release-date parser was corrected.
UPDATE catalog_enrichment_jobs
SET status = 'pending',
  attempts = 0,
  next_attempt_at = datetime('now'),
  locked_until = NULL,
  updated_at = datetime('now')
WHERE app_id IN (
  SELECT app_id
  FROM catalog_game_metadata
  WHERE category IN ('premium', 'standard')
    AND release_date IS NULL
);
