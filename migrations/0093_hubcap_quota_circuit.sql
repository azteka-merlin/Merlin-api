CREATE TABLE IF NOT EXISTS hubcap_quota_circuit (
  key_hash TEXT PRIMARY KEY,
  retry_after INTEGER NOT NULL
);
