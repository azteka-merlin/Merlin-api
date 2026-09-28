ALTER TABLE home_content_items
ADD COLUMN image_zoom REAL NOT NULL DEFAULT 1 CHECK (image_zoom >= 1 AND image_zoom <= 4);
