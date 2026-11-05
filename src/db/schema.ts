// Argus event store schema (SQLite / libSQL). docs/plan.md section 2.
// Embedded as a string so migrate() works the same in scripts, tests, and bundled route handlers.
// Version 3: fire_presence holds counts per 0.02 degree sub-cell instead of per 1 degree cell.
export const SCHEMA_VERSION = 3;

export const SCHEMA_SQL = `
-- Every events row is an immutable version; nothing updates a row after insert.

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  record_key TEXT NOT NULL,
  source TEXT NOT NULL,
  kind TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL,
  source_updated_at INTEGER,
  lat REAL,
  lon REAL,
  min_lat REAL,
  min_lon REAL,
  max_lat REAL,
  max_lon REAL,
  title TEXT NOT NULL,
  facts TEXT NOT NULL,
  meta TEXT,
  raw TEXT,
  raw_gz BLOB,
  raw_digest TEXT NOT NULL,
  fetch_id TEXT,
  supersedes TEXT,
  CHECK ((raw IS NULL) <> (raw_gz IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_events_kind_time ON events (kind, occurred_at);
CREATE INDEX IF NOT EXISTS idx_events_record_key ON events (record_key);
CREATE INDEX IF NOT EXISTS idx_events_lat_lon ON events (lat, lon);

-- Detection and aggregate membership. Capped at 500 members per parent in code.
CREATE TABLE IF NOT EXISTS event_links (
  parent_id TEXT NOT NULL,
  child_id TEXT NOT NULL,
  PRIMARY KEY (parent_id, child_id)
) WITHOUT ROWID;
-- Citations look up what links to a version (its parents).
CREATE INDEX IF NOT EXISTS idx_event_links_child ON event_links (child_id);

-- One row per source per UTC hour; errors get their own rows.
CREATE TABLE IF NOT EXISTS fetch_log (
  source TEXT NOT NULL,
  hour_start INTEGER NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  last_status INTEGER,
  last_ok_at INTEGER,
  PRIMARY KEY (source, hour_start)
) WITHOUT ROWID;
-- Retention prunes by hour across sources.
CREATE INDEX IF NOT EXISTS idx_fetch_log_hour ON fetch_log (hour_start);

CREATE TABLE IF NOT EXISTS fetch_errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  at INTEGER NOT NULL,
  url TEXT NOT NULL,
  status INTEGER,
  message TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fetch_errors_source_at ON fetch_errors (source, at);
CREATE INDEX IF NOT EXISTS idx_fetch_errors_at ON fetch_errors (at);

-- Per-source backoff that survives restarts (adsb.lol and CelesTrak must stop on errors).
CREATE TABLE IF NOT EXISTS backoff (
  source TEXT PRIMARY KEY,
  failures INTEGER NOT NULL,
  next_allowed_at INTEGER NOT NULL,
  last_status INTEGER,
  updated_at INTEGER NOT NULL
);

-- Fire presence per local solar day and satellite: counted detections per persistence sub-cell,
-- gzipped JSON { "d": sorted sub-cell ids, delta-coded, "n": counts } (see firms.ts).
CREATE TABLE IF NOT EXISTS fire_presence (
  day_key INTEGER NOT NULL,
  satellite TEXT NOT NULL,
  subcells_gz BLOB NOT NULL,
  PRIMARY KEY (day_key, satellite)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS briefs (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  window_start INTEGER NOT NULL,
  window_end INTEGER NOT NULL,
  input_digest TEXT NOT NULL,
  model TEXT NOT NULL,
  bullets TEXT NOT NULL,
  check_result TEXT NOT NULL,
  status TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_micros INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_briefs_created ON briefs (created_at);

CREATE TABLE IF NOT EXISTS model_cache (
  input_digest TEXT PRIMARY KEY,
  route TEXT NOT NULL,
  model TEXT NOT NULL,
  response TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_model_cache_created ON model_cache (created_at);

CREATE TABLE IF NOT EXISTS model_spend (
  day TEXT NOT NULL,
  route TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_micros INTEGER NOT NULL DEFAULT 0,
  reserved_micros INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, route)
) WITHOUT ROWID;
-- The eval's all-time cap sums one route over every day.
CREATE INDEX IF NOT EXISTS idx_model_spend_route ON model_spend (route);

CREATE TABLE IF NOT EXISTS rate_limits (
  client_key TEXT NOT NULL,
  route TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (client_key, route, window_start)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_rate_limits_window ON rate_limits (window_start);

CREATE TABLE IF NOT EXISTS write_budget (
  day TEXT PRIMARY KEY,
  billed_writes INTEGER NOT NULL DEFAULT 0,
  ask_writes INTEGER NOT NULL DEFAULT 0
);

-- Single-flight lease so two ingest workers never overlap.
CREATE TABLE IF NOT EXISTS worker_lease (
  name TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
`;
