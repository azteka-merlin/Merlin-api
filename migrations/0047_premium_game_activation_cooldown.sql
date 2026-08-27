-- NULL preserves the established 24-hour default for every existing game.
ALTER TABLE premium_games ADD COLUMN activation_cooldown_hours INTEGER;

-- A configured per-game cooldown may only extend the standard 24-hour window.
CREATE TRIGGER premium_games_activation_cooldown_hours_insert
BEFORE INSERT ON premium_games
WHEN NEW.activation_cooldown_hours IS NOT NULL AND NEW.activation_cooldown_hours < 24
BEGIN
  SELECT RAISE(ABORT, 'activation_cooldown_hours must be at least 24');
END;

CREATE TRIGGER premium_games_activation_cooldown_hours_update
BEFORE UPDATE OF activation_cooldown_hours ON premium_games
WHEN NEW.activation_cooldown_hours IS NOT NULL AND NEW.activation_cooldown_hours < 24
BEGIN
  SELECT RAISE(ABORT, 'activation_cooldown_hours must be at least 24');
END;
