ALTER TABLE public_feedback_images ADD COLUMN source TEXT NOT NULL DEFAULT 'uploaded';
ALTER TABLE public_feedback_images ADD COLUMN static_url TEXT;

INSERT INTO public_feedback_images (
  title,
  image_key,
  filename,
  content_type,
  size_bytes,
  sort_order,
  enabled,
  source,
  static_url,
  created_at,
  updated_at
)
SELECT
  'Feedback GRIS',
  'static/feedback-gris.jpeg',
  'feedback-gris.jpeg',
  'image/jpeg',
  0,
  1000,
  1,
  'static',
  '/download-assets/assets/feedbacks/feedback-gris.jpeg',
  datetime('now'),
  datetime('now')
WHERE NOT EXISTS (
  SELECT 1 FROM public_feedback_images WHERE source = 'static' AND filename = 'feedback-gris.jpeg'
);

INSERT INTO public_feedback_images (
  title, image_key, filename, content_type, size_bytes, sort_order, enabled, source, static_url, created_at, updated_at
)
SELECT
  'Feedback 007',
  'static/feedback-007.jpeg',
  'feedback-007.jpeg',
  'image/jpeg',
  0,
  1001,
  1,
  'static',
  '/download-assets/assets/feedbacks/feedback-007.jpeg',
  datetime('now'),
  datetime('now')
WHERE NOT EXISTS (
  SELECT 1 FROM public_feedback_images WHERE source = 'static' AND filename = 'feedback-007.jpeg'
);

INSERT INTO public_feedback_images (
  title, image_key, filename, content_type, size_bytes, sort_order, enabled, source, static_url, created_at, updated_at
)
SELECT
  'Feedback suporte',
  'static/feedback-suporte.jpeg',
  'feedback-suporte.jpeg',
  'image/jpeg',
  0,
  1002,
  1,
  'static',
  '/download-assets/assets/feedbacks/feedback-suporte.jpeg',
  datetime('now'),
  datetime('now')
WHERE NOT EXISTS (
  SELECT 1 FROM public_feedback_images WHERE source = 'static' AND filename = 'feedback-suporte.jpeg'
);

INSERT INTO public_feedback_images (
  title, image_key, filename, content_type, size_bytes, sort_order, enabled, source, static_url, created_at, updated_at
)
SELECT
  'Feedback Crimson simples',
  'static/feedback-crimson-simples.jpeg',
  'feedback-crimson-simples.jpeg',
  'image/jpeg',
  0,
  1003,
  1,
  'static',
  '/download-assets/assets/feedbacks/feedback-crimson-simples.jpeg',
  datetime('now'),
  datetime('now')
WHERE NOT EXISTS (
  SELECT 1 FROM public_feedback_images WHERE source = 'static' AND filename = 'feedback-crimson-simples.jpeg'
);

INSERT INTO public_feedback_images (
  title, image_key, filename, content_type, size_bytes, sort_order, enabled, source, static_url, created_at, updated_at
)
SELECT
  'Feedback Crimson gameplay',
  'static/feedback-crimson-gameplay.jpeg',
  'feedback-crimson-gameplay.jpeg',
  'image/jpeg',
  0,
  1004,
  1,
  'static',
  '/download-assets/assets/feedbacks/feedback-crimson-gameplay.jpeg',
  datetime('now'),
  datetime('now')
WHERE NOT EXISTS (
  SELECT 1 FROM public_feedback_images WHERE source = 'static' AND filename = 'feedback-crimson-gameplay.jpeg'
);

INSERT INTO public_feedback_images (
  title, image_key, filename, content_type, size_bytes, sort_order, enabled, source, static_url, created_at, updated_at
)
SELECT
  'Feedback Black Flag',
  'static/feedback-black-flag.jpeg',
  'feedback-black-flag.jpeg',
  'image/jpeg',
  0,
  1005,
  1,
  'static',
  '/download-assets/assets/feedbacks/feedback-black-flag.jpeg',
  datetime('now'),
  datetime('now')
WHERE NOT EXISTS (
  SELECT 1 FROM public_feedback_images WHERE source = 'static' AND filename = 'feedback-black-flag.jpeg'
);
