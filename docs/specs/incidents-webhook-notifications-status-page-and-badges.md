# Pulse — Iteration 3: Incidents, webhook notifications, status page and badges

- **Status:** Ready for implementation
- **Date:** 2026-10-11
- **Builds on:** [Iteration 1 spec](iteration-1.md) (conventions in §4.4 there still apply),
  [Iteration 2 spec](check-scheduler-and-ssrf-safe-checker.md)
- **Decisions:** [ADR 0004 – Incidents and notification delivery](../adr/0004-incidents-and-notification-delivery.md),
  [ADR 0005 – Public status page and badges](../adr/0005-public-status-page-and-badges.md)

Normative words: **MUST**, **SHOULD**, **MAY** (RFC 2119). Anything not specified here is the
implementer's choice, provided all acceptance criteria (§6) pass.

## 1. Summary

Status changes become incidents that people can follow and that Pulse publishes:

- When a monitor reaches `down`, Pulse opens an **incident** (with the last error as its cause).
  When the monitor is `up` again, Pulse resolves it and records its duration. A monitor has at
  most one open incident, and `degraded` never opens one.
- Operators define **notification channels** (generic webhook or Slack incoming webhook) and
  subscribe monitors to them. When an incident opens or resolves, Pulse POSTs JSON to every
  subscribed, enabled channel. It retries up to 3 attempts with backoff, never blocks the
  scheduler, records every attempt (last 20 per channel), and applies the existing SSRF egress
  policy to every outbound request.
- A **public status page**: `GET /status` is server-rendered HTML that works without JavaScript,
  and `GET /api/v1/status` is the same data as JSON. It shows overall status, the monitors marked
  `public` with 90 daily uptime bars, and open and recent incidents.
- **Badges:** `GET /badge/:monitorId.svg` returns a shields-style SVG with either 24 h uptime or
  the current status.
- The web app gets an **Incidents** view, **Channels** settings (CRUD + "Send test"), and on the
  monitor detail a **Public** toggle and a Markdown badge snippet.

## 2. Scope

**In scope**

| Package | Work |
| --- | --- |
| `@pulse/shared` | `public` on monitors; incident, channel, delivery, status-page and badge schemas; payload/format helpers (§3.1). |
| `@pulse/checker` | Extract the resolve → validate → pin flow into a reusable module; new `postJson()` and `validateOutboundUrl()` (§3.2). |
| `@pulse/api` | Migration `003`; incident logic in `ResultRepository.record`; daily rollup; channel/subscription/delivery repositories; `Notifier`; routes for channels, incidents, status (HTML + JSON) and badges; wiring and shutdown (§3.3–§3.10). |
| `@pulse/web` | Navigation, `IncidentsView`, `ChannelsView` + `ChannelForm`, `PublicToggle` + `BadgeSnippet` on `MonitorDetail`, client methods, dev proxy (§4). |
| Docs | README (API table, status page, badges, notifications, security notes, status line), this spec, ADRs 0004/0005. |

**Out of scope** (later iterations)

- Authentication (iteration 4). Channel URLs, which can contain tokens, are readable through the
  API. The README must say so.
- Email, PagerDuty, Discord-native, and other channel kinds. HMAC payload signing. Custom headers.
- Notifications for `degraded`, reminder or escalation notifications, maintenance windows, and
  manual incidents, updates or post-mortems (incident text is generated only).
- Durable retry across restarts (pending retries are dropped on shutdown, see ADR 0004).
- Retention or pruning of `check_results` (the daily rollup makes it possible later).
- Status page branding (title, logo, custom domain), per-page grouping, subscriptions on the
  public page, and RSS/Atom feeds.
- Live updates in the web app (the user reloads). Playwright e2e.
- A delivery-history UI (the API exists, §3.5).

## 3. API and data changes

Conventions from iteration-1 §4.4 apply: `{ data }` envelopes, `{ error: { code, message,
issues? } }`, `404 NOT_FOUND` for unknown **or non-UUID** ids, `415` for non-JSON bodies, `400
VALIDATION_ERROR` with zod `issues`, and "404 wins over 400/415". All timestamps are ISO-8601
UTC strings with `Z` (`Date#toISOString()`), so `substr(ts, 1, 10)` is the UTC day.

### 3.1 `@pulse/shared`

`@pulse/shared` still MUST NOT import Node built-ins. New files are re-exported from `index.ts`.

#### 3.1.1 `monitor.ts` changes

| Schema | Change |
| --- | --- |
| `MonitorSchema` | Add `public: z.boolean()`. |
| `MonitorCreateSchema` | Add `public: z.boolean().default(false)`. |
| `MonitorUpdateSchema` | Add `public: z.boolean().optional()`. |
| `MONITOR_DEFAULTS` | Add `public: false`. |

Changing only `public` MUST NOT reset monitor status (add it to the iteration-2 §3.4 "keeps
status" list). The scheduler does not care about `public`.

#### 3.1.2 `incident.ts`

```ts
export const INCIDENT_STATUSES = ['open', 'resolved'] as const;
export const IncidentStatusSchema = z.enum(INCIDENT_STATUSES);

export const IncidentSchema = z.object({
  id: z.uuid(),
  monitorId: z.uuid(),
  monitorName: z.string(),               // joined from monitors at read time
  status: IncidentStatusSchema,
  cause: z.string().nullable(),          // error of the result that confirmed `down`
  startedAt: z.iso.datetime(),
  resolvedAt: z.iso.datetime().nullable(),       // null iff status = 'open'
  durationSeconds: z.number().int().min(0).nullable(), // null iff status = 'open'
}).strict();

export const INCIDENTS_LIMITS = { default: 50, min: 1, max: 200 } as const;
export const IncidentsQuerySchema = z.object({
  status: z.enum(['open', 'resolved', 'all']).default('all'),
  monitorId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
}); // not strict: unknown query params are ignored

export type Incident = z.infer<typeof IncidentSchema>;
export type IncidentStatus = z.infer<typeof IncidentStatusSchema>;
export type IncidentsQuery = z.infer<typeof IncidentsQuerySchema>;
```

#### 3.1.3 `channel.ts`

```ts
export const CHANNEL_KINDS = ['webhook', 'slack'] as const;
export const ChannelKindSchema = z.enum(CHANNEL_KINDS);
export const CHANNEL_LIMITS = { nameMaxLength: 100, urlMaxLength: 2048, maxMonitors: 500 } as const;

const fields = {
  name: z.string().trim().min(1).max(100),
  kind: ChannelKindSchema,
  url: /* same http(s) URL rule as MonitorSchema.url, max 2048 */,
  enabled: z.boolean(),
  monitorIds: z.array(z.uuid()).max(500),   // subscribed monitors; duplicates removed by the API
};

export const ChannelSchema = z.object({
  id: z.uuid(), ...fields, createdAt: z.iso.datetime(),
}).strict();
export const ChannelCreateSchema = z.object({
  name: fields.name, kind: fields.kind, url: fields.url,
  enabled: fields.enabled.default(true),
  monitorIds: fields.monitorIds.default([]),
}).strict();
export const ChannelUpdateSchema = z.object({
  name: fields.name.optional(), kind: fields.kind.optional(), url: fields.url.optional(),
  enabled: fields.enabled.optional(),
  monitorIds: fields.monitorIds.optional(),   // replaces the whole set
}).strict().refine((v) => Object.keys(v).length > 0, { message: 'at least one field is required', path: [] });

export const NOTIFICATION_EVENTS = ['incident.opened', 'incident.resolved', 'test'] as const;
export const NotificationEventSchema = z.enum(NOTIFICATION_EVENTS);
export const MAX_DELIVERY_ATTEMPTS = 3;
export const DELIVERY_RETRY_DELAYS_MS = [2_000, 10_000] as const; // before attempt 2 and 3
export const DELIVERY_TIMEOUT_MS = 10_000;
export const DELIVERY_HISTORY_PER_CHANNEL = 20;

export const DeliveryAttemptSchema = z.object({
  id: z.uuid(),
  channelId: z.uuid(),
  incidentId: z.uuid().nullable(),      // null for 'test' (or after the incident was deleted)
  event: NotificationEventSchema,
  attempt: z.number().int().min(1).max(3),
  attemptedAt: z.iso.datetime(),
  ok: z.boolean(),
  statusCode: z.number().int().nullable(),
  latencyMs: z.number().int().min(0),
  error: z.string().nullable(),          // null iff ok; truncated to 500 chars
}).strict();

export type Channel, ChannelKind, ChannelCreateInput (z.input), ChannelCreate (z.output),
  ChannelUpdate, NotificationEvent, DeliveryAttempt
```

#### 3.1.4 `notification-payload.ts` (pure, shared so tests and docs use one source)

```ts
export type WebhookPayload = {
  event: NotificationEvent;
  sentAt: string;                                  // ISO, time the payload was built
  channel: { id: string; name: string };
  monitor: { id: string; name: string; url: string; status: MonitorStatus } | null; // null for 'test'
  incident: Incident | null;                       // null for 'test'
};
export type SlackPayload = { text: string };

export function buildWebhookPayload(input: {...}): WebhookPayload;
export function buildSlackPayload(input: {...}): SlackPayload;
export function formatDuration(seconds: number): string; // also used by the web app and the status page
```

`formatDuration`: `0–59` → `"{s}s"`; `< 3600` → `"{m}m {s}s"`; `< 86400` → `"{h}h {m}m"`;
otherwise `"{d}d {h}h"` (zero-valued second parts are dropped: `3600` → `"1h"`, `120` → `"2m"`).

Slack `text`, exact formats (`{…}` are Slack-escaped: `&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;`,
applied to every interpolated value):

| Event | `text` |
| --- | --- |
| `incident.opened` | `:red_circle: *{monitor.name}* is DOWN: {cause ?? "unknown error"}\n{monitor.url} · since {startedAt}` |
| `incident.resolved` | `:large_green_circle: *{monitor.name}* is UP again after {formatDuration(durationSeconds)}\n{monitor.url} · resolved {resolvedAt}` |
| `test` | `:wave: Test notification from Pulse for channel *{channel.name}*.` |

Webhook body: `WebhookPayload` serialised as JSON. Both kinds are sent with headers
`content-type: application/json`, `user-agent: Pulse/0.1 (+notifications)`, and for `webhook` also
`x-pulse-event: {event}`.

#### 3.1.5 `status-page.ts`

```ts
export const STATUS_PAGE_DAYS = 90;
export const RESOLVED_INCIDENTS_ON_STATUS_PAGE = 10;
export const OVERALL_STATUSES = ['operational', 'degraded', 'partial_outage', 'major_outage', 'unknown'] as const;
export const PublicMonitorStatusSchema = z.enum(['pending', 'up', 'degraded', 'down', 'paused']);

export const DailyUptimeSchema = z.object({
  date: z.iso.date(),                          // UTC day, 'YYYY-MM-DD'
  totalChecks: z.number().int().min(0),
  okChecks: z.number().int().min(0),
  uptimePercent: z.number().min(0).max(100).nullable(), // round2; null iff totalChecks = 0
}).strict();

export const PublicMonitorSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  status: PublicMonitorStatusSchema,           // 'paused' when enabled = false
  lastCheckedAt: z.iso.datetime().nullable(),
  uptime90dPercent: z.number().min(0).max(100).nullable(), // Σok / Σtotal over the 90 days, round2
  days: z.array(DailyUptimeSchema).length(90), // oldest first, last element = today (UTC)
}).strict();

export const PublicIncidentSchema = IncidentSchema.omit({ cause: true }); // never expose error text

export const StatusPageSchema = z.object({
  generatedAt: z.iso.datetime(),
  overall: z.enum(OVERALL_STATUSES),
  monitors: z.array(PublicMonitorSchema),      // public monitors, created_at ASC, rowid ASC
  incidents: z.object({
    open: z.array(PublicIncidentSchema),       // startedAt DESC
    resolved: z.array(PublicIncidentSchema).max(10), // resolvedAt DESC
  }).strict(),
}).strict();

export type UptimeLevel = 'none' | 'good' | 'warn' | 'bad';
export function uptimeLevel(percent: number | null): UptimeLevel; // null → none; ≥ 99 → good; ≥ 95 → warn; else bad
export function overallStatus(monitors: Pick<PublicMonitor, 'status'>[]): OverallStatus;
```

`overallStatus` considers monitors whose status is not `paused`:

1. None of them, or all `pending` → `unknown`.
2. Any `down`: if every non-`pending` one is `down` → `major_outage`, otherwise
   `partial_outage`.
3. Otherwise any `degraded` → `degraded`.
4. Otherwise → `operational`.

#### 3.1.6 `badge.ts`

```ts
export const BADGE_TYPES = ['uptime', 'status'] as const;
export const BadgeQuerySchema = z.object({
  type: z.enum(BADGE_TYPES).default('uptime'),
  label: z.string().min(1).max(40).optional(),   // overrides the left text
});
export function formatBadgePercent(p: number): string; // floor to 2 decimals, strip trailing zeros: 99.996 → "99.99%", 99.9 → "99.9%", 100 → "100%"
```

### 3.2 `@pulse/checker` — reusable egress policy

Rationale: ADR 0002 and ADR 0004 §3.

1. **Refactor (no behaviour change):** move the per-hop "resolve hostname within the abort
   signal, require every address to pass `isAddressAllowed`, store it in the validated map" logic
   out of `runHttpCheck` into `src/egress.ts`:

   ```ts
   export type ResolveOutcome =
     | { ok: true; addresses: ResolvedAddress[] }
     | { ok: false; reason: 'blocked'; address: string; blockReason: BlockReason }
     | { ok: false; reason: 'dns'; message: string }
     | { ok: false; reason: 'timeout' };
   export function resolveAndValidate(url: URL, opts: {
     allowPrivate: boolean; resolveHost: ResolveHost; signal?: AbortSignal;
   }): Promise<ResolveOutcome>;
   export function defaultResolveHost(host: string): Promise<ResolvedAddress[]>;
   ```

   `runHttpCheck` keeps its exact error strings (iteration-2 §3.2.4), and all existing checker
   tests MUST pass unchanged.

2. **`validateOutboundUrl`** is used when a channel is created or updated:

   ```ts
   export function validateOutboundUrl(url: string, opts: {
     allowPrivate: boolean; resolveHost?: ResolveHost; timeoutMs?: number /* default 5000 */;
   }): Promise<string | null>; // null = allowed, else a message
   ```

   Messages: `blocked address: {ip} ({reason})`, `blocked address: {host} resolves to {ip}
   ({reason})`, `dns lookup failed: {code}`, `timeout`. It never rejects.

3. **`postJson`** is used by the notifier and never rejects:

   ```ts
   export interface PostJsonOptions {
     allowPrivate: boolean;
     timeoutMs?: number;            // default 10_000, covers DNS + connect + response headers
     headers?: Record<string, string>;
     fetch?: typeof undiciFetch;    // injectable
     resolveHost?: ResolveHost;     // injectable
   }
   export interface PostOutcome { ok: boolean; statusCode: number | null; latencyMs: number; error: string | null }
   export function postJson(url: string, body: unknown, opts: PostJsonOptions): Promise<PostOutcome>;
   ```

   - It uses `resolveAndValidate`, a per-call `undici.Agent` with `createPinnedLookup`, and
     `fetch(url, { method: 'POST', redirect: 'manual', body: JSON.stringify(body), signal,
     dispatcher, headers })`. The agent is destroyed in `finally`.
   - `ok` iff the status is `200–299`. The response body is cancelled and never read or stored.
   - Error strings: blocked → the same text as `validateOutboundUrl`; `3xx` → `unexpected redirect
     (HTTP {status})`; other non-2xx → `HTTP {status}`; timeout → `timeout`; network → error
     message (as in `runHttpCheck`).

### 3.3 Incident lifecycle (`apps/api/src/results/repository.ts`)

Rationale: ADR 0004 §1. `ResultRepository.record(monitorId, outcome)` keeps its single
transaction and adds these steps after computing `status` (iteration-2 §3.4):

5. Upsert the daily rollup: `INSERT INTO daily_uptime (monitor_id, day, total_checks, ok_checks)
   VALUES (?, substr(?, 1, 10), 1, ?) ON CONFLICT (monitor_id, day) DO UPDATE SET total_checks =
   total_checks + 1, ok_checks = ok_checks + excluded.ok_checks`.
6. `open = SELECT … FROM incidents WHERE monitor_id = ? AND status = 'open'`.
7. If `status = 'down'` and there is no `open` incident: insert an incident with `id`
   = UUID, `status 'open'`, `cause = outcome.error`, `started_at = outcome.checkedAt`.
   Event: `{ type: 'incident.opened', incident }`.
8. If `status = 'up'` and there is an `open` incident: `UPDATE … SET status = 'resolved',
   resolved_at = outcome.checkedAt, duration_seconds = max(0, round((resolved − started) /
   1000))`. Event: `{ type: 'incident.resolved', incident }`.
9. Otherwise (`degraded`, or `down` with an incident already open, or `up` with none): no
   incident change, no event.

New return type:

```ts
export type IncidentEvent = { type: 'incident.opened' | 'incident.resolved'; incident: Incident; monitor: Monitor };
record(monitorId, outcome): { result: CheckResult; event: IncidentEvent | null } | undefined;
```

Consequences that implementers MUST preserve:

- Repeated `down` results never open a second incident. A partial unique index also enforces
  this (§3.4), so a buggy second insert fails the transaction instead of silently duplicating.
- Because the rule is state-based, a monitor that is already `down` when migration 003 runs gets
  its incident on its next `down` result.
- `PATCH` that resets a monitor to `pending`, or disabling it, leaves an open incident open. It
  resolves on the next `up`. Deleting a monitor deletes its incidents (`ON DELETE CASCADE`), and
  no notification is sent.

### 3.4 Database — `apps/api/migrations/003_incidents_notifications.sql`

```sql
ALTER TABLE monitors ADD COLUMN public INTEGER NOT NULL DEFAULT 0
  CHECK (public IN (0, 1));

CREATE TABLE incidents (
  id TEXT PRIMARY KEY,
  monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  cause TEXT NULL,
  started_at TEXT NOT NULL,
  resolved_at TEXT NULL,
  duration_seconds INTEGER NULL CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  CHECK (
    (status = 'open' AND resolved_at IS NULL AND duration_seconds IS NULL) OR
    (status = 'resolved' AND resolved_at IS NOT NULL AND duration_seconds IS NOT NULL)
  )
);
CREATE UNIQUE INDEX idx_incidents_one_open ON incidents (monitor_id) WHERE status = 'open';
CREATE INDEX idx_incidents_monitor_started ON incidents (monitor_id, started_at DESC);
CREATE INDEX idx_incidents_status_started ON incidents (status, started_at DESC);

CREATE TABLE notification_channels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  kind TEXT NOT NULL CHECK (kind IN ('webhook', 'slack')),
  url TEXT NOT NULL CHECK (length(url) <= 2048),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL
);

CREATE TABLE monitor_channels (
  monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL REFERENCES notification_channels(id) ON DELETE CASCADE,
  PRIMARY KEY (monitor_id, channel_id)
);
CREATE INDEX idx_monitor_channels_channel ON monitor_channels (channel_id);

CREATE TABLE delivery_attempts (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES notification_channels(id) ON DELETE CASCADE,
  incident_id TEXT NULL REFERENCES incidents(id) ON DELETE SET NULL,
  event TEXT NOT NULL CHECK (event IN ('incident.opened', 'incident.resolved', 'test')),
  attempt INTEGER NOT NULL CHECK (attempt BETWEEN 1 AND 3),
  attempted_at TEXT NOT NULL,
  ok INTEGER NOT NULL CHECK (ok IN (0, 1)),
  status_code INTEGER NULL,
  latency_ms INTEGER NOT NULL CHECK (latency_ms >= 0),
  error TEXT NULL
);
CREATE INDEX idx_delivery_attempts_channel ON delivery_attempts (channel_id, attempted_at DESC);

CREATE TABLE daily_uptime (
  monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  day TEXT NOT NULL,                       -- UTC 'YYYY-MM-DD'
  total_checks INTEGER NOT NULL CHECK (total_checks >= 0),
  ok_checks INTEGER NOT NULL CHECK (ok_checks >= 0 AND ok_checks <= total_checks),
  PRIMARY KEY (monitor_id, day)
);
INSERT INTO daily_uptime (monitor_id, day, total_checks, ok_checks)
  SELECT monitor_id, substr(checked_at, 1, 10), count(*), sum(ok)
  FROM check_results GROUP BY monitor_id, substr(checked_at, 1, 10);
```

`foreign_keys = ON` is already set in `db.ts`. The migration MUST apply on a version-2 DB that
has results (backfill test) and on an empty DB.

### 3.5 Channels API (`apps/api/src/channels/`)

Repository `ChannelRepository`: `list()`, `get(id)`, `create(channel)`, `update(id, patch)`,
`delete(id)`, `listEnabledForMonitor(monitorId)`, and `setMonitors(id, monitorIds)` (replaces
the set inside the create/update transaction). `DeliveryRepository`: `record(attempt)` (insert +
prune to the 20 newest per channel, `attempted_at DESC, rowid DESC`, one transaction) and
`listRecent(channelId)`.

| Method | Path | Body / query | Success | Errors |
| --- | --- | --- | --- | --- |
| GET | `/api/v1/channels` | — | `200 { data: Channel[] }` (`created_at ASC, rowid ASC`) | — |
| POST | `/api/v1/channels` | `ChannelCreateInput` | `201 { data: Channel }` + `Location: /api/v1/channels/{id}` | `400`, `415` |
| GET | `/api/v1/channels/:id` | — | `200 { data: Channel }` | `404` |
| PATCH | `/api/v1/channels/:id` | `ChannelUpdate` | `200 { data: Channel }` | `404`, `400`, `415` |
| DELETE | `/api/v1/channels/:id` | — | `204` (cascades subscriptions and attempts) | `404` |
| POST | `/api/v1/channels/:id/test` | none (an empty body is allowed) | `200 { data: DeliveryAttempt }`. One attempt (no retries), sent even if the channel is disabled, `event 'test'`, recorded. A failed delivery is still `200` with `ok: false`. | `404` |
| GET | `/api/v1/channels/:id/deliveries` | — | `200 { data: DeliveryAttempt[] }`, newest first, ≤ 20 | `404` |

Validation order for `POST`/`PATCH`: 404 → 415 → zod schema → **unknown monitor ids** (`400
VALIDATION_ERROR`, issue path `["monitorIds", index]`, message `monitor not found`) →
**outbound URL policy**. The URL policy runs only on create, or when `url` is in the patch:
`validateOutboundUrl(url, { allowPrivate, resolveHost })`. A non-null result → `400
VALIDATION_ERROR` with one issue `{ path: ["url"], code: "custom", message: <result> }`. Both a
DNS failure and a blocked address reject (fail closed). Duplicate `monitorIds` are collapsed.
`monitorIds` in responses is sorted by the subscribed monitor's `created_at`.

Example:

```sh
curl -X POST http://127.0.0.1:3000/api/v1/channels -H 'content-type: application/json' \
  -d '{"name":"Ops Slack","kind":"slack","url":"https://hooks.slack.com/services/T/B/X","monitorIds":["2b4e…"]}'
# 201 { "data": { "id": "…", "name": "Ops Slack", "kind": "slack", "url": "https://hooks.slack.com/services/T/B/X",
#                 "enabled": true, "monitorIds": ["2b4e…"], "createdAt": "2026-10-11T12:00:00.000Z" } }
```

### 3.6 Notifier (`apps/api/src/notifications/notifier.ts`)

Rationale: ADR 0004 §2–§5.

```ts
export interface NotifierDeps {
  listChannels(monitorId: string): Channel[];          // subscribed AND enabled, at enqueue time
  getChannel(id: string): Channel | undefined;         // re-read before each attempt
  send(channel: Channel, body: unknown): Promise<PostOutcome>; // prod: postJson(url, body, { allowPrivate, headers, fetch?, resolveHost? })
  recordAttempt(attempt: Omit<DeliveryAttempt, 'id'>): void;
  maxConcurrency?: number;                             // default 4, separate from the check cap
  retryDelaysMs?: readonly number[];                   // default DELIVERY_RETRY_DELAYS_MS
  now?: () => Date;
  log?: Pick<FastifyBaseLogger, 'debug' | 'info' | 'warn' | 'error'>;
}
export class Notifier {
  enqueue(event: IncidentEvent): void;                 // synchronous, never throws, never awaits I/O
  sendTest(channel: Channel): Promise<DeliveryAttempt>;// single attempt, recorded
  stop(): Promise<void>;                               // idempotent
  readonly pending: number;                            // queued + waiting for retry + in flight
}
```

Rules:

| Rule | Value |
| --- | --- |
| Fan-out | One delivery per channel returned by `listChannels(event.monitor.id)`. The payload (§3.1.4) is built once per channel at enqueue time. |
| Attempts | Up to `MAX_DELIVERY_ATTEMPTS` = 3 in total. Attempt *n+1* is armed with `setTimeout(retryDelaysMs[n−1])` after attempt *n* fails, so they run at t = 0, +2 s, +10 s (after each failure). |
| Success | `PostOutcome.ok`. Stop retrying. |
| No retry | Failures whose error starts with `blocked address` (the policy won't change in 10 s). They are recorded once with `attempt 1`. |
| Before each attempt | `getChannel(id)`. If the channel is missing or disabled, the delivery is dropped (debug log, nothing recorded). The current URL is used. |
| Recording | Every attempt → `recordAttempt` (prunes to 20). A `recordAttempt` that throws is logged and does not stop retries. |
| Logging | Failed attempt → `warn { channelId, event, attempt, error }`. Final failure → `error`. Success after a retry → `info`. The full URL MUST NOT be logged (it may contain tokens). Log `channelId` and the URL **origin** only. |
| Concurrency | At most `maxConcurrency` sends in flight. The rest wait FIFO. |
| Isolation | `enqueue` returns before any `send` starts (work starts on a microtask). A `send` that never resolves, or rejects, can't block `enqueue`, the scheduler or other channels. |
| `stop()` | Sets `stopped`, clears retry timers and the queue (warn with the dropped count), and awaits in-flight sends (each ≤ 10 s). `enqueue` after `stop` is a no-op. |

### 3.7 Incidents API (`apps/api/src/incidents/`)

| Method | Path | Query | Success | Errors |
| --- | --- | --- | --- | --- |
| GET | `/api/v1/incidents` | `IncidentsQuery` (`status` default `all`, optional `monitorId`, `limit` 1–200 default 50) | `200 { data: Incident[] }`. Order: **open first** (`started_at DESC`), then resolved (`resolved_at DESC`), then `rowid DESC`, limited to `limit`. | `400` (issue path `["status"]`, `["monitorId"]`, `["limit"]`) |
| GET | `/api/v1/incidents/:id` | — | `200 { data: Incident }` | `404` |

An unknown `monitorId` that is still a valid UUID → `200 { data: [] }`. `monitorName` is joined
from `monitors`.

### 3.8 Public status page

Rationale: ADR 0005. One module `apps/api/src/status/`:

- `buildStatusPage(db, now: Date): StatusPage` (pure over the DB):
  - Monitors: `WHERE public = 1`, ordered by `created_at ASC, rowid ASC`. `status` = `paused`
    when `enabled = 0`, else the stored status.
  - `days`: the 90 UTC days from `today − 89` to `today`, where `today = now.toISOString().slice(0,
    10)`. Read from `daily_uptime` with `day BETWEEN first AND today`. Missing days →
    `totalChecks 0, okChecks 0, uptimePercent null`. `uptimePercent = round2(100 × ok / total)`.
  - `uptime90dPercent` = `round2(100 × Σok / Σtotal)` over those days, or `null` when Σtotal = 0.
  - Incidents: only for public monitors. `open`: all (`started_at DESC`). `resolved`: the latest
    10 (`resolved_at DESC`). `cause` is omitted.
  - `overall = overallStatus(monitors)`.
- `renderStatusPageHtml(page: StatusPage): string` is a pure function with no I/O.

| Method | Path | Success | Headers |
| --- | --- | --- | --- |
| GET | `/api/v1/status` | `200 { data: StatusPage }` | `cache-control: public, max-age=30` |
| GET | `/status` | `200` HTML document | `content-type: text/html; charset=utf-8`, `cache-control: public, max-age=30`, `content-security-policy: default-src 'none'; style-src 'unsafe-inline'; img-src 'self'`, `x-content-type-options: nosniff` |

Both routes MUST call `buildStatusPage` once per request with the same `now`. Neither route
requires any monitor to exist. With no public monitors, the JSON has `monitors: []`, `overall
'unknown'`, and the HTML shows `No public monitors yet.`

HTML requirements (assertable in tests):

- `<!doctype html>`, `<html lang="en">`, `<meta charset="utf-8">`, `<meta name="viewport" …>`,
  `<meta http-equiv="refresh" content="60">`, `<title>Status</title>`. **No `<script>` element**
  and no `on*=` attributes. CSS is in one `<style>` element.
- Banner `<section id="overall" data-overall="{overall}">` with text: `All systems operational` /
  `Degraded performance` / `Partial outage` / `Major outage` / `No data yet`.
- One `<li data-monitor-id="{id}" data-status="{status}">` per public monitor, with the name,
  the status text (`Up`, `Degraded`, `Down`, `Pending`, `Paused`), `{uptime90dPercent}% uptime
  (90 days)` or `No data`, and an `<ol class="bars" aria-label="Daily uptime, last 90 days">`
  with exactly 90 `<li class="bar bar-{uptimeLevel}" title="{date}: {pct}%|No data">` elements.
  Each element contains visually hidden text identical to the title.
- `Open incidents` and `Resolved incidents` sections. Each incident shows the monitor name,
  `Started {startedAt}`, and for resolved ones `Resolved {resolvedAt} · lasted
  {formatDuration}`. Timestamps are rendered as `<time datetime="{iso}">{iso UTC, minutes}</time>`.
  When a list is empty, show `No open incidents.` / `No incidents in the recent past.`
- Every interpolated value passes through `escapeHtml` (`& < > " '`).
- Footer: `Generated {generatedAt} · Powered by Pulse`.

### 3.9 Badges (`apps/api/src/badges/`)

| Method | Path | Query | Success | Errors |
| --- | --- | --- | --- | --- |
| GET | `/badge/:monitorId.svg` | `BadgeQuery` (`type` `uptime`\|`status`, default `uptime`; optional `label` 1–40 chars) | `200` SVG | `404 NOT_FOUND` JSON when the id is not a UUID, the monitor is unknown, or `public = 0` (identical responses, so they can't be used to probe ids). `400` for an invalid query, only after the 404 checks. |

Fastify route: `/badge/:file` with `file` matching `^(uuid)\.svg$`. Anything else → 404.

Content:

| `type` | Left text (default) | Right text | Colour |
| --- | --- | --- | --- |
| `uptime` | `uptime` | `formatBadgePercent(24h uptimePercent)` from the existing `ResultRepository.uptime(id, '24h', now)`; `n/a` when there are no checks | ≥ 99.9 `#4c1`, ≥ 99 `#97ca00`, ≥ 95 `#dfb317`, else `#e05d44`; `n/a` `#9f9f9f` |
| `status` | `status` | `up` / `degraded` / `down` / `pending` / `paused` | `#4c1` / `#dfb317` / `#e05d44` / `#9f9f9f` / `#9f9f9f` |

SVG rules (shields "flat" style, height 20):

- Root: `<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="20" role="img"
  aria-label="{left}: {right}">` with `<title>{left}: {right}</title>`, a left `#555` rect, a
  right colour rect, a gradient overlay, and two `<text>` elements (Verdana/DejaVu Sans, 11px)
  with shadow copies.
- Width of each half: `round(chars × 6.5) + 10` px, where `chars` is the number of Unicode code
  points.
- Every interpolated string is XML-escaped (`& < > " '`). The output MUST parse as well-formed XML
  (tests parse it with jsdom's `DOMParser` as `image/svg+xml` and assert no `parsererror`).
- Headers: `content-type: image/svg+xml; charset=utf-8`, `cache-control: public, max-age=60`,
  `x-content-type-options: nosniff`, `content-security-policy: default-src 'none'; style-src
  'unsafe-inline'`.

### 3.10 Wiring (`apps/api/src/app.ts`, `server.ts`)

```ts
buildApp(opts: {
  databasePath: string;
  logger?: boolean | object;
  allowPrivate?: boolean;                 // NEW top-level, default false: checks, channel validation, notifications
  egress?: {                              // NEW test seams
    resolveHost?: ResolveHost;
    fetch?: typeof import('undici').fetch;
  };
  notifier?: { maxConcurrency?: number; retryDelaysMs?: readonly number[] };
  scheduler?: false | { maxConcurrency: number; runCheck?: …; random?: … }; // `allowPrivate` moves to the top level
})
```

- `server.ts` passes `allowPrivate: config.allowPrivate`. The existing start-up warning stays. No
  new env vars.
- A `Notifier` is always constructed (the "Send test" route needs it even with the scheduler
  off).
- The scheduler's `record` dep becomes `(id, outcome) => { const r = results.record(id, outcome);
  if (r?.event) notifier.enqueue(r.event); }`. It is synchronous with respect to I/O.
- `onClose`: `await scheduler?.stop()` → `await notifier.stop()` → `db.close()`, in one hook.
- Route registration: `channelRoutes`, `incidentRoutes`, `statusRoutes` (`/status`,
  `/api/v1/status`), `badgeRoutes`. The not-found handler is unchanged.
- `apps/web/vite.config.ts` dev proxy adds `/status` and `/badge`.

### 3.11 Endpoint summary (new and changed)

| Method | Path | Notes |
| --- | --- | --- |
| GET/POST/PATCH | `/api/v1/monitors[/:id]` | `Monitor.public` (default `false`) |
| GET, POST | `/api/v1/channels` | §3.5 |
| GET, PATCH, DELETE | `/api/v1/channels/:id` | §3.5 |
| POST | `/api/v1/channels/:id/test` | §3.5 |
| GET | `/api/v1/channels/:id/deliveries` | §3.5 |
| GET | `/api/v1/incidents`, `/api/v1/incidents/:id` | §3.7 |
| GET | `/api/v1/status`, `/status` | §3.8, public |
| GET | `/badge/:monitorId.svg` | §3.9, public |

## 4. UI changes (`@pulse/web`)

Shared rules: every data view has a loading state (`role="status"`), an empty state, and an
error state (`role="alert"` + **Retry**), as in iteration 2. Fetches use an `AbortController`
that is aborted on unmount. Status is never shown by colour alone.

### 4.1 Navigation and routing

The header gets a `<nav aria-label="Main">` with links **Monitors** (`#/`), **Incidents**
(`#/incidents`), **Channels** (`#/channels`), and **Status page** (`/status`, opens in a new tab,
`rel="noopener"`). The current route's link has `aria-current="page"`. `parseHash` adds
`{ name: 'incidents' }` and `{ name: 'channels' }`.

### 4.2 API client additions (`src/api/client.ts`)

```ts
listIncidents(q?: Partial<IncidentsQuery>, signal?: AbortSignal): Promise<Incident[]>;
listChannels(signal?: AbortSignal): Promise<Channel[]>;
createChannel(input: ChannelCreateInput): Promise<Channel>;
updateChannel(id: string, patch: ChannelUpdate): Promise<Channel>;
deleteChannel(id: string): Promise<void>;
testChannel(id: string): Promise<DeliveryAttempt>;
```

`updateMonitor` is reused for the public toggle. `src/api/types.ts` re-exports the new types.

### 4.3 `IncidentsView` (`src/components/IncidentsView.tsx`)

Props `{ client?: ApiClient; now?: () => Date }`. Loads `listIncidents({ status: 'all', limit:
200 })`.

- Heading **Incidents**. Section **Open** (shown only when there are open incidents), then
  **Resolved**.
- Row: monitor name linked to `#/monitors/{monitorId}`, a `StatusBadge`-like pill (`Open` red /
  `Resolved` green, with text), `Started {time}`, and a duration: open →
  `Ongoing · {formatDuration(now − startedAt)}`, resolved → `Lasted
  {formatDuration(durationSeconds)}`. The cause appears as secondary text (`—` if null).
- States: `Loading incidents…`, empty `No incidents yet. Incidents open when a monitor goes
  down.`, error + Retry.

### 4.4 `ChannelsView` and `ChannelForm`

`ChannelsView` (`src/components/ChannelsView.tsx`, props `{ client?: ApiClient }`) loads
`listChannels()` and `listMonitors()` in parallel.

- A table of channels: name, kind (`Webhook`/`Slack`), URL shown as **origin + `/…`** (the full
  URL is only in the edit form), `Enabled`/`Disabled`, subscribed-monitor count, and actions
  **Send test**, **Edit**, **Delete**.
- **Send test**: the button is disabled with the text `Sending…` while the request runs. The
  result is shown inline in a `role="status"` live region: `Delivered (HTTP {code})` or `Failed:
  {error}`. An `ApiClientError` → `Failed: {message}`.
- **Delete**: inline confirmation (`Delete "{name}"?` with **Delete** and **Cancel** buttons). On
  confirm the button is disabled while the request runs, the row is removed on success, and an
  alert appears on error.
- **Add channel** button / **Edit** → `ChannelForm` inline (one at a time).
- States: `Loading channels…`, empty `No channels yet. Add a webhook or Slack channel to get
  notified about incidents.`, error + Retry.

`ChannelForm` (`src/components/ChannelForm.tsx`, props `{ channel?: Channel; monitors: Monitor[];
onSaved(c: Channel): void; onCancel(): void; client?: ApiClient }`):

- Fields: **Name**, **Type** (`<select>` Webhook/Slack), **Webhook URL** (`type="url"`), a
  **Enabled** checkbox, and a `<fieldset>` **Notify for these monitors** with one checkbox per
  monitor (text `No monitors yet.` when the list is empty).
- Client-side validation with `ChannelCreateSchema` / `ChannelUpdateSchema`. Server `400` issues
  are mapped to fields by `path[0]` (as in `AddMonitorForm`), so a blocked URL shows its message
  under **Webhook URL** (`aria-describedby`, `aria-invalid`).
- Submit is disabled while saving (`Saving…`). Edit sends only changed fields (PATCH).

### 4.5 `MonitorDetail` additions

- `PublicToggle` (`src/components/PublicToggle.tsx`, props `{ monitor: Monitor; onChange(m:
  Monitor): void; client?: ApiClient }`): a checkbox labelled **Show on public status page**.
  Toggling calls `updateMonitor(id, { public: !monitor.public })`. The checkbox is disabled while
  saving and reflects the server response. On error it reverts and shows a `role="alert"`
  message.
- `BadgeSnippet` (`src/components/BadgeSnippet.tsx`, props `{ monitorId: string; origin?: string
  }`, default `window.location.origin`). It renders only when `monitor.public`. When the monitor
  is not public, show the text `Make this monitor public to get a status badge.`
  - It shows previews (`<img alt="uptime badge">`, `<img alt="status badge">`) and two read-only
    `<textarea>`s labelled **Uptime badge (Markdown)** and **Status badge (Markdown)**:
    `![uptime]({origin}/badge/{id}.svg)` and `![status]({origin}/badge/{id}.svg?type=status)`.
  - Each has a **Copy** button (`navigator.clipboard.writeText`) that shows `Copied` for 2 s. If
    the clipboard API is missing or rejects, the textarea is selected and the button text becomes
    `Press Ctrl+C to copy`.

## 5. Work breakdown

| # | Task | Owner | Depends on |
| --- | --- | --- | --- |
| B1 | `@pulse/shared`: `public` on monitor schemas; incident, channel, delivery, status-page, badge schemas; `formatDuration`, payload builders, `uptimeLevel`, `overallStatus`, `formatBadgePercent` + tests | backend | — |
| B2 | `@pulse/checker`: extract `egress.ts` (no behaviour change), add `validateOutboundUrl` and `postJson` + tests | backend | — |
| B3 | `@pulse/api`: migration `003` (+ backfill test), monitor repository `public` mapping, PATCH keeps status on `public` | backend | B1 |
| B4 | `@pulse/api`: `ResultRepository.record` — daily rollup and incident open/resolve, new return type + tests | backend | B3 |
| B5 | `@pulse/api`: `ChannelRepository`, `DeliveryRepository`, channel routes (CRUD, URL policy, monitorIds, test, deliveries) + tests | backend | B1, B2, B3 |
| B6 | `@pulse/api`: `Notifier` (fan-out, retries, concurrency, stop) + fake-timer tests; `buildApp` wiring (`allowPrivate` top level, `egress`, onClose order) and scheduler-isolation test | backend | B2, B4, B5 |
| B7 | `@pulse/api`: incidents routes + tests | backend | B4 |
| B8 | `@pulse/api`: `buildStatusPage`, `renderStatusPageHtml`, `/status` + `/api/v1/status` + tests | backend | B4 |
| B9 | `@pulse/api`: badge SVG renderer + route + tests | backend | B1, B3 |
| B10 | README (API table, notifications, status page, badges, security notes, status line), docs links, extend `documentation.test.ts` | backend | B5–B9 |
| F1 | Client methods + types + tests; Vite proxy for `/status`, `/badge` | frontend | B1 (can mock) |
| F2 | Navigation + routes (`#/incidents`, `#/channels`) + `IncidentsView` + tests | frontend | F1 |
| F3 | `ChannelsView` + `ChannelForm` (CRUD, Send test, delete confirm) + tests | frontend | F1 |
| F4 | `PublicToggle` + `BadgeSnippet` on `MonitorDetail` + tests | frontend | F1 |

Suggested commits: `feat(shared): incident, channel and status page schemas`, `refactor(checker):
extract egress policy`, `feat(checker): SSRF-safe postJson`, `feat(api): incidents from status
transitions`, `feat(api): notification channels`, `feat(api): webhook and slack notifier with
retries`, `feat(api): incidents endpoints`, `feat(api): public status page`, `feat(api): uptime
and status badges`, `feat(web): incidents view`, `feat(web): channel settings`, `feat(web): public
toggle and badge snippet`, `docs: iteration 3`.

## 6. Acceptance criteria

Incidents

1. Results `fail, fail` → monitor `degraded` and **0** incidents. A 3rd `fail` → exactly one
   incident with `status 'open'`, `startedAt` = that result's `checkedAt`, `cause` = its `error`.
   A 4th and 5th `fail` → still one incident, unchanged. `record` returns `event
   'incident.opened'` only for the 3rd result.
2. The next success → that incident is `resolved`, `resolvedAt` = the success's `checkedAt`,
   `durationSeconds` = the rounded difference (e.g. 150 s for 2.5 min). `record` returns `event
   'incident.resolved'`. Another success → no event. A later `down` opens a **new** incident.
3. A monitor that flaps `fail, fail, ok` repeatedly never opens an incident.
4. Inserting a second `open` incident for the same monitor directly in SQL fails (unique index).
   Deleting a monitor deletes its incidents. Migration `003` applies on a version-2 DB with
   results and backfills `daily_uptime` with correct per-day counts.
5. `GET /api/v1/incidents` returns open incidents first (newest start first), then resolved
   (newest resolution first). It honours `status`, `monitorId` and `limit` (default 50, max 200).
   Invalid values → `400` with an issue at the parameter's path. Every item matches
   `IncidentSchema`. `GET /api/v1/incidents/:id` → `200` or `404` (also for a non-UUID).

Notifications

6. Channel CRUD: `POST` → `201` + `Location`; `GET` list/one; `PATCH` partial (incl. replacing
   `monitorIds`); `DELETE` → `204` and removes subscriptions and attempts. An unknown monitor id
   → `400` at `["monitorIds", i]`. Read-only fields (`id`, `createdAt`) in the body → `400`.
7. When an incident opens for a monitor subscribed to channels A (webhook, enabled), B (slack,
   enabled) and C (enabled = false), and channel D is not subscribed: exactly one POST goes to A
   with a body equal to `buildWebhookPayload(...)` (`event 'incident.opened'`, monitor, incident)
   and header `x-pulse-event: incident.opened`; exactly one POST goes to B with `{ "text": … }`
   matching §3.1.4 (Slack-escaped); none go to C or D. The same holds for `incident.resolved`,
   with the duration in the Slack text.
8. With fake timers and a mocked `fetch` that returns `500`: attempts happen at t = 0, 2 000 and
   12 000 ms (and none after). 3 `delivery_attempts` rows are stored with `attempt` 1–3, `ok
   false`, `statusCode 500`, `error "HTTP 500"`, and a `warn` is logged per failure plus an `error`
   at the end. A mock that fails once then returns `204` → 2 attempts, the last with `ok true`.
9. Notifications never delay checks: with the scheduler running on fake timers, a `fetch` that
   never resolves, and 2 monitors (one opens an incident), the other monitor's `runCheck` is still
   called at its scheduled times. `record` returns synchronously, and `scheduler.inFlight` never
   includes notification work. `app.close()` resolves after `notifier.stop()`, and no retry fires
   after close.
10. After 25 attempts on one channel, `GET /api/v1/channels/:id/deliveries` returns exactly the
    20 newest, newest first. Attempts on other channels are untouched.
11. SSRF on create/update: with `allowPrivate false`, `POST`/`PATCH` with url
    `http://127.0.0.1/hook`, `http://169.254.169.254/`, `http://[::ffff:10.0.0.1]/`, or a
    hostname whose injected `resolveHost` returns `10.0.0.5` → `400 VALIDATION_ERROR` with an
    issue at `["url"]` naming the blocked address. A DNS failure → `400`. A public address
    (`203.0.113.10`) → `201`. With `allowPrivate true`, `127.0.0.1` → `201`, but `169.254.169.254`
    → `400 … (metadata)`.
12. SSRF at send time: a channel saved with a public resolution whose `resolveHost` later returns
    `127.0.0.1` gets **no** HTTP request (`fetch` not called). One attempt is recorded with `error
    "blocked address: … (loopback)"` and is not retried. A `3xx` response is a failure
    (`unexpected redirect (HTTP 302)`) and the `Location` is not followed. With
    `PULSE_ALLOW_PRIVATE=1` (`allowPrivate true`) a loopback endpoint receives the POST.
13. `POST /api/v1/channels/:id/test` sends `event 'test'` once (also for a disabled channel),
    returns `200 { data: DeliveryAttempt }` (`ok` reflects the result), records it, and `404`s for
    an unknown id.

Status page

14. `GET /status` returns `200 text/html` with the CSP header and **no `<script>`**. It lists
    every public monitor (name + status text) and **no** private monitor (its name is absent from
    the HTML), and it never contains monitor URLs or incident causes.
15. `GET /api/v1/status` validates against `StatusPageSchema`. At the same frozen time,
    `monitors[].id`, statuses, `uptime90dPercent`, the 90 `days` (date + level) and the incident
    ids equal what the HTML shows (`data-monitor-id`, `data-status`, bar `title`s), and
    `data-overall` equals `overall`.
16. Daily bars: with the time frozen at `2026-10-11T00:30:00Z` and results recorded at
    `2026-10-10T23:59:59.999Z` (ok), `2026-10-11T00:00:00.000Z` (fail) and `2026-07-13T12:00Z`
    (day −90, outside the window), `days` has 90 entries from `2026-07-14` to `2026-10-11`. Oct 10
    has `1/1 = 100`, Oct 11 has `0/1 = 0`, and the Jul 13 result is not counted. Days without
    checks are `null`/`none`.
17. `overall` is `unknown` (no public monitors, or all pending), `operational`, `degraded`,
    `partial_outage`, and `major_outage` for the inputs in §3.1.5. Paused monitors are ignored.
    Open incidents and the latest 10 resolved incidents are listed only for public monitors.

Badges

18. `GET /badge/{publicId}.svg` → `200` with `image/svg+xml`, `cache-control: public, max-age=60`
    and `nosniff`. It parses as well-formed SVG with `role="img"`, a `<title>` and the text
    `uptime` / `99.9%` for seeded 24 h results (999 ok of 1000), or `n/a` with no data.
    `?type=status` shows `status` / `down` with colour `#e05d44` for a down monitor.
19. `?label=<a&"b'>` is XML-escaped in the `<title>`, `aria-label` and `<text>` elements, and the
    document still parses. A 41-char label or `type=foo` → `400`.
20. A private monitor, an unknown UUID, a non-UUID, and `/badge/{id}.png` → `404`. A private
    monitor's 404 is byte-identical to an unknown id's.

Web

21. `IncidentsView`: loading text, then open incidents before resolved ones with `Ongoing · …` /
    `Lasted …` durations and monitor links. Empty state text when there are none. Error → alert +
    Retry refetches.
22. `ChannelsView`/`ChannelForm`: loading, empty and error states. Adding a channel (with monitor
    checkboxes) calls `createChannel` and shows the row. Editing sends only changed fields. A
    server `400` at `["url"]` is shown under **Webhook URL** with `aria-invalid`. Delete requires
    confirmation and removes the row. **Send test** shows `Sending…`, then `Delivered (HTTP 200)`
    or `Failed: HTTP 500`.
23. `MonitorDetail`: the **Show on public status page** checkbox calls `updateMonitor(id, {
    public: true })`, is disabled while saving, and reverts with an alert on error. When public,
    `BadgeSnippet` shows both Markdown snippets with the correct absolute URLs and image previews.
    When private, it shows the hint text. Copy writes the snippet to the clipboard.
24. Navigation links render, `aria-current="page"` follows the hash, and `#/incidents` /
    `#/channels` render their views.

Workspace

25. `pnpm lint`, `pnpm format:check`, `pnpm -r test` and `pnpm -r build` pass, and CI is green.
    No new runtime dependency is added. The only new dev dependency is `jsdom` for `apps/api`
    tests. No test makes a real outbound request.
26. The README documents channels, notification payloads, `/status`, `/api/v1/status`, badges
    with a Markdown example, the `public` flag, the new endpoints, and the updated security notes
    (channel URLs readable without auth; metadata always blocked). `documentation.test.ts` asserts
    the key strings.

## 7. Test plan

| Package | Tooling | Tests (file → criteria) |
| --- | --- | --- |
| shared | Vitest | `test/incident.test.ts` (open/resolved null rules, query defaults/bounds), `test/channel.test.ts` (create defaults, strict, update needs ≥ 1 field, URL rule), `test/notification-payload.test.ts` (exact Slack text per event, Slack escaping of `<&>`, webhook shape, `formatDuration` table), `test/status-page.test.ts` (`overallStatus` table, `uptimeLevel` thresholds, schema), `test/badge.test.ts` (`formatBadgePercent` floor/strip), `monitor.test.ts` (`public` default, keeps status). |
| checker | Vitest + `node:http` on `127.0.0.1:0` + injected `resolveHost`/`fetch` | Existing suites unchanged (refactor guard). `test/post-json.test.ts`: blocked IP literal / resolved / mapped IPv6 / metadata with `allowPrivate`, with a request counter proving 0 requests; 2xx ok; 500 → `HTTP 500`; 302 not followed; timeout with a never-settling resolver; body sent as JSON with headers. `test/validate-outbound-url.test.ts` (AC 11 cases). |
| api | Vitest + `inject` + `:memory:` + `vi.useFakeTimers()` / `vi.setSystemTime` | `test/incidents-lifecycle.test.ts` (AC 1–4, via `ResultRepository.record` with explicit `checkedAt`). `test/migrate.test.ts` extended (003 on a v2 DB with results, backfill). `test/incidents.test.ts` (AC 5). `test/channels.test.ts` (AC 6, 10, 11, 13; injected `egress.resolveHost`/`fetch`). `test/notifier.test.ts`: pure `Notifier` with fake deps and deferred promises (AC 7, 8, 12, stop/drop, concurrency cap, disabled/deleted channel mid-retry). `test/app-notifications.test.ts`: `buildApp` + scheduler + fake `runCheck` + mocked fetch end to end (AC 7, 9). `test/status-page.test.ts` (AC 14–17; seed through `record`, never by raw SQL into `check_results`). `test/badge.test.ts` (AC 18–20; parse with jsdom's `DOMParser` — add `jsdom` (MIT, already in the lockfile via `apps/web`) as an `apps/api` **devDependency**). `test/documentation.test.ts` (AC 26). |
| web | Vitest + jsdom + Testing Library + `user-event`, fake `ApiClient`, deferred promises | `IncidentsView.test.tsx` (AC 21, injected `now`), `ChannelsView.test.tsx` + `ChannelForm.test.tsx` (AC 22), `PublicToggle.test.tsx` + `BadgeSnippet.test.tsx` (AC 23, stubbed `navigator.clipboard`), `App.test.tsx` routing/nav (AC 24), `client.test.ts` (URLs, methods, bodies and unwrap for the new methods). |

No test may make a real outbound network request: checker tests talk only to `127.0.0.1` with
`allowPrivate: true` or use injected `resolveHost`/`fetch`, and API tests inject `egress.fetch`
and `egress.resolveHost`. Playwright e2e remains out of scope.
