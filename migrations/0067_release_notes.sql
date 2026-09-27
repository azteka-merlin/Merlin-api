CREATE TABLE IF NOT EXISTS release_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version TEXT NOT NULL UNIQUE,
  release_type TEXT NOT NULL CHECK (release_type IN ('major', 'standard')),
  hero_asset_key TEXT,
  hero_asset_path TEXT,
  hero_asset_filename TEXT,
  hero_asset_content_type TEXT,
  hero_asset_size_bytes INTEGER NOT NULL DEFAULT 0,
  published INTEGER NOT NULL DEFAULT 0 CHECK (published IN (0, 1)),
  published_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_release_notes_published
ON release_notes (published, published_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS release_note_localizations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  release_note_id INTEGER NOT NULL REFERENCES release_notes(id) ON DELETE CASCADE,
  locale TEXT NOT NULL CHECK (locale IN ('ptbr', 'en', 'es', 'fr', 'de')),
  title TEXT NOT NULL,
  subtitle TEXT NOT NULL,
  summary TEXT NOT NULL,
  highlights_json TEXT NOT NULL DEFAULT '[]',
  full_content_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (release_note_id, locale)
);

CREATE INDEX IF NOT EXISTS idx_release_note_localizations_release
ON release_note_localizations (release_note_id, locale);

INSERT OR IGNORE INTO release_notes (
  version, release_type, hero_asset_path, hero_asset_filename, hero_asset_content_type,
  hero_asset_size_bytes, published, published_at, created_at, updated_at
) VALUES (
  '2.0.0', 'major', '/release-assets/merlin-2.0.png', 'merlin-2.0.png', 'image/png',
  0, 1, '2026-09-27T22:00:00.000Z', '2026-09-27T22:00:00.000Z', '2026-09-27T22:00:00.000Z'
);

INSERT OR IGNORE INTO release_note_localizations (
  release_note_id, locale, title, subtitle, summary, highlights_json, full_content_json, created_at, updated_at
) VALUES
(
  (SELECT id FROM release_notes WHERE version = '2.0.0'),
  'ptbr',
  'O MERLIN 2.0 CHEGOU',
  'Uma nova experiência, por dentro e por fora.',
  'O Merlin ganhou uma experiência renovada, mais integrada, responsiva e consistente.',
  '[{"icon":"home","title":"Nova Home","description":"Uma nova experiência para descobrir lançamentos, destaques e tudo que está chegando ao Merlin."},{"icon":"steam","title":"Integração com a Steam","description":"Adicione jogos diretamente pela loja da Steam com o plugin do Merlin."},{"icon":"library","title":"Biblioteca renovada","description":"Gerencie seus jogos com uma interface mais rápida, limpa e integrada."},{"icon":"settings","title":"Premium e Correções redesenhados","description":"Mais espaço, melhor organização e acesso mais simples às suas ativações e correções."},{"icon":"sparkles","title":"Merlin de cara nova","description":"Uma interface inteira refinada, mais consistente, responsiva e com a identidade do Merlin em cada detalhe."}]',
  '["Nova Home","Plugin da Steam","Nova Biblioteca","Nova tela de Correções","Premium aprimorado","Novo sistema de conta","Melhorias de responsividade","Novo menu Minha conta","Skeletons de carregamento","Melhorias de desempenho","Correções e refinamentos gerais"]',
  '2026-09-27T22:00:00.000Z', '2026-09-27T22:00:00.000Z'
),
(
  (SELECT id FROM release_notes WHERE version = '2.0.0'),
  'en',
  'MERLIN 2.0 IS HERE',
  'A new experience, inside and out.',
  'Merlin has a renewed, more integrated, responsive, and consistent experience.',
  '[{"icon":"home","title":"New Home","description":"A new experience for discovering releases, highlights, and everything coming to Merlin."},{"icon":"steam","title":"Steam integration","description":"Add games directly from the Steam store with the Merlin plugin."},{"icon":"library","title":"Renewed Library","description":"Manage your games with a faster, cleaner, and more integrated interface."},{"icon":"settings","title":"Redesigned Premium and Fixes","description":"More space, better organization, and simpler access to your activations and fixes."},{"icon":"sparkles","title":"A new look for Merlin","description":"A fully refined, more consistent and responsive interface with Merlin identity in every detail."}]',
  '["New Home","Steam plugin","New Library","New Fixes screen","Improved Premium","New account system","Responsive improvements","New My Account menu","Loading skeletons","Performance improvements","General fixes and refinements"]',
  '2026-09-27T22:00:00.000Z', '2026-09-27T22:00:00.000Z'
),
(
  (SELECT id FROM release_notes WHERE version = '2.0.0'),
  'es',
  'MERLIN 2.0 YA ESTÁ AQUÍ',
  'Una nueva experiencia, por dentro y por fuera.',
  'Merlin estrena una experiencia renovada, más integrada, adaptable y consistente.',
  '[{"icon":"home","title":"Nueva página de inicio","description":"Una nueva experiencia para descubrir lanzamientos, destacados y todo lo que llega a Merlin."},{"icon":"steam","title":"Integración con Steam","description":"Añade juegos directamente desde la tienda de Steam con el plugin de Merlin."},{"icon":"library","title":"Biblioteca renovada","description":"Gestiona tus juegos con una interfaz más rápida, limpia e integrada."},{"icon":"settings","title":"Premium y Correcciones rediseñados","description":"Más espacio, mejor organización y acceso más sencillo a tus activaciones y correcciones."},{"icon":"sparkles","title":"Merlin estrena imagen","description":"Una interfaz refinada, más consistente y adaptable, con la identidad de Merlin en cada detalle."}]',
  '["Nueva página de inicio","Plugin de Steam","Nueva Biblioteca","Nueva pantalla de Correcciones","Premium mejorado","Nuevo sistema de cuenta","Mejoras de adaptabilidad","Nuevo menú Mi cuenta","Esqueletos de carga","Mejoras de rendimiento","Correcciones y mejoras generales"]',
  '2026-09-27T22:00:00.000Z', '2026-09-27T22:00:00.000Z'
),
(
  (SELECT id FROM release_notes WHERE version = '2.0.0'),
  'fr',
  'MERLIN 2.0 EST ARRIVÉ',
  'Une nouvelle expérience, à l’intérieur comme à l’extérieur.',
  'Merlin propose une expérience renouvelée, plus intégrée, réactive et cohérente.',
  '[{"icon":"home","title":"Nouvel accueil","description":"Une nouvelle expérience pour découvrir les sorties, les sélections et tout ce qui arrive dans Merlin."},{"icon":"steam","title":"Intégration Steam","description":"Ajoutez des jeux directement depuis la boutique Steam avec le plugin Merlin."},{"icon":"library","title":"Bibliothèque renouvelée","description":"Gérez vos jeux avec une interface plus rapide, claire et intégrée."},{"icon":"settings","title":"Premium et Corrections repensés","description":"Plus d’espace, une meilleure organisation et un accès simplifié à vos activations et corrections."},{"icon":"sparkles","title":"Merlin fait peau neuve","description":"Une interface entièrement affinée, plus cohérente et réactive, avec l’identité Merlin dans chaque détail."}]',
  '["Nouvel accueil","Plugin Steam","Nouvelle Bibliothèque","Nouvel écran Corrections","Premium amélioré","Nouveau système de compte","Améliorations de réactivité","Nouveau menu Mon compte","Squelettes de chargement","Améliorations des performances","Corrections et améliorations générales"]',
  '2026-09-27T22:00:00.000Z', '2026-09-27T22:00:00.000Z'
),
(
  (SELECT id FROM release_notes WHERE version = '2.0.0'),
  'de',
  'MERLIN 2.0 IST DA',
  'Ein neues Erlebnis, innen wie außen.',
  'Merlin bietet ein erneuertes, stärker integriertes, responsives und konsistentes Erlebnis.',
  '[{"icon":"home","title":"Neue Startseite","description":"Ein neues Erlebnis, um Veröffentlichungen, Highlights und alles Neue bei Merlin zu entdecken."},{"icon":"steam","title":"Steam-Integration","description":"Füge Spiele mit dem Merlin-Plugin direkt aus dem Steam-Shop hinzu."},{"icon":"library","title":"Erneuerte Bibliothek","description":"Verwalte deine Spiele mit einer schnelleren, klareren und besser integrierten Oberfläche."},{"icon":"settings","title":"Premium und Korrekturen neu gestaltet","description":"Mehr Platz, bessere Organisation und einfacherer Zugriff auf Aktivierungen und Korrekturen."},{"icon":"sparkles","title":"Merlin im neuen Look","description":"Eine vollständig verfeinerte, konsistentere und responsive Oberfläche mit Merlin-Identität in jedem Detail."}]',
  '["Neue Startseite","Steam-Plugin","Neue Bibliothek","Neue Korrekturen-Seite","Verbessertes Premium","Neues Kontosystem","Responsive Verbesserungen","Neues Mein-Konto-Menü","Lade-Skeletons","Leistungsverbesserungen","Allgemeine Korrekturen und Verbesserungen"]',
  '2026-09-27T22:00:00.000Z', '2026-09-27T22:00:00.000Z'
);
