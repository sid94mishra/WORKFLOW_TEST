# Pulse — Iteration 5: Maintenance windows and Prometheus metrics

- **Status:** Ready for implementation
- **Date:** 2026-10-13
- **Builds on:** [Iteration 1 spec](iteration-1.md) (conventions in §4.4 there still apply),
  [Iteration 3 spec](incidents-webhook-notifications-status-page-and-badges.md),
  [Iteration 4 spec](auth-api-keys-docker-image-and-operator-docs.md)
- **Decisions:** [ADR 0008 – Maintenance windows and metrics](../adr/0008-maintenance-windows-and-metrics.md)

Normative words: **MUST**, **SHOULD**, **MAY** (RFC 2119). Anything not specified here is the
implementer's choice, provided all acceptance criteria (§6) pass.

## 1. Summary

- **Maintenance windows.** Operators schedule planned work under `/api/v1/maintenance`. A window
  has a title, a target (a list of monitors or `"all"`), a UTC range `[startsAt, endsAt)`, and an
  optional **weekly repeat** (UTC weekdays + `HH:MM` start + duration in minutes). For a weekly
  window, the range is the series' validity period.
- **While a window is active for a monitor**, checks still run and are recorded exactly as
  before (status, `consecutive_failures`, uptime). But **no incident is opened and no
  notification is enqueued**. Suppression is decided at the check's `checkedAt`, not the wall
  clock.
- **Display:** the status page, the status badge and the dashboard show **Maintenance** (blue)
  instead of the stored status. `maintenance` is a derived display state. It is never stored in
  `monitors.status`.
- **Status page:** a new **Upcoming maintenance** section lists occurrences in the next 7 days.
  Each affected monitor row shows the active window's title.
- **Metrics:** `GET /metrics` serves the Prometheus text format with `pulse_monitor_up`,
  `pulse_check_duration_seconds` (histogram), `pulse_checks_total{result}`,
  `pulse_open_incidents` and `pulse_maintenance_active`. Any credential is accepted (session, read
  key or write key). `PULSE_METRICS_PUBLIC=true` makes the endpoint public.
- **Web:** a **Maintenance** page (list, create/edit dialog, delete with confirm), plus a
  **Maintenance** badge on monitor rows.
- **Docs:** `docs/operations.md` gains `PULSE_METRICS_PUBLIC`, the metrics endpoint and a
  Prometheus scrape example.

## 2. Scope

**In scope**

| Package / area | Work |
| --- | --- |
| `@pulse/shared` | **Done by the architect in this iteration:** `maintenance.ts` (schemas, types, limits, pure evaluator) and `metrics.ts` (names, buckets, exposition renderer). Additive changes to `monitor.ts`, `status-page.ts` and `badge.ts`, plus tests (§3.1). |
| `@pulse/checker` | **No changes.** |
| `@pulse/api` | Migration `006_maintenance.sql`; `MaintenanceRepository`; maintenance routes; suppression in `ResultRepository.record`; `maintenance` on monitor responses; status page, HTML and badge changes; `MetricsRegistry` + `GET /metrics`; config `PULSE_METRICS_PUBLIC`; auth hook extension; tests (§3.2–§3.9). |
| `@pulse/web` | API client methods; `MaintenanceView` + `MaintenanceDialog`; route and nav; Maintenance badge on monitor rows and the detail header (§4). |
| Docs | `docs/operations.md` (env row, metrics section, scrape example); README (status line, API table, features, docs links); this spec; ADR 0008. |

**Out of scope** (later iterations)

- Excluding maintenance time from uptime percentages or SLA reports. Checks inside a window count
  as usual. See ADR 0008.
- RRULE/iCal recurrence, monthly or daily-by-date rules, per-window time zones, exceptions
  ("skip next Tuesday"). The weekly repeat covers "every night" with all 7 weekdays selected.
- Notifications **about** maintenance (start/end webhooks, subscriber emails), and a "send a
  delayed resolve after the window" queue.
- Pausing checks during maintenance. Checks always run.
- Per-monitor labels on the latency histogram and the checks counter, process metrics
  (`process_*`, `nodejs_*`), `prom-client`, OpenMetrics format, push gateway.
- Showing private monitors' names on the public status page (unchanged rule: public monitors only).
- Playwright e2e.

## 3. API and data changes

Conventions from iteration-1 §4.4 and iteration-4 §3 apply: `{ data }` envelopes, `{ error: {
code, message, issues? } }`, `404 NOT_FOUND` for unknown **or non-UUID** ids, `415` for
non-JSON bodies, `400 VALIDATION_ERROR` with zod `issues`, and the auth precedence (`401` > `403`
> `404`/`415`/`400`). Timestamps are ISO-8601 UTC strings. Time comes from `Date.now()` / `new
Date()` so tests can use fake timers. Times passed to the evaluator are the **check's
`checkedAt`** for suppression, and **request time** for display.

### 3.1 `@pulse/shared` (implemented; engineers consume it)

`@pulse/shared` still MUST NOT import Node built-ins. Everything below is exported from
`index.ts`. All existing exports are unchanged, and all schema changes are **additive** (new
optional fields, widened enums). Tests: `packages/shared/test/maintenance.test.ts` and
`metrics.test.ts`.

#### 3.1.1 `maintenance.ts`

Constants:

```ts
MAINTENANCE_LIMITS = {
  titleMaxLength: 120,
  monitorIdsMax: 500,
  maxDurationMinutes: 10_080,  // 7 days: one-off window length AND weekly occurrence length
  maxSeriesDays: 1_830,        // 5 × 366: weekly series endsAt − startsAt
}
UPCOMING_MAINTENANCE_DAYS = 7
UPCOMING_MAINTENANCE_LIMIT = 20
ALL_MONITORS = 'all'
```

| Schema | Definition |
| --- | --- |
| `WeeklyRepeatSchema` | strict `{ weekdays: int 0–6[], 1–7 entries, unique, output sorted ascending; startTime: "HH:MM" (00:00–23:59, UTC); durationMinutes: int 1–10 080 }`. Weekdays follow `getUTCDay()` (0 = Sunday … 6 = Saturday). |
| `MaintenanceMonitorIdsSchema` | `'all'` **or** `uuid[]` with 1–500 entries. |
| `MaintenanceCreatedBySchema` | strict `{ kind: 'user' \| 'apiKey', id: uuid }`. |
| `MaintenanceWindowCreateSchema` | strict `{ title: trim 1–120, monitorIds, startsAt: iso (Z), endsAt: iso (Z), repeat: WeeklyRepeat \| null = null }` + range rules (below). |
| `MaintenanceWindowUpdateSchema` | strict, all fields optional (`repeat: null` clears the repeat), at least one field. The range rules run only when both ends are in the body. **The route MUST re-validate the merged window** with `MaintenanceWindowCreateSchema` (same pattern as monitors). |
| `MaintenanceWindowSchema` (response) | strict `{ id, title, monitorIds, startsAt, endsAt, repeat, createdBy: MaintenanceCreatedBy \| null, createdAt, updatedAt, active: boolean, nextOccurrence: { startsAt, endsAt } \| null }`. `active` and `nextOccurrence` are computed at request time. |
| `ActiveMaintenanceSchema` | strict `{ id, title, startsAt, endsAt }`. This is the **current occurrence**, clipped to the series. It is used on monitors and on public monitors. |
| `PublicMaintenanceSchema` | strict `{ id, title, startsAt, endsAt, active, allMonitors, monitors: { id, name }[] }`. These are status page entries. |

**Range rules** (`checkMaintenanceRange`, issues at path `['endsAt']`):

- `endsAt > startsAt`, else `"endsAt must be after startsAt"`.
- One-off (`repeat === null`): `endsAt − startsAt ≤ 7 days`.
- Weekly: `endsAt − startsAt ≤ 1830 days`. `endsAt` is always required: there are no unbounded
  series.
- Datetimes MUST be UTC with `Z` (`z.iso.datetime()`, as elsewhere). Offsets are rejected. The
  web sends `Date#toISOString()`.
- Windows entirely in the past are allowed (they serve as a record). `startsAt` in the past is
  allowed.

**Evaluator (pure, UTC, half-open intervals `[start, end)`).** Every function accepts
`startsAt`/`endsAt` as ISO strings or `Date`s:

| Function | Semantics |
| --- | --- |
| `parseTimeOfDay('HH:MM') → minutes` | Throws `RangeError` on malformed input. |
| `currentOccurrence(window, at) → { startsAt, endsAt } \| null` | One-off: `[startsAt, endsAt)`. Weekly: for each listed weekday `d`, the occurrence starts on a UTC day with weekday `d` at `startTime` and lasts `durationMinutes`. It MAY run past midnight and Sat→Sun. Every occurrence is **clipped** to `[startsAt, endsAt)`, so a window is never active outside its series range, and an occurrence that began before `startsAt` is active from `startsAt`. If occurrences overlap, the earliest-starting one wins. |
| `isWindowActive(window, at)` | `currentOccurrence(...) !== null`. |
| `nextOccurrence(window, at)` | The occurrence in progress, else the next one to start, else `null` (series over). |
| `occurrencesBetween(window, from, to)` | Clipped occurrences overlapping `[from, to)`, sorted. Keep ranges small (days). |
| `windowAppliesTo(window, monitorId)` | `monitorIds === 'all' \|\| monitorIds.includes(monitorId)`. |
| `activeWindowFor(monitorId, windows, at) → ActiveMaintenance \| null` | Among applicable active windows, the one whose current occurrence **started earliest**; ties break on lowest `id`. API, status page and web MUST use this so they agree. |
| `upcomingOccurrences(windows, from, to, limit = 20)` | Every occurrence overlapping `[from, to)`, with `active = start ≤ from`, sorted by `startsAt` then window `id`, then cut to `limit`. |

The weekday is the weekday on which an occurrence **starts**. "Tue 23:00 for 120 min" covers Tue
23:00 to Wed 01:00, and not Mon 23:30.

#### 3.1.2 Display state (`status-page.ts`, `monitor.ts`, `badge.ts`)

- `OVERALL_STATUSES` gains `'maintenance'`. `PUBLIC_MONITOR_STATUSES` /
  `PublicMonitorStatusSchema` gain `'maintenance'`, and `PublicMonitorStatus` is exported.
  `MONITOR_STATUSES` (stored) is **unchanged**.
- `publicMonitorStatus({ enabled, status }, inMaintenance)` uses the precedence **paused >
  maintenance > stored status**. A disabled monitor never shows Maintenance.
- `overallStatus` ignores `paused`. If every remaining monitor is in `maintenance`, the result is
  `'maintenance'`. Otherwise it also ignores `maintenance` monitors and applies the iteration-3
  rules. For example, `[maintenance, up]` → `operational` and `[maintenance, down]` →
  `major_outage`.
- `MonitorSchema` gains `maintenance: ActiveMaintenance | null` (optional in the schema for
  backward compatibility). The API **MUST** always send it.
- `PublicMonitorSchema` gains `maintenance: ActiveMaintenance | null`, and `StatusPageSchema`
  gains `upcomingMaintenance: PublicMaintenance[]` (≤ 20). Both are optional in the schema, and
  the API **MUST** always send them.
- `STATUS_BADGE_COLORS = { up '#4c1', degraded '#dfb317', down '#e05d44', pending '#9f9f9f',
  paused '#9f9f9f', maintenance '#007ec6' }`.

#### 3.1.3 `metrics.ts`

`METRICS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8'`, `CHECK_RESULT_LABELS =
['ok', 'fail']`, `CHECK_DURATION_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60]`
(seconds, `+Inf` implicit), and `METRICS` (name, type, help for the five families). Pure helpers:
`renderPrometheus(families)` (HELP, TYPE, samples, trailing newline), `escapeLabelValue` (`\` →
`\\`, `"` → `\"`, newline → `\n`), `escapeHelp`, `formatMetricValue` (`NaN`, `+Inf`, `-Inf`),
`histogramSamples(buckets, perBucketCounts, sum, labels?)` (cumulative buckets, `+Inf`, `_sum`,
`_count`) and `bucketIndex(buckets, value)`.

### 3.2 Database — `apps/api/migrations/006_maintenance.sql`

```sql
CREATE TABLE maintenance_windows (
  id                      TEXT PRIMARY KEY,                     -- uuid
  title                   TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  all_monitors            INTEGER NOT NULL CHECK (all_monitors IN (0, 1)),
  starts_at               TEXT NOT NULL,                        -- ISO UTC
  ends_at                 TEXT NOT NULL,                        -- ISO UTC, > starts_at
  repeat_weekdays         TEXT NULL,                            -- e.g. '0,6' (sorted, unique)
  repeat_start_time       TEXT NULL,                            -- 'HH:MM'
  repeat_duration_minutes INTEGER NULL CHECK (repeat_duration_minutes IS NULL OR repeat_duration_minutes BETWEEN 1 AND 10080),
  created_by_user_id      TEXT NULL REFERENCES users(id) ON DELETE SET NULL,
  created_by_api_key_id   TEXT NULL REFERENCES api_keys(id) ON DELETE SET NULL,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  CHECK (ends_at > starts_at),
  CHECK ((repeat_weekdays IS NULL) = (repeat_start_time IS NULL)
     AND (repeat_weekdays IS NULL) = (repeat_duration_minutes IS NULL)),
  CHECK (created_by_user_id IS NULL OR created_by_api_key_id IS NULL)
);
CREATE INDEX idx_maintenance_windows_range ON maintenance_windows (ends_at, starts_at);

CREATE TABLE maintenance_window_monitors (
  window_id  TEXT NOT NULL REFERENCES maintenance_windows(id) ON DELETE CASCADE,
  monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  PRIMARY KEY (window_id, monitor_id)
);
CREATE INDEX idx_maintenance_window_monitors_monitor ON maintenance_window_monitors (monitor_id);
```

- `all_monitors = 1` ⇔ `monitorIds: "all"`. It also covers monitors created **after** the
  window. In that case there are no join rows.
- If a listed monitor is deleted, its join row cascades away. A window with `all_monitors = 0`
  and no join rows would break the response schema (`monitorIds` needs at least one id), so
  **`MonitorRepository.delete` MUST also delete every maintenance window left without monitors,
  in the same transaction.**
- `created_by`: a session → `created_by_user_id = request.auth.userId`. An API key →
  `created_by_api_key_id = request.auth.keyId`. The response is `createdBy: { kind: 'user' |
  'apiKey', id }`, or `null` once the user row is deleted (account recovery). API keys are
  soft-deleted, so their ids remain.
- The comparison `ends_at > starts_at` is lexicographic on ISO `Z` strings, which is correct
  because the API always stores `toISOString()` output.

### 3.3 `MaintenanceRepository` (`apps/api/src/maintenance/repository.ts`)

- `list() → MaintenanceWindowRow[]`, ordered by `starts_at DESC, rowid DESC`. `get(id)`.
  `create(input, createdBy)`. `update(id, merged)` (replaces the join rows in one transaction and
  sets `updated_at`). `delete(id) → boolean`.
- `listRelevant(at: string) → target[]`: windows with `starts_at <= at AND ends_at > at` (index
  range), mapped to the shared `MaintenanceTarget` shape (`monitorIds: 'all' | uuid[]`). This is
  the input to `activeWindowFor`.
- `listOverlapping(from, to)`: windows with `starts_at < to AND ends_at > from`. Used by the
  status page.
- A route-level `toResponse(row, now)` adds `active = isWindowActive(row, now)` and
  `nextOccurrence = nextOccurrence(row, now)`.

### 3.4 Routes (`apps/api/src/maintenance/routes.ts`)

Normal protection applies (session + CSRF, or API key; `read` keys get `GET` only).

| Method | Path | Request | Responses |
| --- | --- | --- | --- |
| `GET` | `/api/v1/maintenance` | — | `200 { data: MaintenanceWindow[] }`, ordered `startsAt` desc. No pagination. |
| `POST` | `/api/v1/maintenance` | `MaintenanceWindowCreate` | `201 { data: MaintenanceWindow }` + `Location: /api/v1/maintenance/:id`; `400` validation |
| `GET` | `/api/v1/maintenance/:id` | — | `200 { data }`; `404` unknown or non-UUID id |
| `PATCH` | `/api/v1/maintenance/:id` | `MaintenanceWindowUpdate` | `200 { data }`; `404`; `400` (body, or the merged window failing `MaintenanceWindowCreateSchema`) |
| `DELETE` | `/api/v1/maintenance/:id` | — | `204` (hard delete; suppression ends immediately); `404` |

- **Unknown monitor ids** → `400 VALIDATION_ERROR` with issue `{ path: ['monitorIds', <index>],
  code: 'custom', message: 'monitor not found' }`, the same convention as channels. Duplicates
  are removed (keeping the first occurrence) before storing.
- Changing a window takes effect at the **next check**. Nothing is re-evaluated retroactively:
  incidents that already opened stay open, and suppressed events are not replayed.
- Example:

```http
POST /api/v1/maintenance
{ "title": "Nightly backup", "monitorIds": "all",
  "startsAt": "2026-10-13T00:00:00.000Z", "endsAt": "2027-10-13T00:00:00.000Z",
  "repeat": { "weekdays": [0, 6], "startTime": "23:30", "durationMinutes": 90 } }

201 { "data": { "id": "…", "title": "Nightly backup", "monitorIds": "all",
  "startsAt": "2026-10-13T00:00:00.000Z", "endsAt": "2027-10-13T00:00:00.000Z",
  "repeat": { "weekdays": [0, 6], "startTime": "23:30", "durationMinutes": 90 },
  "createdBy": { "kind": "user", "id": "…" }, "createdAt": "…", "updatedAt": "…",
  "active": false, "nextOccurrence": { "startsAt": "2026-10-17T23:30:00.000Z",
  "endsAt": "2026-10-18T01:00:00.000Z" } } }
```

### 3.5 Suppression semantics (`ResultRepository.record`)

`ResultRepository` gets a way to read active windows. The RECOMMENDED way is to pass
`MaintenanceRepository` (or a `(monitorId, at) => ActiveMaintenance | null` function) to the
constructor. Inside the **existing transaction**, after loading the monitor, compute `maintenance
= activeWindowFor(monitorId, repo.listRelevant(outcome.checkedAt), new Date(outcome.checkedAt))`.

| Aspect | Behaviour when `maintenance !== null` |
| --- | --- |
| Check result row, `daily_uptime` | Recorded exactly as today. Uptime is **not** adjusted. |
| `consecutive_failures`, `monitors.status`, `last_checked_at` | Updated exactly as today. Stored status stays truthful (`down` is possible). |
| `status === 'down'` and no open incident | **No incident is opened.** No event. |
| `status === 'up'` and an incident is open (it opened before the window) | The incident is **resolved** in the DB as usual (`resolved_at = checkedAt`, true duration). The `incident.resolved` event is **suppressed**. |
| Incident already open when the window starts, still failing | It stays open, untouched. Nothing is emitted. |
| Return value | `event: null`. `RecordResult` gains `maintenance: ActiveMaintenance \| null` and `suppressed: 'incident.opened' \| 'incident.resolved' \| null` (the event that would have been emitted). |

**After the window**, normal rules apply to the next check. A monitor that failed throughout the
window already has `consecutive_failures ≥ 3` and `status = 'down'`. Its **first failing check
after `endsAt` opens the incident immediately**, with `started_at = that checkedAt` and `cause =
that error`. The incident is not backdated, and the `incident.opened` webhook is enqueued. A
monitor that recovered during the window is `up` and needs no action.

`app.ts`'s `record` callback keeps `if (recorded?.event) notifier.enqueue(...)`. When
`recorded.suppressed` is set, it logs at `info`: `{ monitorId, windowId, event }` `"notification
suppressed by maintenance window"`. Events enqueued **before** a window started are still
delivered, including retries: suppression applies when the event is created, not when it is
delivered. Channel **test** sends (`POST /api/v1/channels/:id/test`) are never suppressed.

### 3.6 Display: monitors, status page, badges

Every display path evaluates at **request time** (`new Date()`), using `activeWindowFor` over
`listRelevant(now)`. The query runs once per request, and the pure function runs per monitor.

- **`GET /api/v1/monitors`, `GET /api/v1/monitors/:id`, `POST`, `PATCH`** responses include
  `maintenance: ActiveMaintenance | null`. `status` stays the **stored** status, and the web
  derives the badge. `PATCH` validation (`MonitorSchema.safeParse({...existing, ...patch})`)
  keeps working because the field is in the schema.
- **`GET /api/v1/status`** (`buildStatusPage`):
  - Each public monitor: `status = publicMonitorStatus({ enabled, status }, maintenance !==
    null)` and `maintenance`. For paused monitors, `maintenance` is still reported, but `status`
    is `paused`.
  - `overall = overallStatus(monitors)` (new rules, §3.1.2).
  - `upcomingMaintenance`: `upcomingOccurrences(listOverlapping(now, now + 7 d), now, now + 7
    d, 20)`, mapped to `PublicMaintenance`. `monitors` holds only **public** affected monitors,
    in status page order. `allMonitors` = `monitorIds === 'all'`. Windows that affect **no public
    monitor** are omitted (titles of private-only work never leak). Titles of windows that touch
    a public monitor **are public**, and the docs and the dialog say so.
- **`GET /status` (HTML)**:
  - The monitor row gets `data-status="maintenance"`, the label **Maintenance**, and the window
    title: `<span class="maintenance">Maintenance: <title> (until <time datetime>HH:MM
    UTC</time>)</span>`. The title is escaped.
  - The overall banner label for `maintenance` is **Scheduled maintenance in progress**.
  - A new section `<section id="maintenance"><h2>Upcoming maintenance</h2>` sits after the
    banner and before the monitors. It lists entries as `<li data-maintenance-id>` with the
    title, `startsAt–endsAt` in UTC (`YYYY-MM-DD HH:MM UTC`), **In progress** when `active`, and
    "All services" or the monitor names. When there are none: `<p>No maintenance scheduled.</p>`.
  - Blue (`#007ec6`) is used for maintenance. The CSP is unchanged (inline style only).
- **Badges:** `type=status` → right text `maintenance` with colour `#007ec6` when
  `publicMonitorStatus(...) === 'maintenance'`. The status colour map comes from
  `STATUS_BADGE_COLORS`. `type=uptime` is **unchanged** (it is a number). Paused still beats
  maintenance.

### 3.7 Metrics (`apps/api/src/metrics/`)

**Endpoint.** `GET /metrics` (Fastify also answers `HEAD`) → `200`, `Content-Type:
METRICS_CONTENT_TYPE`, `Cache-Control: no-store`, and the body from `renderPrometheus`.

**Access.**

| Credential | Result |
| --- | --- |
| none, `PULSE_METRICS_PUBLIC` unset/`false` | `401 UNAUTHORIZED` JSON + `WWW-Authenticate: Bearer realm="pulse"` |
| `Authorization: Bearer <read key>` or `<write key>` | `200`. Write implies read. |
| invalid, unknown or revoked bearer | `401` |
| session cookie | `200` (a `GET` needs no CSRF) |
| anything, with `PULSE_METRICS_PUBLIC=true` | `200` |

Implementation: the auth hook's path guard becomes `path.startsWith('/api/v1/') || path ===
'/metrics'`, so `/metrics` gets the same bearer/cookie/scope logic. The route is registered with
`config: { public: metricsPublic }`. No second auth implementation is added, and route modules
still have no allow-lists. When the endpoint is public, a supplied `Authorization` header is not
validated (as for `/api/v1/status`). The iteration-4 route-sweep test keeps passing:
unauthenticated `/metrics` → `401` by default.

**Config.** `PULSE_METRICS_PUBLIC`: `true` | `false`, default `false`. It is parsed in
`config.ts` as `z.enum(['true', 'false']).default('false')`, mapped to `Config.metricsPublic:
boolean`, and passed as `buildApp({ metricsPublic })`. Any other value is a config error.
`server.ts` logs a `warn` when it is `true`: "metrics are public and include every monitor's name".

**Families** (in this order):

| Metric | Type | Labels | Source and semantics |
| --- | --- | --- | --- |
| `pulse_monitor_up` | gauge | `monitor` (name), `id` (uuid) | **DB at scrape.** One sample per **enabled, non-pending** monitor: `1` if stored status is `up`, `0` if `degraded` or `down`. It shows the raw truth, even in maintenance. |
| `pulse_check_duration_seconds` | histogram | — | **In-memory.** `latencyMs / 1000` of every check recorded by `record()` (ok and failed; stale config-version results that `record` drops are not counted). Buckets `CHECK_DURATION_BUCKETS`. |
| `pulse_checks_total` | counter | `result` = `ok` \| `fail` | **In-memory.** Checks recorded since the process started, split on `outcome.ok`. Both label values are emitted from start (`0`). |
| `pulse_open_incidents` | gauge | — | **DB at scrape.** `SELECT count(*) FROM incidents WHERE status='open'`. |
| `pulse_maintenance_active` | gauge | `monitor`, `id` | **DB + evaluator at scrape.** One sample per monitor (all monitors, including paused): `1` if `activeWindowFor(id, …, now)` is non-null, else `0`. |

- Counters and the histogram live in a `MetricsRegistry` owned by `buildApp`. They reset on
  restart, which Prometheus handles natively (`rate()`/`increase()`). They are fed from the
  scheduler's `record` callback in `app.ts`, after `results.record` returns a non-undefined result.
- Gauges are read from SQLite on each scrape. There is one query for monitors, one for the open
  count, and one `listRelevant(now)`.
- Label values are escaped with `escapeLabelValue`. Monitor names may contain `"`, `\` and
  newlines (tested).
- Alerting recipe for the docs: `pulse_monitor_up == 0 unless on(id) pulse_maintenance_active ==
  1`.

### 3.8 Wiring (`app.ts`, `server.ts`, `config.ts`)

- `buildApp` gains `metricsPublic?: boolean` (default `false`). It constructs
  `MaintenanceRepository` before `ResultRepository` and passes it in, constructs
  `MetricsRegistry`, and registers `maintenanceRoutes(app, maintenance, monitors)` and
  `metricsRoutes(app, db, maintenance, registry, { public })`.
- `statusRoutes` and `badgeRoutes` receive the maintenance repository.
- No new runtime dependency. The Prometheus format is rendered by `@pulse/shared`.

### 3.9 Docs

- `docs/operations.md`:
  - The configuration table gains the row `` | `PULSE_METRICS_PUBLIC` | `false` | … | ``. The
    operations-docs test requires every `PULSE_*` name in source to have a row, and every row to
    be used.
  - A new **Metrics** section covers the endpoint, auth (a read key is recommended for
    Prometheus), what each metric means, the counters-reset-on-restart note, a public-mode
    warning, the alerting recipe, and a scrape config:

```yaml
scrape_configs:
  - job_name: pulse
    metrics_path: /metrics
    scheme: https
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/pulse-read-key   # a Pulse API key with scope "read"
    static_configs:
      - targets: ['status.example.com']
```

  - A short **Maintenance windows** note: UTC only, weekly repeat semantics, titles are public
    when a public monitor is affected, and checks still count toward uptime.
- README: update the status line to Iteration 5. Add the maintenance and metrics endpoints to
  the API table, add the feature bullets, and add docs links (this spec, ADR 0008).

## 4. UI changes (`@pulse/web`)

The patterns are unchanged: Tailwind slate/blue, an injected `client`, a `loading | ready |
error` state machine, `role="alert"` errors with **Retry**, and inline confirmation.

### 4.1 API client

New methods: `listMaintenance()`, `createMaintenance(input: MaintenanceWindowCreateInput)`,
`updateMaintenance(id, patch: MaintenanceWindowUpdate)` and `deleteMaintenance(id)`. Types are
re-exported from `@pulse/shared` via `src/api/types.ts`. The `Monitor` type now carries
`maintenance?: ActiveMaintenance | null`.

### 4.2 Route and nav

`useHashRoute` gains `{ name: 'maintenance' }` for `#/maintenance`. `NAV` gains
**Maintenance** (`#/maintenance`) between **Channels** and **API keys**.

### 4.3 `MaintenanceView` (`src/components/MaintenanceView.tsx`)

- Loads `listMaintenance()` and `listMonitors()` (for names and the multi-select). States:
  `Loading…` (`role="status"`), an error alert with **Retry**, and an empty state ("No maintenance
  windows yet."), plus a **Schedule maintenance** button.
- The table has columns **Title**, **Monitors** ("All monitors" or a comma list of names,
  "Unknown monitor" for missing ids), **Schedule** (one-off: `start – end UTC`; weekly: e.g.
  "Sat, Sun 23:30 UTC for 1 h 30 min · until 2027-10-13"), and **Status** (**Active** blue pill
  when `active`, else "Next: <nextOccurrence.startsAt UTC>" or **Ended**). Each row has **Edit**
  and **Delete** actions.
- **Delete:** inline confirm ("Delete <title>? Alerts for its monitors resume immediately." with
  **Delete window** / **Cancel**). While deleting, the button shows **Deleting…**. On success the
  row is removed. On error, an alert appears and the row stays.

### 4.4 `MaintenanceDialog` (create and edit)

- A modal `role="dialog"` with `aria-modal="true"` and `aria-labelledby` pointing at the heading
  (**Schedule maintenance** / **Edit maintenance**). Focus moves into the dialog on open. `Esc`
  and **Cancel** close it.
- Fields:
  - **Title** (required, max 120), with a hint: "Shown on the public status page if a public
    monitor is affected."
  - **Monitors**: an **All monitors** checkbox. When it is unchecked, a checkbox list of
    monitors (a multi-select with a `fieldset`/`legend`) is shown, and at least one is required.
  - **Starts** / **Ends**: date + time inputs, **interpreted as UTC** and labelled "(UTC)".
  - **Repeat weekly** checkbox. When checked, it reveals weekday checkboxes (Sun … Sat, at least
    one), **Start time (UTC)** `HH:MM`, and **Duration** (hours + minutes, total 1 min–7 days).
    In weekly mode, Starts/Ends are labelled "Repeat from" / "Repeat until".
- Submit: **Create** / **Save**. While submitting, it shows **Saving…** with disabled controls.
  `400` issues map to fields by `path[0]` (`title`, `monitorIds`, `startsAt`, `endsAt`,
  `repeat`), with `aria-invalid` and the message under the field. Other errors appear in an
  alert inside the dialog. On success, the dialog closes and the list updates (prepend on
  create, replace on edit).
- Edit sends only changed fields (`PATCH`). Switching off **Repeat weekly** sends `repeat: null`.

### 4.5 Maintenance badge

- `StatusBadge` gains an optional `maintenance?: ActiveMaintenance | null` prop. When `enabled`
  and `maintenance` are set, it renders **Maintenance** (`bg-blue-100 text-blue-900`) with
  `title="<window title> · until HH:MM UTC"`. Paused still wins. `MonitorList` rows and the
  `MonitorDetail` header pass `monitor.maintenance`.
- The web MAY reuse `publicMonitorStatus` from `@pulse/shared` to pick the variant.

## 5. Work breakdown

File ownership is exclusive per task, to avoid merge conflicts.

| # | Task | Owner | Files | Depends on |
| --- | --- | --- | --- | --- |
| A0 | Shared contract + tests (**done**) | architect | `packages/shared/src/{maintenance,metrics,status-page,monitor,badge,index}.ts`, `packages/shared/test/{maintenance,metrics}.test.ts` | — |
| B1 | Migration 006 + `MaintenanceRepository` + migrate test; delete empty windows when a monitor is deleted | backend | `apps/api/migrations/006_maintenance.sql`, `apps/api/src/maintenance/repository.ts`, `apps/api/src/monitors/repository.ts` (delete), `apps/api/test/migrate.test.ts`, `apps/api/test/maintenance-repository.test.ts` | A0 |
| B2 | Maintenance routes (CRUD, created_by, unknown ids, merged PATCH validation, read-key 403) | backend | `apps/api/src/maintenance/routes.ts`, `apps/api/test/maintenance-routes.test.ts` | B1 |
| B3 | Suppression in `record()` + `suppressed` logging in `app.ts` | backend | `apps/api/src/results/repository.ts`, `apps/api/src/app.ts` (record callback), `apps/api/test/maintenance-suppression.test.ts` | B1 |
| B4 | `maintenance` on monitor responses; status page JSON/HTML; badges | backend | `apps/api/src/monitors/routes.ts`, `apps/api/src/status/*.ts`, `apps/api/src/badges/routes.ts`, `apps/api/test/maintenance-display.test.ts` | B1 |
| B5 | Metrics: `MetricsRegistry`, `/metrics` route, auth hook path, `PULSE_METRICS_PUBLIC` config + server warning | backend | `apps/api/src/metrics/*.ts`, `apps/api/src/auth/plugin.ts`, `apps/api/src/config.ts`, `apps/api/src/server.ts`, `apps/api/src/app.ts` (wiring), `apps/api/test/metrics.test.ts`, `apps/api/test/config.test.ts` | A0 |
| B6 | Docs: `operations.md` (env row, Metrics, Maintenance), README | backend | `docs/operations.md`, `README.md`, `apps/api/test/documentation.test.ts` (if assertions are added) | B5 |
| F1 | Client methods + types + route/nav | frontend | `apps/web/src/api/*`, `apps/web/src/hooks/useHashRoute*.ts`, `apps/web/src/App.tsx`, `App.test.tsx` | A0 (can mock) |
| F2 | `MaintenanceView` + `MaintenanceDialog` + tests | frontend | `apps/web/src/components/Maintenance*.tsx` (+ `.test.tsx`) | F1 |
| F3 | Maintenance badge on rows and detail | frontend | `apps/web/src/components/StatusBadge.tsx`, `MonitorList.tsx`, `MonitorDetail.tsx` (+ tests) | F1 |
| Q1 | QA: cross-check AC 1–6 end to end with `inject` + fake clock; add missing cases | qa | new test files only, e.g. `apps/api/test/iteration5-acceptance.test.ts` | B2–B5 |

B3 and B5 both touch `app.ts`. B3 owns the `record` callback body, and B5 owns construction and
registration. They should merge in order B3 → B5, or B5 adds the metrics observation to the
callback after B3 lands.

Suggested commits: `feat(shared): maintenance window and metrics contract`, `feat(api):
maintenance windows table and repository`, `feat(api): maintenance window routes`, `feat(api):
suppress incidents and notifications during maintenance`, `feat(api): show maintenance on status
page, badges and monitors`, `feat(api): prometheus metrics endpoint`, `docs: metrics and
maintenance operations`, `feat(web): maintenance page`, `feat(web): maintenance badge on
monitors`.

## 6. Acceptance criteria

Suppression

1. With a fake clock and a fake `runCheck`, for a monitor with a webhook channel and a window
   `[T, T + 30 min)`: failing checks inside the window drive `status` to `down` and are recorded
   (`check_results` rows, `daily_uptime` counts). **No incident row** is created, **no delivery
   attempt** is made, the `fetch` stub is not called, and `record()` returns `event: null,
   suppressed: 'incident.opened'`. The same failing check at `T + 31 min` (one minute after the
   window ends) **opens an incident** with `started_at = T + 31 min`, and the webhook is sent with
   `incident.opened`. An incident open before `T` stays open during the window. A recovering
   check inside the window resolves it with **no** webhook, and an `up` check outside any window
   still sends `incident.resolved`.
2. Weekly windows are evaluated in UTC (`TZ` set to a non-UTC zone in the test process makes no
   difference). They handle an occurrence crossing midnight (Tue 23:00 + 120 min active at Wed
   00:30, inactive at Mon 23:30) and Sat→Sun (Sat 22:00 + 240 min active at Sun 01:59, inactive
   at Sun 02:00). Series bounds clip occurrences. One-off windows are half-open. Covered in
   `packages/shared/test/maintenance.test.ts`, plus at least one API-level suppression test with
   a midnight-crossing weekly window.

Metrics

3. `GET /metrics` without credentials → `401` (`WWW-Authenticate` set). With a **read** key →
   `200`. With a write key → `200`. With a revoked key → `401`. With a session → `200`. With
   `metricsPublic: true` and no credentials → `200`. The `Content-Type` is
   `text/plain; version=0.0.4; charset=utf-8`. The body **parses** with a small line parser in
   the test: every non-comment line matches
   `^[a-zA-Z_:][a-zA-Z0-9_:]*(\{(?:[a-zA-Z_][a-zA-Z0-9_]*="(?:[^"\\\n]|\\["\\n])*",?)*\})? (NaN|[+-]Inf|-?[0-9.eE+-]+)$`,
   each family has one `# HELP` and one `# TYPE` before its samples, and histogram buckets are
   cumulative and end with `le="+Inf"` = `_count`. After 3 recorded checks (2 ok with 120 ms and
   80 ms, 1 failed), `pulse_checks_total{result="ok"} 2`, `{result="fail"} 1`,
   `pulse_check_duration_seconds_count 3`, and `_bucket{le="0.1"}` counts 1. With a down monitor
   in an active window, `pulse_monitor_up{…} 0` and `pulse_maintenance_active{…} 1`. A monitor
   named `a"b\c` with a newline is escaped correctly. `pulse_open_incidents` equals the open
   count.

Display

4. During a window, for an affected public monitor whose stored status is `down`:
   `GET /api/v1/status` → `status: 'maintenance'` and `maintenance.title` is set. `overall`
   ignores it. If it is the only enabled public monitor, `overall` is `'maintenance'`.
   `upcomingMaintenance` lists the window (`active: true`), and windows affecting only private
   monitors are absent. `/status` HTML has `data-status="maintenance"`, the escaped title and the
   **Upcoming maintenance** section. `/badge/<id>.svg?type=status` contains `maintenance` and
   `#007ec6`. After the window, all three show `down`. A paused monitor shows `paused`.
   `GET /api/v1/monitors` includes `maintenance` (non-null during, `null` after).

API

5. Maintenance CRUD: `POST` → `201` + `Location`, and validates against
   `MaintenanceWindowSchema`, with `createdBy.kind` = `user` (session) or `apiKey` (write key).
   A read key `POST` → `403`. Unknown monitor id → `400` at `['monitorIds', i]`. `endsAt ≤
   startsAt`, a one-off longer than 7 days, a bad `startTime`, empty `weekdays` and unknown fields
   → `400`. `PATCH` that only moves `endsAt` before the stored `startsAt` → `400`. `PATCH {
   repeat: null }` clears the repeat. `DELETE` → `204`, then `404`. Non-UUID id → `404`.
   Deleting a monitor removes a window that targeted only it. Every route without credentials →
   `401` (route sweep).

Web

6. `MaintenanceView`: loading, empty and error + Retry states. Create opens the dialog. Submit
   shows **Saving…** with disabled controls. A `400` at `['endsAt']` shows under **Ends** with
   `aria-invalid`. Success closes the dialog and shows the row. Weekly repeat sends `{ weekdays,
   startTime, durationMinutes }` built from the inputs. **All monitors** sends `monitorIds:
   'all'`. Edit pre-fills the fields and sends a `PATCH` with only the changed fields. Delete
   needs confirmation, shows **Deleting…** and removes the row. A delete error keeps the row and
   shows an alert. `#/maintenance` renders the view with `aria-current="page"`. `StatusBadge` and
   `MonitorList` show **Maintenance** (with the window title in `title`) when
   `monitor.maintenance` is set and the monitor is enabled.

Workspace

7. `pnpm lint`, `pnpm format:check`, `pnpm -r test` and `pnpm -r build` pass. The
   operations-docs test passes with the `PULSE_METRICS_PUBLIC` row. No new runtime dependency.
   No test makes a real outbound request.

## 7. Test plan

| Package | Tests (file → criteria) |
| --- | --- |
| shared | `test/maintenance.test.ts` (AC 2: UTC, midnight, Sat→Sun, 7-day occurrence, clipping, one-off, `activeWindowFor` tie-break, `upcomingOccurrences`, schemas, display status, overall rules, backward-compatible payloads). `test/metrics.test.ts` (escaping, rendering, histogram). |
| api | `test/migrate.test.ts` (006 on a v5 DB). `test/maintenance-repository.test.ts`. `test/maintenance-routes.test.ts` (AC 5). `test/maintenance-suppression.test.ts` (AC 1, fake timers + fake `runCheck` + stubbed `fetch`, or `ResultRepository.record` directly with explicit `checkedAt`). `test/maintenance-display.test.ts` (AC 4). `test/metrics.test.ts` (AC 3, includes the exposition line parser). `test/config.test.ts` (`PULSE_METRICS_PUBLIC` values). `operations-docs.test.ts` unchanged and passing. |
| web | `client.test.ts` (new methods: URLs, methods, bodies). `MaintenanceView.test.tsx` + `MaintenanceDialog.test.tsx` (AC 6, deferred promises for loading states). `StatusBadge.test.tsx` / `MonitorList.test.tsx` (badge). `useHashRoute.test.ts` + `App.test.tsx` (route + nav). The fake clients in existing tests gain the new methods. |

Prefer calling `ResultRepository.record(monitorId, { …, checkedAt })` directly for
boundary-precise suppression tests. Use the scheduler path with `vi.useFakeTimers()` once for the
end-to-end webhook assertion.
