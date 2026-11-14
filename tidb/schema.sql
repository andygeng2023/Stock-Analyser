-- TiDB PostgreSQL-compatible schema for Stock Analyser.
-- Text timestamps and JSON payloads intentionally preserve the existing D1 data format.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  display_name TEXT,
  created_at TEXT NOT NULL,
  last_sign_in_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
CREATE TABLE IF NOT EXISTS watchlist_items (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ticker TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(user_id, ticker)
);
CREATE INDEX IF NOT EXISTS watchlist_items_ticker_created_idx ON watchlist_items(ticker, created_at);
CREATE INDEX IF NOT EXISTS watchlist_items_user_created_idx ON watchlist_items(user_id, created_at);
CREATE TABLE IF NOT EXISTS analysis_jobs (
  id TEXT PRIMARY KEY,
  ticker TEXT NOT NULL,
  period TEXT NOT NULL,
  horizon INTEGER NOT NULL,
  job_type TEXT NOT NULL DEFAULT 'analysis',
  scan_source TEXT NOT NULL DEFAULT 'both',
  save_to_indexer TEXT NOT NULL DEFAULT 'rapidIndex',
  status TEXT NOT NULL DEFAULT 'queued',
  result TEXT,
  error TEXT,
  client_ip_hash TEXT NOT NULL DEFAULT 'legacy',
  attempts INTEGER NOT NULL DEFAULT 0,
  progress INTEGER NOT NULL DEFAULT 0,
  stage TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS analysis_jobs_status_created_idx ON analysis_jobs(status, created_at);
CREATE INDEX IF NOT EXISTS analysis_jobs_cache_lookup_idx ON analysis_jobs(job_type, ticker, period, horizon, scan_source, status, created_at);
CREATE INDEX IF NOT EXISTS analysis_jobs_active_idx ON analysis_jobs(job_type, ticker, period, horizon, scan_source, save_to_indexer, status);
CREATE TABLE IF NOT EXISTS market_index (
  ticker TEXT NOT NULL,
  period TEXT NOT NULL,
  horizon INTEGER NOT NULL,
  indexer TEXT NOT NULL DEFAULT 'rapidIndex',
  result TEXT NOT NULL,
  source_job_id TEXT,
  indexed_at TEXT NOT NULL,
  market_cap DOUBLE PRECISION,
  avg_dollar_volume DOUBLE PRECISION,
  priority DOUBLE PRECISION NOT NULL DEFAULT 0,
  PRIMARY KEY(ticker, period, horizon, indexer)
);
CREATE INDEX IF NOT EXISTS market_index_lookup_idx ON market_index(ticker, indexer, period, horizon, indexed_at);
CREATE INDEX IF NOT EXISTS market_index_expiry_idx ON market_index(indexed_at);
CREATE TABLE IF NOT EXISTS market_index_catalog (
  ticker TEXT PRIMARY KEY,
  market_cap DOUBLE PRECISION,
  avg_dollar_volume DOUBLE PRECISION,
  priority DOUBLE PRECISION NOT NULL DEFAULT 0,
  last_indexed_at TEXT,
  last_slow_indexed_at TEXT,
  rapid_attempted_at TEXT,
  rapid_retry_after TEXT,
  rapid_last_error TEXT,
  slow_attempted_at TEXT,
  slow_retry_after TEXT,
  slow_last_error TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS market_index_catalog_priority_idx ON market_index_catalog(last_indexed_at, market_cap, avg_dollar_volume);
CREATE TABLE IF NOT EXISTS api_rate_limits (
  bucket_key TEXT PRIMARY KEY,
  window_start BIGINT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS api_rate_limits_window_idx ON api_rate_limits(window_start);
