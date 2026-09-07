-- Keep confirmed games without a Steam release date eligible for the daily retry.
UPDATE catalog_enrichment_jobs
SET status = 'pending',
  next_attempt_at = datetime('now'),
  locked_until = NULL,
  updated_at = datetime('now')
WHERE status = 'completed'
  AND app_id IN (
    SELECT app_id
    FROM catalog_game_metadata
    WHERE category IN ('premium', 'standard')
      AND release_date IS NULL
  );
