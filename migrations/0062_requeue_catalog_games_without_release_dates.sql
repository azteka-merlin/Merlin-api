-- The public "Verify" flow used to mark a game as complete without persisting
-- Steam's release date. Reprocess every missing date with the corrected flow.
UPDATE catalog_enrichment_jobs
SET status = 'pending',
  attempts = 0,
  next_attempt_at = datetime('now'),
  locked_until = NULL,
  updated_at = datetime('now')
WHERE app_id IN (
  SELECT app_id
  FROM catalog_game_metadata
  WHERE release_date IS NULL OR trim(release_date) = ''
);
