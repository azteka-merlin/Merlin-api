-- The public availability badge is backed only by the active Premium registry
-- or an eligible correction. Search discovery must never make a game available.
UPDATE catalog_availability
SET available_in_merlin = CASE
  WHEN premium_game_enabled = 1 OR eligible_correction = 1 THEN 1
  ELSE 0
END,
checked_at = datetime('now')
WHERE available_in_merlin != CASE
  WHEN premium_game_enabled = 1 OR eligible_correction = 1 THEN 1
  ELSE 0
END;
