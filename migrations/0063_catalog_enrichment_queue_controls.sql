CREATE TABLE catalog_enrichment_jobs_new (
  app_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'retry', 'completed', 'paused', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  locked_until TEXT,
  updated_at TEXT NOT NULL
);

INSERT INTO catalog_enrichment_jobs_new (app_id, status, attempts, next_attempt_at, locked_until, updated_at)
SELECT app_id,
  CASE WHEN attempts >= 10 AND status IN ('pending', 'processing', 'retry') THEN 'failed' ELSE status END,
  attempts, next_attempt_at, locked_until, updated_at
FROM catalog_enrichment_jobs;

DROP TABLE catalog_enrichment_jobs;
ALTER TABLE catalog_enrichment_jobs_new RENAME TO catalog_enrichment_jobs;

CREATE INDEX idx_catalog_enrichment_jobs_due
ON catalog_enrichment_jobs (status, next_attempt_at, locked_until);

CREATE TABLE IF NOT EXISTS catalog_enrichment_settings (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  paused INTEGER NOT NULL DEFAULT 0 CHECK(paused IN (0, 1)),
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO catalog_enrichment_settings (id, paused, updated_at)
VALUES (1, 0, datetime('now'));
