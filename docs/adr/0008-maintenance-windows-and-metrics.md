# ADR 0008: Maintenance windows as a derived display state, suppression at record time, and a hybrid Prometheus endpoint

- **Status:** Accepted
- **Date:** 2026-10-13
- **Deciders:** Pulse maintainers
- **Related:** [Iteration 5 spec](../specs/maintenance-windows-and-metrics.md),
  [ADR 0003](0003-in-process-scheduler.md), [ADR 0004](0004-incidents-and-notification-delivery.md),
  [ADR 0005](0005-public-status-page-and-badges.md), [ADR 0006](0006-authentication-sessions-and-api-keys.md)

## Context

Operators need to silence alerts during planned work and to scrape Pulse from Prometheus.
Forces:

- Incidents and their events are created in one place: the `ResultRepository.record`
  transaction (ADR 0004). The `Notifier` only delivers what it is given.
- Tests drive time with fake clocks and explicit `checkedAt` values. Suppression must be
  deterministic for a given check, regardless of when the scheduler happened to run.
- The stored monitor status feeds a state machine (`consecutive_failures`, the down threshold)
  and uptime. The status page, badges and dashboard only *display* it.
- The API (Node) and the web (browser) both need to answer "is this window active, and when is
  the next occurrence?" The answer has to be identical in both.
- One process, one SQLite file (ADR 0001/0003), no new paid or heavy dependencies.
- `/metrics` is outside `/api/v1/`, but it exposes monitor names and must not be public by default.

## Decision

1. **Schedule model: a one-off range, or a weekly repeat bounded by that range, all in UTC.** A
   window has `startsAt`/`endsAt` and an optional `{ weekdays[], startTime "HH:MM",
   durationMinutes ≤ 7 d }`. Occurrences start on the listed UTC weekdays. They MAY cross
   midnight and Sat→Sun, and are **clipped** to `[startsAt, endsAt)`. Intervals are half-open.
   If several windows are active, the earliest-started occurrence wins, with ties broken on `id`.
2. **One pure evaluator in `@pulse/shared`** (`currentOccurrence`, `nextOccurrence`,
   `activeWindowFor`, `upcomingOccurrences`). The API (suppression, display, metrics) and the web
   (labels, previews) import the same code. SQL only pre-filters by range (`starts_at <= t AND
   ends_at > t`). The weekly logic never lives in SQL.
3. **Suppress when the event is created, evaluated at `outcome.checkedAt`.** Inside the existing
   `record()` transaction, an active window keeps every write (result row, daily uptime,
   `consecutive_failures`, stored status). It prevents only **opening** an incident and
   **emitting** any event. An incident already open is left alone. If the monitor recovers
   inside the window, the incident is resolved with its true timestamps, but the resolve event
   is not sent. After the window, the normal rules resume: a monitor that is still failing opens
   its incident at the first failing check after `endsAt`. Events created before the window are
   still delivered.
4. **`maintenance` is a display state, never a stored status.** `MONITOR_STATUSES` is unchanged.
   `PublicMonitorStatus` and `OverallStatus` gain `maintenance`, derived per request with the
   precedence paused > maintenance > stored. The dashboard API exposes the raw `status` plus
   `maintenance: ActiveMaintenance | null`, and the client derives the badge. Uptime is not
   adjusted.
5. **`/metrics`: one auth path and a hybrid data source.** The existing auth hook also guards
   `/metrics`, so sessions, read keys and write keys work with no new code path.
   `PULSE_METRICS_PUBLIC=true` sets the route's `config.public`. Gauges (`pulse_monitor_up`,
   `pulse_open_incidents`, `pulse_maintenance_active`) are read from SQLite at scrape time. The
   counter `pulse_checks_total{result="ok"|"fail"}` and the histogram
   `pulse_check_duration_seconds` (buckets 0.05 … 60 s) are in-process and reset on restart, as
   Prometheus expects. A ~100-line pure renderer in `@pulse/shared` writes text format 0.0.4.

## Alternatives considered

| Option | Why not |
| --- | --- |
| RRULE / iCal recurrence (`rrule` npm) | A large surface (DST, `BYSETPOS`, exceptions) for a need that "weekly on these days at HH:MM" covers. It adds a dependency, and the UI is hard to make accessible. Weekly rules can be converted to RRULE later. |
| Local time zones per window | It introduces DST gaps and overlaps, and requires a tz database in the browser and the server to agree. UTC is unambiguous, and the UI labels it. |
| Store `status = 'maintenance'` on the monitor | That breaks the failure state machine and the "down after 3 failures" logic, loses the truth needed when the window ends, and races with window edits. Display derivation is cheap. |
| Pause checks during maintenance | Operators lose the data that shows when the service actually came back, and the brief requires checks to keep running. |
| Filter in the `Notifier` (drop events at delivery) | Incidents would still open, and the status page would show them. The decision would depend on the delivery time, which is nondeterministic and affected by retries, not on the check time. |
| Close or reopen open incidents at window boundaries | It invents incident boundaries that never happened and sends confusing notifications at window edges. |
| Send the suppressed `incident.resolved` after the window | It needs a durable "pending notifications" queue and only matters in an edge case. It is documented as a known gap. |
| Exclude maintenance checks from uptime | Desirable for SLAs, but it changes `daily_uptime` semantics and needs a backfill story. Deferred. |
| `prom-client` | A 1 MB+ dependency with a global registry, which conflicts with the per-`buildApp` test isolation. Five families do not justify it. |
| All metrics computed from SQLite at scrape time | A histogram over all `check_results` is O(rows) on every scrape, and counters would *decrease* when monitors are deleted. |
| All metrics in memory | Gauges would be wrong until the first check after a restart. The DB already knows the current state. |
| Per-monitor labels on the histogram and counter | Cardinality grows with monitors × buckets. Deferred until someone asks. `pulse_monitor_up` carries per-monitor state. |
| A separate token or IP allow-list for `/metrics` | It duplicates the auth logic. A read-scope API key is exactly "read-only credential for a machine". |

## Consequences

Positive:

- Suppression is a few lines in one transaction. It is deterministic under fake clocks and
  cannot race with delivery.
- The stored status and history stay truthful. Metrics and the dashboard can show "down, but in
  maintenance", which is what an operator needs.
- One evaluator means the web preview and the server agree on every occurrence.
- No new runtime dependency. `/metrics` inherits the hardened auth hook and the route-sweep test.

Negative / trade-offs:

- An incident that opened before a window and recovers inside it gets **no** resolve
  notification. Consumers that track open alerts (pagers) stay open until a human closes them.
  The behaviour is documented, and a later iteration may add deferred delivery.
- Uptime still counts failures inside maintenance.
- Window titles affecting a public monitor are public. The UI warns about this.
- Counters and the histogram reset on restart, and with `PULSE_METRICS_PUBLIC=true` every
  monitor name (including private ones) is exposed. `server.ts` warns about this.
- UTC-only scheduling means operators convert local times themselves. The dialog labels every
  field "(UTC)".
