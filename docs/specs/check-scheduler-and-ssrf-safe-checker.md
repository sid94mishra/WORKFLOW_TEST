# Pulse — Iteration 2: Check scheduler and SSRF-safe checker

- **Status:** Ready for implementation
- **Date:** 2026-10-11
- **Builds on:** [Iteration 1 spec](iteration-1.md) (conventions in §4.4 there still apply)
- **Decisions:** [ADR 0002 – SSRF egress policy](../adr/0002-ssrf-egress-policy.md),
  [ADR 0003 – In-process check scheduler](../adr/0003-in-process-scheduler.md)

Normative words: **MUST**, **SHOULD**, **MAY** (RFC 2119). Anything not specified here is the
implementer's choice, provided all acceptance criteria (§6) pass.

## 1. Summary

Monitors start running on their own. A scheduler in `@pulse/api` runs every enabled monitor every
`intervalSeconds` (±10 % jitter) with a global concurrency cap, stores every outcome in
`check_results`, and keeps a per-monitor status (`pending` → `up` / `degraded` / `down`). The
check engine in `@pulse/checker` becomes safe to expose: it resolves DNS itself, refuses private,
loopback, link-local, metadata and other reserved addresses (including on every redirect hop),
and pins the connection to the addresses it validated, so DNS rebinding cannot bypass the check.
Two new read endpoints expose recent results and uptime/latency statistics, and the web app gets
a monitor detail view with a status badge, a latency sparkline and 24h/7d/30d uptime.

## 2. Scope

**In scope**

| Package | Work |
| --- | --- |
| `@pulse/shared` | Status enums, `status`/`lastCheckedAt` on `Monitor`, `status` on `CheckResult`, query and uptime schemas (§3.1). |
| `@pulse/checker` | Address policy, DNS resolution + pinning, manual redirects (max 3), `allowPrivate` option (§3.2). |
| `@pulse/api` | Migration `002`, result repository + status state machine, scheduler, config vars, two routes, route → scheduler wiring, graceful shutdown (§3.3–§3.6). |
| `@pulse/web` | Hash routing, monitor detail view, `StatusBadge`, `LatencySparkline`, `UptimeSummary`, client methods (§4). |
| Docs | README (config table, API table, security notes, status line), this spec, ADRs 0002/0003. |

**Out of scope** (later iterations)

- Result retention/pruning (rows are bounded at ~86 k per monitor per 30 days at the 30 s
  minimum; the 30 d window needs them). Planned with status pages.
- Rejecting private URLs at `POST`/`PATCH` time. The checker is the enforcement point; DNS at
  create time proves nothing (rebinding). Blocked checks show up as failed results with a clear
  error.
- Notifications, incidents, public status pages, auth, result pagination beyond `limit`.
- Live updates of the detail view (polling/SSE); the user reloads.
- Per-monitor latency thresholds ("slow = degraded"), HTTP proxy support (`HTTP(S)_PROXY` is
  ignored), multiple API instances sharing one database (see ADR 0003).

## 3. API and data changes

### 3.1 `@pulse/shared`

New file `src/status.ts` (re-exported from `index.ts`):

```ts
export const CHECK_STATUSES = ['up', 'degraded', 'down'] as const;
export const MONITOR_STATUSES = ['pending', 'up', 'degraded', 'down'] as const;
export const CheckStatusSchema = z.enum(CHECK_STATUSES);
export const MonitorStatusSchema = z.enum(MONITOR_STATUSES);
export const DOWN_AFTER_CONSECUTIVE_FAILURES = 3;
export type CheckStatus = z.infer<typeof CheckStatusSchema>;
export type MonitorStatus = z.infer<typeof MonitorStatusSchema>;
```

Changes to existing schemas:

| Schema | Change |
| --- | --- |
| `MonitorSchema` | Add read-only `status: MonitorStatusSchema` and `lastCheckedAt: z.iso.datetime().nullable()`. |
| `MonitorCreateSchema` / `MonitorUpdateSchema` | Unchanged. Being `.strict()`, they reject `status` and `lastCheckedAt` like `id`/`createdAt` (`400 VALIDATION_ERROR`). |
| `CheckOutcomeSchema` | Unchanged (checker output has no status; status depends on history). |
| `CheckResultSchema` | `CheckOutcome` + `id`, `monitorId` + **`status: CheckStatusSchema`**. |

New file `src/results.ts`:

```ts
export const RESULTS_LIMITS = { default: 50, min: 1, max: 500 } as const;
export const ResultsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
}); // not strict: unknown query params are ignored

export const UPTIME_WINDOWS = ['24h', '7d', '30d'] as const;
export const UPTIME_WINDOW_MS = { '24h': 86_400_000, '7d': 604_800_000, '30d': 2_592_000_000 } as const;
export const UptimeWindowSchema = z.enum(UPTIME_WINDOWS);
export const UptimeQuerySchema = z.object({ window: UptimeWindowSchema.default('24h') });

export const UptimeSummarySchema = z.object({
  monitorId: z.uuid(),
  window: UptimeWindowSchema,
  from: z.iso.datetime(),            // to − window, inclusive
  to: z.iso.datetime(),              // request time
  totalChecks: z.number().int().min(0),
  okChecks: z.number().int().min(0),
  uptimePercent: z.number().min(0).max(100).nullable(),  // null iff totalChecks = 0
  latencyP50Ms: z.number().int().min(0).nullable(),      // null iff okChecks = 0
  latencyP95Ms: z.number().int().min(0).nullable(),
}).strict();
export type UptimeWindow = z.infer<typeof UptimeWindowSchema>;
export type UptimeSummary = z.infer<typeof UptimeSummarySchema>;
```

`@pulse/shared` still MUST NOT import Node built-ins.

### 3.2 `@pulse/checker` — SSRF-safe checks

Rationale and alternatives: [ADR 0002](../adr/0002-ssrf-egress-policy.md).

New dependency: **`undici` `^7`** (MIT). The checker imports `fetch` and `Agent` from `undici`
(not the global fetch) so the `dispatcher` option is version-matched.

#### 3.2.1 Contract

```ts
export interface ResolvedAddress { address: string; family: 4 | 6 }
export type ResolveHost = (hostname: string) => Promise<ResolvedAddress[]>;

export interface HttpCheckOptions {
  fetch?: typeof import('undici').fetch;  // injectable for tests; default undici fetch
  userAgent?: string;                      // default "Pulse/0.1 (+uptime-check)"
  resolveHost?: ResolveHost;               // default dns.promises.lookup(host, { all: true, verbatim: true })
  allowPrivate?: boolean;                  // default false (§3.2.3)
}
export function runHttpCheck(target: HttpCheckTarget, opts?: HttpCheckOptions): Promise<CheckOutcome>;

// New exports (src/address-policy.ts), pure and synchronous:
export type BlockReason =
  | 'loopback' | 'private' | 'link-local' | 'metadata' | 'unspecified'
  | 'carrier-grade-nat' | 'multicast' | 'reserved' | 'unique-local';
export function classifyAddress(ip: string): BlockReason | null;  // null = public
export function isAddressAllowed(ip: string, allowPrivate: boolean): boolean;
export const MAX_REDIRECTS = 3;

// src/pinned-lookup.ts: the `connect.lookup` for the per-check undici Agent (§3.2.3 step 2).
// Supports Node's `lookup(hostname, options, callback)` with and without `options.all`.
export function createPinnedLookup(validated: ReadonlyMap<string, ResolvedAddress[]>): LookupFunction;
```

`HttpCheckTarget` is unchanged. `runHttpCheck` still **never rejects**.

#### 3.2.2 Address policy

`classifyAddress` uses `node:net` `BlockList` (no dependency). IPv4-mapped IPv6 addresses
(`::ffff:a.b.c.d`, also in hex form `::ffff:7f00:1`) MUST be unwrapped and classified as IPv4.
Invalid input → `'reserved'` (fail closed).

| Range | Reason | Blocked by default | Blocked with `allowPrivate` |
| --- | --- | --- | --- |
| `169.254.169.254/32`, `fd00:ec2::254/128` | `metadata` | yes | **yes** |
| `127.0.0.0/8`, `::1/128` | `loopback` | yes | no |
| `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` | `private` | yes | no |
| `169.254.0.0/16`, `fe80::/10` | `link-local` | yes | no |
| `fc00::/7` | `unique-local` | yes | no |
| `0.0.0.0/8`, `::/128` | `unspecified` | yes | no |
| `100.64.0.0/10` | `carrier-grade-nat` | yes | no |
| `224.0.0.0/4`, `ff00::/8` | `multicast` | yes | no |
| `240.0.0.0/4` (incl. `255.255.255.255`) | `reserved` | yes | no |

Ranges are checked most-specific first, so `169.254.169.254` reports `metadata`, not
`link-local`. Documentation ranges (`192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`,
`2001:db8::/32`) are **not** blocked; tests use them as "public" addresses.

#### 3.2.3 Algorithm (per check)

1. `checkedAt` and `t0` are taken at the start of the check (before DNS). One `AbortController`
   with `setTimeout(timeoutMs)` covers **the whole chain**: every DNS lookup, every hop and the
   body read. DNS lookups are not cancellable, so each lookup is raced against the abort signal.
2. A per-check `Map<hostname, ResolvedAddress[]>` of **validated** addresses and one per-check
   `undici.Agent` whose `connect.lookup` answers **only** from that map (an unknown host is an
   error). The agent is `destroy()`ed in `finally`. Connections are therefore never reused across
   checks and never resolve DNS a second time.
3. For each hop (initial URL, then each redirect target), **before any request**:
   1. Protocol MUST be `http:` or `https:`; otherwise fail (`unsupported redirect protocol` — only
      possible on redirects, since the schema already restricts monitor URLs).
   2. `host = url.hostname` with IPv6 brackets stripped. If `net.isIP(host)`, the address list is
      `[host]`; otherwise `await resolveHost(host)`. Lookup failure → fail with
      `` `dns lookup failed: ${message}` ``; an empty list → `dns lookup failed: no addresses`.
   3. **Every** resolved address MUST pass `isAddressAllowed(addr, allowPrivate)`. If any fails,
      the check fails with the blocked-address error (§3.2.4) and **no request is made**.
   4. Store the list in the map; call `fetch(url, { method, redirect: 'manual', cache: 'no-store',
      signal, dispatcher: agent, headers: { 'user-agent': userAgent } })`.
4. Redirects: a response with status `301, 302, 303, 307, 308` **and** a `Location` header is a
   redirect. Its body is cancelled; `Location` is resolved against the current URL. `303`, and
   `301`/`302` for non-`GET`/`HEAD` methods, switch the method to `GET`. After `MAX_REDIRECTS` (3)
   followed redirects, a 4th redirect response fails the check with `too many redirects (max 3)`.
   A 3xx without `Location` is a final response.
5. The final response is evaluated exactly as in iteration-1 §5.2 (keyword, expected status).
   `statusCode` is the final response's status; it is `null` when the check fails before a final
   response (blocked, DNS failure, too many redirects, network error).
6. `latencyMs = round(now − t0)` when the final response's headers arrive (so it now includes DNS
   and redirect hops), or at failure.

`allowPrivate: true` skips every rule except `metadata`; redirect limits and protocol rules still
apply.

#### 3.2.4 Outcome rules (added to iteration-1 §5.2, evaluated first)

| Situation | `ok` | `statusCode` | `error` (exact format) |
| --- | --- | --- | --- |
| IP-literal host blocked | `false` | `null` | `` `blocked address: ${ip} (${reason})` `` e.g. `blocked address: 169.254.169.254 (metadata)` |
| Hostname resolves to a blocked address | `false` | `null` | `` `blocked address: ${host} resolves to ${ip} (${reason})` `` (first blocked address in resolver order) |
| Redirect target blocked | `false` | `null` | `` `blocked redirect to ${url}: ${ip} (${reason})` `` |
| Redirect to non-http(s) | `false` | `null` | `` `unsupported redirect protocol: ${protocol}` `` |
| More than 3 redirects | `false` | `null` | `too many redirects (max 3)` |
| DNS failure | `false` | `null` | `` `dns lookup failed: ${err.code ?? err.message}` `` |
| Timeout anywhere in the chain | `false` | status if final headers arrived, else `null` | `timeout` |

`keywordMatched` is `null` in all rows above.

### 3.3 Database — `apps/api/migrations/002_scheduler.sql`

```sql
ALTER TABLE monitors ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'
  CHECK (status IN ('pending', 'up', 'degraded', 'down'));
ALTER TABLE monitors ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0
  CHECK (consecutive_failures >= 0);
ALTER TABLE monitors ADD COLUMN last_checked_at TEXT NULL;

ALTER TABLE check_results ADD COLUMN status TEXT NOT NULL DEFAULT 'down'
  CHECK (status IN ('up', 'degraded', 'down'));
UPDATE check_results SET status = CASE ok WHEN 1 THEN 'up' ELSE 'down' END;
```

Column mapping for the brief's names: `http_status` is the existing `status_code` (API
`statusCode`), `latency_ms` / `error` / `checked_at` already exist. Iteration 1 created
`check_results` with no writer, so no backfill beyond the `UPDATE` is needed. The existing index
`(monitor_id, checked_at DESC)` serves both new queries. `consecutive_failures` is internal (not
in the API).

### 3.4 Status state machine (`apps/api/src/results/repository.ts`)

`ResultRepository.record(monitorId, outcome): CheckResult | undefined` runs in **one
transaction**:

1. `SELECT consecutive_failures FROM monitors WHERE id = ?`. No row (monitor deleted mid-check) →
   return `undefined`, write nothing.
2. `failures = outcome.ok ? 0 : previous + 1`.
3. `status = outcome.ok ? 'up' : failures >= 3 ? 'down' : 'degraded'`.
4. Insert the `check_results` row (new UUID, that `status`), and
   `UPDATE monitors SET status, consecutive_failures = failures, last_checked_at = outcome.checkedAt`.

So: 1–2 consecutive failures → `degraded`; the 3rd → `down`; any success → `up`. A new monitor is
`pending` until its first result.

`PATCH` that changes any of `url`, `method`, `timeoutMs`, `expectedStatus`, `keyword` resets the
monitor to `status = 'pending'`, `consecutive_failures = 0` (old history no longer describes the
new target). Changing only `name`, `intervalSeconds` or `enabled` keeps the status.

Repository also provides `listRecent(monitorId, limit)` (`ORDER BY checked_at DESC, rowid DESC`)
and `uptime(monitorId, window, now)` (§3.6).

### 3.5 Scheduler (`apps/api/src/scheduler/scheduler.ts`)

Rationale and alternatives: [ADR 0003](../adr/0003-in-process-scheduler.md).

```ts
export interface SchedulerDeps {
  listEnabled(): Monitor[];
  runCheck(monitor: Monitor): Promise<CheckOutcome>;  // prod: runHttpCheck(m, { allowPrivate })
  record(monitorId: string, outcome: CheckOutcome): void;
  maxConcurrency: number;          // ≥ 1
  random?: () => number;           // [0, 1), default Math.random — injected in tests
  log?: Pick<FastifyBaseLogger, 'debug' | 'info' | 'warn' | 'error'>;
}
export class Scheduler {
  constructor(deps: SchedulerDeps);
  start(): void;                   // schedules every enabled monitor; idempotent
  upsert(monitor: Monitor): void;  // add / reschedule; disabled → same as remove
  remove(monitorId: string): void; // clears the timer, drops a queued run
  stop(): Promise<void>;           // idempotent; same promise on repeat calls
  readonly inFlight: number;       // for tests and logs
  readonly queued: number;
}
```

Timing rules (all via `setTimeout`, so Vitest fake timers drive them):

| Rule | Value |
| --- | --- |
| Base interval | `max(intervalSeconds, 30) × 1000` ms |
| Jittered delay | `base × (0.9 + 0.2 × random())` → always within ±10 % of base |
| First run after `start()` / `upsert()` | `base × 0.1 × random()` (spreads start-up load; data appears within 10 % of the interval) |
| Next run | Armed **when the timer fires** (fixed rate), not when the check ends |
| Overlap | If a monitor's previous run is still queued or in flight when its timer fires, that firing is skipped (debug log) and the next one is armed |
| Concurrency | At most `maxConcurrency` `runCheck` calls in flight; excess runs wait in a FIFO queue |
| `upsert` while running | New timer replaces the old; an in-flight run finishes and is recorded |
| Errors | `runCheck` must not reject (checker contract); if it does, or `record` throws, log `error` and continue — the scheduler never crashes the process |

**Graceful shutdown — `stop()`:** sets `stopped` (later `upsert`/timer callbacks are no-ops),
clears all timers, drops queued runs, then awaits every in-flight `runCheck` **and its `record`**.
In-flight checks are bounded by their own `timeoutMs` (≤ 60 s), so `stop()` is bounded.

**Wiring (`apps/api/src/app.ts`):**

```ts
buildApp(opts: {
  databasePath: string;
  logger?: boolean | object;
  scheduler?: false | {           // default false: existing tests start no checks
    maxConcurrency: number;
    allowPrivate: boolean;
    runCheck?: SchedulerDeps['runCheck'];  // test override
    random?: () => number;
  };
})
```

- When enabled, `buildApp` constructs the `Scheduler` and decorates `app.scheduler`; it calls
  `scheduler.start()` in an `onReady` hook.
- The single `onClose` hook MUST `await scheduler?.stop()` **before** `db.close()` (one hook, so
  hook ordering cannot close the DB under an in-flight `record`).
- Monitor routes call `scheduler?.upsert(monitor)` after `POST`/`PATCH` and
  `scheduler?.remove(id)` after `DELETE`.
- `server.ts` passes `{ maxConcurrency, allowPrivate }` from config; `SIGINT`/`SIGTERM` →
  `app.close()` (stops listening, finishes requests, stops scheduler, closes DB) → exit 0.
- With `allowPrivate`, the server logs a `warn` at start-up: `PULSE_ALLOW_PRIVATE=1: private
  addresses are allowed; do not use in production`.

### 3.6 Configuration (`apps/api/src/config.ts`)

| Var | Default | Rule |
| --- | --- | --- |
| `PULSE_MAX_CONCURRENCY` | `8` | Integer 1–64; invalid → exit with error (like `PORT`). |
| `PULSE_ALLOW_PRIVATE` | `0` | Exactly `0` or `1`; anything else → exit with error. |

`Config` gains `maxConcurrency: number` and `allowPrivate: boolean`.

### 3.7 Endpoints

Conventions from iteration-1 §4.4 apply (envelope, error shapes, `404` for non-UUID ids).
Query validation errors → `400 VALIDATION_ERROR`, `issues[].path` = `["limit"]` / `["window"]`.
A missing monitor wins over an invalid query (`404` first, as with `PATCH`).

| Method | Path | Query | Success | Errors |
| --- | --- | --- | --- | --- |
| GET | `/api/v1/monitors/:id/results` | `limit` int 1–500, default 50 | `200 { data: CheckResult[] }`, newest first (`checked_at DESC, rowid DESC`); `[]` when none | `400`, `404` |
| GET | `/api/v1/monitors/:id/uptime` | `window` `24h`\|`7d`\|`30d`, default `24h` | `200 { data: UptimeSummary }` | `400`, `404` |
| GET | `/api/v1/monitors[/:id]` | — | `Monitor` now includes `status`, `lastCheckedAt` | unchanged |

Uptime computation, for results with `to − window ≤ checked_at ≤ to` (`to` = request time):

- `totalChecks` = count; `okChecks` = count where `ok = 1`.
- `uptimePercent = round2(100 × okChecks / totalChecks)`, `null` when `totalChecks = 0`. Uptime
  is based on raw `ok`, not on `status`, so a flapping monitor that never reaches `down` still
  shows its real failure rate.
- `latencyP50Ms` / `latencyP95Ms`: nearest-rank percentile over `latency_ms` of **ok** results
  (failure latencies are time-to-failure and would skew it): sort ascending, take index
  `ceil(p/100 × n) − 1`. `null` when `okChecks = 0`. SQL (`ORDER BY latency_ms LIMIT 1 OFFSET ?`)
  or JS — implementer's choice; the 30 d worst case is ~86 k integers.

Example:

```json
GET /api/v1/monitors/2b4e…/uptime?window=7d
200 { "data": { "monitorId": "2b4e…", "window": "7d",
  "from": "2026-10-04T12:00:00.000Z", "to": "2026-10-11T12:00:00.000Z",
  "totalChecks": 10080, "okChecks": 10075, "uptimePercent": 99.95,
  "latencyP50Ms": 112, "latencyP95Ms": 340 } }
```

## 4. UI changes (`@pulse/web`)

### 4.1 Routing

No router dependency. A small `useHashRoute()` hook parses `location.hash`:

| Hash | View |
| --- | --- |
| `''`, `#/` | Dashboard (iteration 1: list + add form) |
| `#/monitors/:id` | `MonitorDetail` |
| anything else | Dashboard |

It listens to `hashchange`. In `MonitorList`, the monitor name becomes a link
`<a href="#/monitors/{id}">{name}</a>` (other columns unchanged).

### 4.2 API client additions

```ts
getMonitor(id: string, signal?: AbortSignal): Promise<Monitor>;  // signal added
listResults(id: string, opts?: { limit?: number }, signal?: AbortSignal): Promise<CheckResult[]>;
getUptime(id: string, window: UptimeWindow, signal?: AbortSignal): Promise<UptimeSummary>;
```

Error handling as in iteration-1 §6.2.

### 4.3 `MonitorDetail` (`src/components/MonitorDetail.tsx`)

Props `{ id: string; client?: ApiClient }`. On mount (and on Retry) it fires, in parallel, with
one `AbortController` aborted on unmount: `getMonitor`, `listResults(id, { limit: 50 })`, and
`getUptime` for `24h`, `7d`, `30d`. Each section has its own state so one slow call does not
blank the page.

Layout: back link `← All monitors` (`href="#/"`), `<h2>{name}</h2>`, URL as text, `StatusBadge`,
"Last checked {relative or ISO time}" or "Not checked yet", then sections with headings
**Latency (last 50 checks)** and **Uptime**.

| State | Rendering |
| --- | --- |
| Monitor loading | `<p role="status">Loading monitor…</p>` |
| Monitor `404` | `<p>Monitor not found.</p>` + back link |
| Any other error | `role="alert"` box with message + **Retry** button (same style as `MonitorList`) — refetches all calls |
| Results loading | `<p role="status">Loading results…</p>` in the latency section |
| Results empty | `No checks yet. The first check runs shortly after the monitor is enabled.` |
| Uptime loading | `<p role="status">Loading uptime…</p>` |

### 4.4 `StatusBadge` (`src/components/StatusBadge.tsx`)

Props `{ status: MonitorStatus; enabled: boolean }`. Text is always present (never colour only):

| Condition | Text | Tailwind colours (AA contrast) |
| --- | --- | --- |
| `enabled = false` | `Paused` | slate-200 / slate-800 |
| `pending` | `Pending` | slate-100 / slate-800 |
| `up` | `Up` | green-100 / green-900 |
| `degraded` | `Degraded` | amber-100 / amber-900 |
| `down` | `Down` | red-100 / red-900 |

### 4.5 `LatencySparkline` (`src/components/LatencySparkline.tsx`)

Props `{ results: CheckResult[] }` (API order, newest first). Inline SVG, no chart library.

- Plots oldest → newest left to right; `viewBox="0 0 240 48"`, `preserveAspectRatio="none"`,
  `width="100%"`, height 48 px. Y scale `0 … max(latency of ok results)`.
- Ok results: one `<polyline>` (single ok result → a `<circle>`). Failed results: a red tick at the
  baseline in their x position (`data-testid="failure-mark"`), so failures are visible without
  inventing a latency.
- `role="img"` and `aria-label`, e.g. `Latency over the last 50 checks: min 80 ms, median 112 ms,
  max 340 ms, latest 101 ms, 2 failed.` With no ok results: `No successful checks in the last
  {n} checks.`
- `results.length === 0` → renders nothing (the parent shows the empty state).

### 4.6 `UptimeSummary` (`src/components/UptimeSummary.tsx`)

Props `{ items: Record<UptimeWindow, { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; summary: UptimeSummary }> }`.
A `<dl>` with one tile per window, labels **24 hours**, **7 days**, **30 days**:

- ready, `totalChecks > 0`: `99.95%` (two decimals), and `p50 112 ms · p95 340 ms` (`—` for a
  null percentile), and `{totalChecks} checks`.
- ready, `totalChecks = 0`: `No data`.
- loading: `Loading…` (inside the shared `role="status"` region); error: `Unavailable`.

## 5. Work breakdown

| # | Task | Owner | Depends on |
| --- | --- | --- | --- |
| B1 | `@pulse/shared`: status enums, `Monitor`/`CheckResult` fields, results/uptime schemas + tests | backend | — |
| B2 | `@pulse/checker`: `address-policy.ts` + `undici` pinning + manual redirects + `allowPrivate` + tests; adapt existing tests (`allowPrivate: true`) | backend | B1 (types) |
| B3 | `@pulse/api`: migration `002`, monitor repository mapping, PATCH status reset | backend | B1 |
| B4 | `@pulse/api`: `ResultRepository` (record/state machine, listRecent, uptime) + tests | backend | B3 |
| B5 | `@pulse/api`: `Scheduler` + fake-timer tests | backend | B1 |
| B6 | `@pulse/api`: config vars, `buildApp` wiring, route hooks, graceful shutdown, results/uptime routes + tests | backend | B2, B4, B5 |
| B7 | README + docs updates | backend | B6 |
| F1 | Client methods + tests | frontend | B1 (can mock) |
| F2 | `StatusBadge`, `LatencySparkline`, `UptimeSummary` + tests | frontend | B1 |
| F3 | `useHashRoute`, `MonitorDetail`, name link in `MonitorList` + tests | frontend | F1, F2 |

Suggested commits: `feat(shared): monitor status and uptime schemas`, `feat(checker): block private
addresses and pin DNS`, `feat(checker): re-check redirects (max 3)`, `feat(api): check results
and status state machine`, `feat(api): check scheduler with jitter and concurrency limit`,
`feat(api): results and uptime endpoints`, `feat(web): monitor detail view`, `docs: …`.

## 6. Acceptance criteria

Checker

1. `runHttpCheck` on `http://169.254.169.254/` resolves `ok false, statusCode null, error
   "blocked address: 169.254.169.254 (metadata)"`; the injected `fetch` is never called.
2. With `resolveHost` mapping `evil.test` → `127.0.0.1`, a check of `http://evil.test:<port>/`
   against a local server fails with `blocked address: evil.test resolves to 127.0.0.1 (loopback)`
   and the server receives **0** requests.
3. A hostname resolving to `[203.0.113.5, 10.0.0.1]` is blocked (every address is checked).
4. `classifyAddress` returns the reason in §3.2.2 for one address inside and the first/last address
   of each range, `null` for `8.8.8.8`, `203.0.113.5`, `2001:db8::1`; `::ffff:127.0.0.1` and
   `::ffff:7f00:1` → `loopback`; `[::1]` URL host → `loopback`.
5. A public hop that redirects to `http://10.0.0.1/` fails with `blocked redirect to
   http://10.0.0.1/: 10.0.0.1 (private)`; `fetch` is called exactly once.
6. 3 redirects are followed to a final 200 (`ok true`); a 4th fails with `too many redirects
   (max 3)`.
7. With `allowPrivate: true`, a check against the local `127.0.0.1` server succeeds, but
   `169.254.169.254` is still blocked as `metadata`.
8. DNS is pinned (rebinding): within one check `resolveHost` is called exactly once per distinct
   hostname, and `createPinnedLookup(map)` answers both lookup signatures (`all: true` and single)
   only from `map`, errors for a hostname not in `map`, and never resolves DNS itself.
9. The timeout covers DNS: a `resolveHost` that never settles with `timeoutMs 1000` resolves in
   < 1.5 s with `error "timeout"`. All iteration-1 checker criteria still pass.

Scheduler

10. With fake timers and `random = () => 0.5`, a 60 s monitor runs at ~3 s (first run,
    `60 000 × 0.1 × 0.5`) and then every 60 000 ms; with `random = () => 0` the gap is 54 000 ms
    and with `random = () => 0.999…` it is < 66 000 ms.
11. With `maxConcurrency 3` and 10 monitors due at once (deferred `runCheck` promises), exactly 3
    run; resolving one starts the 4th; `queued` reports the rest.
12. A timer firing while the same monitor's previous run is in flight does not start a second run.
13. `upsert` with `enabled false` and `remove` stop future runs; `upsert` with a new interval
    reschedules.
14. `stop()` clears timers (advancing time starts no new run), drops queued runs, resolves only
    after in-flight runs **and their `record`** finish, and is idempotent. `app.close()` with the
    scheduler enabled closes the DB only after `stop()` resolves.
15. A rejecting `runCheck` or throwing `record` is logged and later runs continue.

Status

16. Results `fail, fail` → monitor `degraded` (`check_results.status` `degraded`, `degraded`);
    3rd fail → `down`; next success → `up` with `consecutive_failures` 0. A new monitor is
    `pending` with `lastCheckedAt null`.
17. `record` for a deleted monitor writes nothing and does not throw.
18. `PATCH` of `url` resets status to `pending`; `PATCH` of `name` does not.

API

19. `GET …/results` returns `{ data: [] }` for a monitor without results, returns rows newest
    first, honours `limit` (default 50, max 500), and each row matches `CheckResultSchema`.
20. `limit=0`, `limit=501`, `limit=abc` → `400 VALIDATION_ERROR` with an issue at `["limit"]`;
    unknown or non-UUID id → `404` (also when the query is invalid).
21. `GET …/uptime` with no results in the window → `200` with `totalChecks 0, okChecks 0,
    uptimePercent null, latencyP50Ms null, latencyP95Ms null` for each of `24h`, `7d`, `30d`.
22. Seeded results: rows just inside and just outside the window boundary are counted/excluded
    correctly; `uptimePercent` and nearest-rank p50/p95 match hand-computed values; failures do
    not contribute latency; `window=1h` → `400` with issue at `["window"]`; default window is `24h`.
23. `POST`/`PATCH` with `status` or `lastCheckedAt` in the body → `400 VALIDATION_ERROR`.
24. `PULSE_MAX_CONCURRENCY=0`, `=65`, `PULSE_ALLOW_PRIVATE=yes` make `readConfig` throw; defaults
    are `8` and `false`. Migration `002` applies on a DB at version 1 and is recorded.

Web

25. `MonitorDetail` shows loading states, then the monitor name, a `StatusBadge` with the correct
    text for each of `pending/up/degraded/down` and `Paused` when disabled, the sparkline and the
    three uptime tiles.
26. With no results: the latency empty text and `No data` in each uptime tile are shown, and no SVG
    is rendered.
27. `LatencySparkline` renders points oldest→newest, one `failure-mark` per failed result, and an
    `aria-label` containing min/median/max/latest and the failed count.
28. A `404` shows `Monitor not found.`; another error shows an alert with Retry that refetches.
29. Clicking a monitor name in the list navigates to `#/monitors/{id}` and renders the detail view;
    `← All monitors` returns to the dashboard.

Workspace

30. `pnpm lint`, `pnpm format:check`, `pnpm -r test` and `pnpm -r build` pass; CI is green.
31. README documents the new env vars, endpoints, statuses and updated security notes.

## 7. Test plan

| Package | Tooling | Tests (file → criteria) |
| --- | --- | --- |
| shared | Vitest | `test/status.test.ts`, `test/results.test.ts`: enums, `limit` coercion and bounds, `window` enum + default, `UptimeSummarySchema` null rules, `MonitorSchema` requires `status`; create/update reject read-only fields (AC 23). |
| checker | Vitest + `node:http` on `127.0.0.1:0` + injected `resolveHost`/`fetch` | `test/address-policy.test.ts`: table-driven over every range edge, mapped IPv6, invalid input (AC 4). `test/ssrf.test.ts`: AC 1–3, 5–9; request counter on the local server proves "no request made". Existing `http-check.test.ts` passes `allowPrivate: true` and keeps all iteration-1 cases (redirect case now via manual loop). |
| api | Vitest + `inject` + `:memory:` + `vi.useFakeTimers()` | `test/scheduler.test.ts`: pure `Scheduler` with fake deps, `vi.advanceTimersByTimeAsync`, deferred promises (AC 10–15). `test/results-repository.test.ts`: state machine, deleted monitor, PATCH reset (AC 16–18). `test/results.test.ts`, `test/uptime.test.ts`: seed rows directly via `app.db`, use `vi.setSystemTime` for a fixed `to` (AC 19–22). `test/config.test.ts` (AC 24). `test/app-scheduler.test.ts`: `buildApp({ scheduler: { runCheck: fake, … } })`, POST a monitor → fake run recorded → `GET` shows status; `app.close()` order (AC 14). |
| web | Vitest + jsdom + Testing Library, fake `ApiClient` | `StatusBadge.test.tsx`, `LatencySparkline.test.tsx`, `UptimeSummary.test.tsx`, `MonitorDetail.test.tsx` (deferred promises for loading states, empty, 404, error + retry), `App.test.tsx` routing via `window.location.hash` (AC 25–29). `client.test.ts`: URL/query building and unwrap for the new methods. |

No test may make a real outbound network request: checker tests only talk to `127.0.0.1` with
`allowPrivate: true`, or use injected `resolveHost`/`fetch`. Playwright e2e remains out of scope.
