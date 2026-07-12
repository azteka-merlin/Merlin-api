ALTER TABLE premium_games ADD COLUMN activation_type TEXT NOT NULL DEFAULT 'steam_ticket';
ALTER TABLE premium_games ADD COLUMN launch_executable_path TEXT;

CREATE INDEX idx_premium_games_activation_type ON premium_games(activation_type);
