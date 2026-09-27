CREATE TABLE IF NOT EXISTS home_content_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slot_type TEXT NOT NULL CHECK (slot_type IN ('hero', 'side', 'showcase')),
  position INTEGER NOT NULL CHECK (position >= 1),
  app_id TEXT,
  title TEXT NOT NULL,
  description TEXT,
  secondary_text TEXT,
  display_label TEXT,
  image_mode TEXT NOT NULL DEFAULT 'steam' CHECK (image_mode IN ('steam', 'custom')),
  image_url TEXT,
  image_key TEXT,
  image_filename TEXT,
  image_content_type TEXT,
  image_size_bytes INTEGER NOT NULL DEFAULT 0,
  image_position_x REAL NOT NULL DEFAULT 50 CHECK (image_position_x >= 0 AND image_position_x <= 100),
  image_position_y REAL NOT NULL DEFAULT 50 CHECK (image_position_y >= 0 AND image_position_y <= 100),
  primary_action TEXT NOT NULL DEFAULT 'none' CHECK (primary_action IN ('none', 'premium', 'add_game')),
  secondary_action TEXT NOT NULL DEFAULT 'none' CHECK (secondary_action IN ('none', 'premium', 'add_game')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (slot_type, position)
);

CREATE INDEX IF NOT EXISTS idx_home_content_slot_enabled_position
ON home_content_items (slot_type, enabled, position);

INSERT OR IGNORE INTO home_content_items (
  slot_type, position, app_id, title, description, secondary_text, display_label,
  image_mode, image_url, image_position_x, image_position_y,
  primary_action, secondary_action, enabled, created_at, updated_at
) VALUES
  ('hero', 1, '3669870', 'CONTROL Resonant', 'Uma nova ameaça paranormal transforma Manhattan em um campo de batalha sobrenatural.', NULL, 'LANÇAMENTO • 24 SET 2026', 'custom', 'https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/3669870/bcda7ae5b393697f658d82aa5ffedaac7511130d/page_bg_raw.jpg', 50, 50, 'premium', 'add_game', 1, datetime('now'), datetime('now')),
  ('hero', 2, '4358690', 'Graveyard Keeper 2', 'Construa, automatize e proteja uma cidade medieval com seu próprio exército de mortos-vivos.', NULL, 'LANÇAMENTO • 22 SET 2026', 'custom', 'https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/4358690/b3d62f77a0c9fa2f59c6baaba11a9af5eada2927/ss_b3d62f77a0c9fa2f59c6baaba11a9af5eada2927.1920x1080.jpg', 50, 50, 'premium', 'add_game', 1, datetime('now'), datetime('now')),
  ('hero', 3, '1636440', 'SILENT HILL: Townfall', 'Uma experiência de terror psicológico envolta em mistério, culpa e segredos inquietantes.', NULL, 'LANÇAMENTO • 23 SET 2026', 'custom', 'https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/1636440/0ed1cb4bc30631f95b92f7f13bb06c15d49b4afa/header.jpg', 50, 50, 'premium', 'add_game', 1, datetime('now'), datetime('now')),
  ('hero', 4, '4115450', 'Phantom Blade Zero', 'Combate veloz, fantasia sombria e a elegância marcial do Wuxia em uma jornada cinematográfica.', NULL, 'EM BREVE • 28 OUT 2026', 'custom', 'https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/4115450/8477e332081c0d28657885bf4b3c509823e289c9/page_bg_raw.jpg', 50, 50, 'premium', 'add_game', 1, datetime('now'), datetime('now')),
  ('hero', 5, '2254990', 'Permafrost', 'Sobreviva a um mundo congelado, explore ruínas e reconstrua seu abrigo em meio ao inverno eterno.', NULL, 'EM BREVE • 09 OUT 2026', 'custom', 'https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/2254990/30644896ad16ac56ca9bb9f006999e731c81902b/page_bg_raw.jpg', 50, 50, 'premium', 'add_game', 1, datetime('now'), datetime('now')),
  ('side', 1, '1245620', 'Elden Ring', NULL, 'RPG de ação', NULL, 'steam', 'https://cdn.akamai.steamstatic.com/steam/apps/1245620/header.jpg', 50, 50, 'none', 'none', 1, datetime('now'), datetime('now')),
  ('side', 2, '1174180', 'Red Dead Redemption 2', NULL, NULL, NULL, 'steam', 'https://cdn.akamai.steamstatic.com/steam/apps/1174180/header.jpg', 50, 50, 'none', 'none', 1, datetime('now'), datetime('now')),
  ('showcase', 1, '1086940', 'Baldur''s Gate 3', NULL, 'Disponível no Premium', NULL, 'steam', 'https://cdn.akamai.steamstatic.com/steam/apps/1086940/header.jpg', 50, 50, 'none', 'none', 1, datetime('now'), datetime('now')),
  ('showcase', 2, '1938090', 'Call of Duty', NULL, 'Alta procura', NULL, 'steam', 'https://cdn.akamai.steamstatic.com/steam/apps/1938090/header.jpg', 50, 50, 'none', 'none', 1, datetime('now'), datetime('now')),
  ('showcase', 3, '2050650', 'Resident Evil 4', NULL, 'Sobrevivência', NULL, 'steam', 'https://cdn.akamai.steamstatic.com/steam/apps/2050650/header.jpg', 50, 50, 'none', 'none', 1, datetime('now'), datetime('now')),
  ('showcase', 4, '271590', 'Grand Theft Auto V', NULL, 'Mundo aberto', NULL, 'steam', 'https://cdn.akamai.steamstatic.com/steam/apps/271590/header.jpg', 50, 50, 'none', 'none', 1, datetime('now'), datetime('now'));
