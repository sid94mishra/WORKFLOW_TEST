ALTER TABLE monitors ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'
  CHECK (status IN ('pending', 'up', 'degraded', 'down'));
ALTER TABLE monitors ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0
  CHECK (consecutive_failures >= 0);
ALTER TABLE monitors ADD COLUMN last_checked_at TEXT NULL;

ALTER TABLE check_results ADD COLUMN status TEXT NOT NULL DEFAULT 'down'
  CHECK (status IN ('up', 'degraded', 'down'));
UPDATE check_results SET status = CASE ok WHEN 1 THEN 'up' ELSE 'down' END;
