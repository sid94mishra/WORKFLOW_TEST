CREATE TABLE monitors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL
    CHECK (length(name) BETWEEN 1 AND 100),
  url TEXT NOT NULL
    CHECK (length(url) <= 2048),
  method TEXT NOT NULL DEFAULT 'GET'
    CHECK (method IN ('GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS')),
  interval_seconds INTEGER NOT NULL DEFAULT 60
    CHECK (interval_seconds BETWEEN 30 AND 86400),
  timeout_ms INTEGER NOT NULL DEFAULT 10000
    CHECK (timeout_ms BETWEEN 1000 AND 60000),
  expected_status INTEGER NOT NULL DEFAULT 200
    CHECK (expected_status BETWEEN 100 AND 599),
  keyword TEXT NULL
    CHECK (keyword IS NULL OR length(keyword) BETWEEN 1 AND 200),
  enabled INTEGER NOT NULL DEFAULT 1
    CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_monitors_created_at ON monitors (created_at);
CREATE TABLE check_results (
  id TEXT PRIMARY KEY,
  monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  checked_at TEXT NOT NULL,
  ok INTEGER NOT NULL
    CHECK (ok IN (0, 1)),
  status_code INTEGER NULL,
  latency_ms INTEGER NOT NULL
    CHECK (latency_ms >= 0),
  error TEXT NULL,
  keyword_matched INTEGER NULL
    CHECK (keyword_matched IS NULL OR keyword_matched IN (0, 1))
);
CREATE INDEX idx_check_results_monitor_checked
  ON check_results (monitor_id, checked_at DESC);
