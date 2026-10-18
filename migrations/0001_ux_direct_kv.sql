CREATE TABLE IF NOT EXISTS ux_direct_kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS ux_direct_kv_updated_at
  ON ux_direct_kv(updated_at);
