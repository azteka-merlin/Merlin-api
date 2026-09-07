-- The public badge means Merlin can find the game through its search catalog.
-- Premium and correction sources remain tracked separately by the runtime sync.
INSERT INTO catalog_availability (app_id, available_in_merlin, premium_game_enabled, eligible_correction, checked_at)
SELECT app_id, 1, 0, 0, datetime('now')
FROM catalog_games
WHERE discovered_from IN ('games_catalog', 'search_engine')
  AND 1 = 1
ON CONFLICT(app_id) DO UPDATE SET
  available_in_merlin = 1,
  checked_at = excluded.checked_at;
