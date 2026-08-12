ALTER TABLE announcements ADD COLUMN image_fit TEXT NOT NULL DEFAULT 'cover';
ALTER TABLE announcements ADD COLUMN image_position_x INTEGER NOT NULL DEFAULT 50;
ALTER TABLE announcements ADD COLUMN image_position_y INTEGER NOT NULL DEFAULT 50;
