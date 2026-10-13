CREATE TABLE maintenance_windows (
  id TEXT PRIMARY KEY, title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  all_monitors INTEGER NOT NULL CHECK (all_monitors IN (0,1)),
  starts_at TEXT NOT NULL, ends_at TEXT NOT NULL,
  repeat_weekdays TEXT NULL, repeat_start_time TEXT NULL,
  repeat_duration_minutes INTEGER NULL CHECK (repeat_duration_minutes IS NULL OR repeat_duration_minutes BETWEEN 1 AND 10080),
  created_by_user_id TEXT NULL REFERENCES users(id) ON DELETE SET NULL,
  created_by_api_key_id TEXT NULL REFERENCES api_keys(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  CHECK (ends_at > starts_at),
  CHECK ((repeat_weekdays IS NULL) = (repeat_start_time IS NULL) AND (repeat_weekdays IS NULL) = (repeat_duration_minutes IS NULL)),
  CHECK (created_by_user_id IS NULL OR created_by_api_key_id IS NULL)
);
CREATE INDEX idx_maintenance_windows_range ON maintenance_windows (ends_at, starts_at);
CREATE TABLE maintenance_window_monitors (
  window_id TEXT NOT NULL REFERENCES maintenance_windows(id) ON DELETE CASCADE,
  monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  PRIMARY KEY (window_id, monitor_id)
);
CREATE INDEX idx_maintenance_window_monitors_monitor ON maintenance_window_monitors (monitor_id);
