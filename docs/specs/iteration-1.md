# Pulse — Iteration 1: Foundation

- **Status:** Ready for implementation
- **Date:** 2026-10-11
- **Stack decision:** [ADR 0001](../adr/0001-stack.md)

Normative words: **MUST**, **SHOULD**, **MAY** (RFC 2119). Anything not specified here is the
implementer's choice, provided all acceptance criteria (§10) pass.

## 1. Goal and scope

Lay the foundation: a pnpm monorepo with shared zod schemas, an HTTP check engine, a REST API
with SQLite persistence and monitor CRUD, and a web dashboard that lists and adds monitors —
all type-checked, tested and built in CI.

**In scope:** workspace root scripts · `@pulse/shared` · `@pulse/checker` · `@pulse/api`
(`/health`, `/api/v1/monitors` CRUD, migrations) · `@pulse/web` (list + add form) · CI.

**Out of scope (future iterations):**

| Iteration | Topic |
| --- | --- |
| 2 | Scheduler that runs enabled monitors every `intervalSeconds` via `@pulse/checker`; persisting rows into `check_results`; `GET /api/v1/monitors/:id/results`; retention. |
| 3 | Public status pages (uptime %, latency history, incidents). |
| 4 | Authentication / admin users; CORS for non-proxied deployments. |
| 5 | Notifications (email/webhook/…), edit/delete in the UI, Playwright e2e, Docker image. |

The UI in this iteration only **lists** and **adds** monitors; the API exposes full CRUD.

## 2. Monorepo layout

```
.
├─ package.json            # name "pulse", private, type module, root scripts (§8)
├─ pnpm-workspace.yaml     # apps/*, packages/*
├─ tsconfig.base.json      # strict, NodeNext, customConditions ["source"]
├─ .github/workflows/ci.yml
├─ docs/{adr,specs}/
├─ packages/
│  ├─ shared/              # @pulse/shared  — zod schemas, types, API envelope types
│  │  └─ src/{index.ts, monitor.ts, check-result.ts, api.ts}
│  └─ checker/             # @pulse/checker — runHttpCheck()
│     └─ src/{index.ts, http-check.ts}  test/http-check.test.ts
└─ apps/
   ├─ api/                 # @pulse/api — Fastify 5 + better-sqlite3
   │  ├─ migrations/001_init.sql
   │  └─ src/{server.ts, app.ts, config.ts, db.ts, migrate.ts,
   │          monitors/{repository.ts, routes.ts}, errors.ts}
   │     test/{health.test.ts, monitors.test.ts, migrate.test.ts}
   └─ web/                 # @pulse/web — React 19 + Vite + Tailwind 4
      ├─ index.html  vite.config.ts
      └─ src/{main.tsx, App.tsx, index.css, api/client.ts,
              components/{MonitorList.tsx, AddMonitorForm.tsx}}  (+ *.test.tsx)
```

Dependency graph: `shared` ← `checker`; `shared` ← `api`; `shared` ← `web`.
(`api` does not depend on `checker` in iteration 1.) Intra-repo deps use `"workspace:*"`.
`@pulse/shared` MUST NOT import any Node built-ins (it runs in the browser).

### 2.1 Module resolution (the `source` condition)

Library packages (`@pulse/shared`, `@pulse/checker`) MUST declare:

```jsonc
{
  "name": "@pulse/shared",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "source": "./src/index.ts",
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "lint": "tsc --noEmit -p tsconfig.json",
    "test": "vitest run"
  }
}
```

Rules:

1. `"source"` MUST be the first key so it wins when the condition is active.
2. Per-package `tsconfig.json` extends `../../tsconfig.base.json`, includes `src` and `test`, and
   inherits `customConditions: ["source"]` → `tsc --noEmit` type-checks against sibling **sources**
   with no prior build.
3. Per-package `tsconfig.build.json` extends `./tsconfig.json` with `"rootDir": "src"`,
   `"outDir": "dist"`, `"include": ["src"]`, excludes tests, and sets **`"customConditions": []`**
   so emitted code type-resolves siblings via `dist/*.d.ts` (otherwise sibling `src` files would be
   pulled into the program and break `rootDir`). Consequently builds are order-dependent;
   `pnpm -r build` sorts topologically (`shared` → `checker`/`api`/`web`).
4. Relative imports in Node packages use explicit `.js` extensions (NodeNext).
5. Vitest configs in `shared`, `checker`, `api` MUST set the condition for both client and SSR
   resolution (Vitest's node environment resolves through SSR), keeping Vite's defaults:
   ```ts
   import { defineConfig } from 'vitest/config';
   import { defaultClientConditions, defaultServerConditions } from 'vite';
   export default defineConfig({
     resolve: { conditions: ['source', ...defaultClientConditions] },
     ssr: { resolve: { conditions: ['source', ...defaultServerConditions] } },
     test: { environment: 'node' },
   });
   ```
6. `apps/web/vite.config.ts` sets `resolve.conditions: ['source', ...defaultClientConditions]`
   (dev, build and Vitest share it).
7. `apps/api` dev runs sources directly: `"dev": "tsx watch --conditions=source src/server.ts"`.
   Production runs `node dist/server.js` (no condition → `dist`).
8. `apps/web/tsconfig.json` overrides the base with `"module": "ESNext"`,
   `"moduleResolution": "Bundler"`, `"lib": ["ES2023", "DOM", "DOM.Iterable"]`, `"jsx": "react-jsx"`,
   `"noEmit": true`, `"types": ["vite/client", "@testing-library/jest-dom"]` (keeps
   `customConditions`, which Bundler resolution supports). Web `build` is `vite build`.

Versions: pin at install time; required majors are Fastify 5, React 19, zod 4, Tailwind 4,
Vite ≥ 6, Vitest ≥ 3. A single `typescript` devDependency lives at the root.

## 3. Data model (`@pulse/shared`)

### 3.1 Constants

```ts
export const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;
export const MONITOR_DEFAULTS = {
  method: 'GET', intervalSeconds: 60, timeoutMs: 10_000, expectedStatus: 200, enabled: true,
} as const;
export const MONITOR_LIMITS = {
  nameMaxLength: 100, urlMaxLength: 2048, keywordMaxLength: 200,
  intervalSeconds: { min: 30, max: 86_400 },
  timeoutMs: { min: 1_000, max: 60_000 },
  expectedStatus: { min: 100, max: 599 },
} as const;
```

### 3.2 `Monitor` (resource as returned by the API)

| Field | Type | Constraints |
| --- | --- | --- |
| `id` | `string` | UUID (v4, generated server-side with `crypto.randomUUID()`). |
| `name` | `string` | Trimmed; length 1–100. |
| `url` | `string` | Absolute URL, protocol `http:` or `https:` only; length ≤ 2048. |
| `method` | `HttpMethod` | One of `HTTP_METHODS` (uppercase exact match). |
| `intervalSeconds` | `number` | Integer 30–86400. Default 60. |
| `timeoutMs` | `number` | Integer 1000–60000. Default 10000. |
| `expectedStatus` | `number` | Integer 100–599. Default 200. |
| `keyword` | `string \| null` | Always present in responses. `null` = no keyword check. Otherwise length 1–200, case-sensitive substring match. |
| `enabled` | `boolean` | Default `true`. |
| `createdAt` | `string` | ISO-8601 UTC with ms, as produced by `new Date().toISOString()` (e.g. `2026-10-11T09:30:00.000Z`). |

Cross-field rule: **`keyword` MUST be `null` when `method` is `HEAD`** (HEAD responses have no
body). Issue path `["keyword"]`, message `"keyword is not supported with HEAD"`.
No other cross-field rules: in particular `timeoutMs` vs `intervalSeconds` is **not** validated
(max timeout 60 000 ms exceeds min interval 30 000 ms; overlap handling is a scheduler concern for
iteration 2).

### 3.3 Derived schemas

| Schema | Purpose | Shape |
| --- | --- | --- |
| `MonitorSchema` | Response validation / type | All fields above, `.strict()`. |
| `MonitorCreateSchema` | `POST` body | `name`, `url` required; `method`, `intervalSeconds`, `timeoutMs`, `expectedStatus`, `enabled` optional with `.default(MONITOR_DEFAULTS.*)`; `keyword` optional, accepts `string \| null`, output normalised to `null` when omitted. `.strict()` (unknown keys, including `id`/`createdAt`, rejected). HEAD/keyword refinement applied. |
| `MonitorUpdateSchema` | `PATCH` body | Every create field optional, **no defaults**, `keyword` accepts `null` to clear. `.strict()`. Must contain ≥ 1 key (refine: path `[]`, message `"at least one field is required"`). The HEAD/keyword rule is checked by the API on the **merged** monitor (§4.6). |
| `CheckOutcomeSchema` | Result of one check (checker output) | See §3.4. |
| `CheckResultSchema` | Persisted check (iteration 2 API) | `CheckOutcome` + `id`, `monitorId`. |

Exported types:

```ts
export type HttpMethod = (typeof HTTP_METHODS)[number];
export type Monitor = z.infer<typeof MonitorSchema>;
export type MonitorCreateInput = z.input<typeof MonitorCreateSchema>;  // what clients send
export type MonitorCreate = z.output<typeof MonitorCreateSchema>;      // defaults applied
export type MonitorUpdate = z.infer<typeof MonitorUpdateSchema>;
export type CheckOutcome = z.infer<typeof CheckOutcomeSchema>;
export type CheckResult = z.infer<typeof CheckResultSchema>;
```

String fields: `name` is trimmed before length checks (`z.string().trim().min(1).max(100)`);
`url` and `keyword` are **not** trimmed (`keyword` of only whitespace is allowed but discouraged).

### 3.4 `CheckOutcome` / `CheckResult`

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | `string` UUID | *CheckResult only.* |
| `monitorId` | `string` UUID | *CheckResult only.* |
| `checkedAt` | `string` ISO-8601 | Time the request **started**. |
| `ok` | `boolean` | `true` = monitor is **up** (rules in §5.2). |
| `statusCode` | `number \| null` | Final HTTP status after redirects; `null` if no response headers were received. |
| `latencyMs` | `number` | Integer ≥ 0, ms from request start to response headers received; on failure, ms until failure. |
| `error` | `string \| null` | `null` iff `ok === true`; otherwise a human-readable reason (§5.2). |
| `keywordMatched` | `boolean \| null` | `null` if no keyword configured or the body could not be read; else whether found. |

### 3.5 API envelope types (also in `@pulse/shared`, `src/api.ts`)

```ts
export type ApiData<T> = { data: T };
export type ErrorCode =
  | 'VALIDATION_ERROR' | 'BAD_REQUEST' | 'NOT_FOUND'
  | 'UNSUPPORTED_MEDIA_TYPE' | 'INTERNAL_ERROR';
export type ApiIssue = { path: (string | number)[]; message: string; code: string };
export type ApiError = { error: { code: ErrorCode; message: string; issues?: ApiIssue[] } };
export type HealthResponse = { status: 'ok'; version: string; uptimeSeconds: number };
```

## 4. Persistence and API (`@pulse/api`)

### 4.1 Configuration (env)

| Var | Default | Notes |
| --- | --- | --- |
| `PORT` | `3000` | Integer 1–65535; invalid → exit with error. |
| `HOST` | `127.0.0.1` | Use `0.0.0.0` in containers. |
| `DATABASE_PATH` | `./data/pulse.db` | Resolved relative to the process CWD. Parent directory created if missing. `:memory:` supported (tests). |
| `LOG_LEVEL` | `info` | Fastify/pino level; tests use `silent` (logger disabled). |

`src/config.ts` parses env with zod. `src/app.ts` exports
`buildApp(opts: { databasePath: string; logger?: boolean | object }): Promise<FastifyInstance>`
which opens the DB, runs migrations, registers routes and closes the DB in an `onClose` hook.
`src/server.ts` reads config, calls `buildApp`, `listen`s, and closes on `SIGINT`/`SIGTERM`.
Tests MUST use `buildApp({ databasePath: ':memory:' })` + `app.inject()` (no network).

### 4.2 Database setup

On open: `PRAGMA foreign_keys = ON;` and, for file databases only, `PRAGMA journal_mode = WAL;`.

Storage conventions:

- Booleans → `INTEGER` `0`/`1` with `CHECK (col IN (0,1))`.
- Timestamps → `TEXT` ISO-8601 UTC (`toISOString()` output); lexical order = chronological.
- Columns are `snake_case`; `monitors/repository.ts` maps rows ⇄ camelCase `Monitor`.

### 4.3 Migrations

- Files: `apps/api/migrations/NNN_description.sql` (3-digit zero-padded, ascending). Located at
  runtime via `new URL('../migrations/', import.meta.url)` — valid from both `src/` and `dist/`.
  The `migrations/` folder MUST be included in the package (`"files": ["dist", "migrations"]`).
- Tracking table (created by the runner, not by a migration):
  ```sql
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT    NOT NULL,
    applied_at TEXT    NOT NULL
  );
  ```
- `migrate(db)` reads the directory, sorts by version, and applies each version not in
  `schema_migrations` inside **one transaction per file** (`db.transaction(() => { db.exec(sql);
  insert row })()`). A failing file rolls back and throws (server fails to start). Re-running is a
  no-op. Applied files are immutable; changes go in new files.

`migrations/001_init.sql`:

```sql
CREATE TABLE monitors (
  id               TEXT    PRIMARY KEY,
  name             TEXT    NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  url              TEXT    NOT NULL CHECK (length(url) <= 2048),
  method           TEXT    NOT NULL DEFAULT 'GET'
                   CHECK (method IN ('GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS')),
  interval_seconds INTEGER NOT NULL DEFAULT 60    CHECK (interval_seconds BETWEEN 30 AND 86400),
  timeout_ms       INTEGER NOT NULL DEFAULT 10000 CHECK (timeout_ms BETWEEN 1000 AND 60000),
  expected_status  INTEGER NOT NULL DEFAULT 200   CHECK (expected_status BETWEEN 100 AND 599),
  keyword          TEXT    NULL CHECK (keyword IS NULL OR length(keyword) BETWEEN 1 AND 200),
  enabled          INTEGER NOT NULL DEFAULT 1     CHECK (enabled IN (0,1)),
  created_at       TEXT    NOT NULL
);

CREATE INDEX idx_monitors_created_at ON monitors (created_at);

CREATE TABLE check_results (
  id              TEXT    PRIMARY KEY,
  monitor_id      TEXT    NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  checked_at      TEXT    NOT NULL,
  ok              INTEGER NOT NULL CHECK (ok IN (0,1)),
  status_code     INTEGER NULL,
  latency_ms      INTEGER NOT NULL CHECK (latency_ms >= 0),
  error           TEXT    NULL,
  keyword_matched INTEGER NULL CHECK (keyword_matched IS NULL OR keyword_matched IN (0,1))
);

CREATE INDEX idx_check_results_monitor_checked ON check_results (monitor_id, checked_at DESC);
```

`check_results` is created now but has no API in iteration 1. The DB `CHECK`s are a safety net;
zod is the primary validator (a CHECK failure surfaces as 500 and indicates a bug).

### 4.4 Conventions

- Base path `/api/v1` for resources; `/health` is unversioned.
- Success bodies use the envelope **`{ "data": ... }`** for every `/api/v1` response with a body
  (single object and lists alike). `/health` is **not** enveloped.
- Errors always use `ApiError` (§3.5), `Content-Type: application/json; charset=utf-8`.
- Request bodies for POST/PATCH MUST be `application/json`; otherwise `415 UNSUPPORTED_MEDIA_TYPE`.
- **Unknown fields are rejected** (`400 VALIDATION_ERROR`, zod `unrecognized_keys` issue). This
  includes read-only fields `id` and `createdAt`.
- Malformed JSON or an empty body sent as `application/json` → `400 BAD_REQUEST`, message
  `"Malformed JSON body"`. A POST/PATCH with no body and no content type is validated as
  `undefined` → `400 VALIDATION_ERROR`. Fastify's own errors (`FST_ERR_CTP_*`) MUST be mapped to
  these shapes in a custom `setErrorHandler`.
- `:id` that is not a UUID or does not exist → `404 NOT_FOUND`, message `"Monitor not found"`.
- Unknown routes → `404 NOT_FOUND`, message `"Route not found"` (custom `setNotFoundHandler`).
- Unhandled errors → `500 INTERNAL_ERROR`, message `"Internal server error"` (no stack in body; logged).
- Validation is done with `schema.safeParse()` in handlers (no Fastify JSON-schema for bodies), via
  a shared helper that maps zod issues to `ApiIssue` (`path` → `(string|number)[]`, `message`,
  `code`). Error `message` for validation is `"Request validation failed"`.
- No CORS in iteration 1: the web dev server proxies `/api` and `/health` (§6.5). Production
  serving of the SPA is out of scope.

### 4.5 Endpoints

| Method | Path | Request | Success | Errors |
| --- | --- | --- | --- | --- |
| GET | `/health` | — | `200` `HealthResponse` | `503` `ApiError` `INTERNAL_ERROR` if `SELECT 1` fails |
| GET | `/api/v1/monitors` | — | `200` `{ data: Monitor[] }` ordered `created_at ASC, rowid ASC`; `[]` when none | — |
| GET | `/api/v1/monitors/:id` | — | `200` `{ data: Monitor }` | `404` |
| POST | `/api/v1/monitors` | `MonitorCreateInput` | `201` `{ data: Monitor }` + header `Location: /api/v1/monitors/{id}` | `400`, `415` |
| PATCH | `/api/v1/monitors/:id` | `MonitorUpdate` (≥ 1 field) | `200` `{ data: Monitor }` (full, updated) | `400`, `404`, `415` |
| DELETE | `/api/v1/monitors/:id` | — | `204`, empty body (cascades `check_results`) | `404` |

`/health` body: `{ "status": "ok", "version": "<apps/api package.json version>", "uptimeSeconds":
<integer, floor(process.uptime())> }`.

No pagination, filtering or `PUT` in iteration 1. `createdAt` is immutable.

### 4.6 Behaviour details

- **POST:** parse with `MonitorCreateSchema` (defaults applied, `keyword` → `null` if absent),
  assign `id` and `createdAt`, insert, return the stored row mapped to `Monitor`.
- **PATCH:** 404 first if the monitor doesn't exist; then parse with `MonitorUpdateSchema`; merge
  over the existing monitor; validate the merged object with `MonitorSchema` (which carries the
  HEAD/keyword rule) and return `400` with its issues on failure; update and return. Setting
  `"keyword": null` clears it. Ordering of 404 vs 400: **404 wins** when both apply.
- Duplicate names/URLs are allowed.

### 4.7 Examples

```http
POST /api/v1/monitors
Content-Type: application/json

{ "name": "Example", "url": "https://example.com", "keyword": "Example Domain" }
```

```http
HTTP/1.1 201 Created
Location: /api/v1/monitors/5f0c7a5e-2b0e-4d0a-9a8e-0c6f2f7a1b11

{ "data": { "id": "5f0c7a5e-2b0e-4d0a-9a8e-0c6f2f7a1b11", "name": "Example",
  "url": "https://example.com", "method": "GET", "intervalSeconds": 60, "timeoutMs": 10000,
  "expectedStatus": 200, "keyword": "Example Domain", "enabled": true,
  "createdAt": "2026-10-11T09:30:00.000Z" } }
```

```http
HTTP/1.1 400 Bad Request

{ "error": { "code": "VALIDATION_ERROR", "message": "Request validation failed",
  "issues": [
    { "path": ["url"], "message": "Invalid URL", "code": "invalid_format" },
    { "path": [], "message": "Unrecognized key: \"id\"", "code": "unrecognized_keys" }
  ] } }
```

(Exact `message`/`code` strings within `issues` are whatever zod 4 emits, except the custom
messages defined in this spec; tests SHOULD assert on `path` and top-level `code`, not zod text.)

## 5. Check engine (`@pulse/checker`)

### 5.1 Contract

```ts
import type { Monitor, CheckOutcome } from '@pulse/shared';

export type HttpCheckTarget = Pick<Monitor, 'url' | 'method' | 'timeoutMs' | 'expectedStatus' | 'keyword'>;

export interface HttpCheckOptions {
  fetch?: typeof globalThis.fetch;   // injectable for tests; default globalThis.fetch
  userAgent?: string;                // default "Pulse/0.1 (+uptime-check)"
}

export function runHttpCheck(target: HttpCheckTarget, opts?: HttpCheckOptions): Promise<CheckOutcome>;
```

Behaviour:

1. **Never rejects.** All failures are reported in the outcome.
2. `checkedAt = new Date().toISOString()` and `t0 = performance.now()` taken immediately before
   `fetch`.
3. Request: `fetch(url, { method, redirect: 'follow', cache: 'no-store', signal, headers:
   { 'user-agent': userAgent } })`, no request body.
4. Timeout: an `AbortController` aborted after `timeoutMs` (via `setTimeout`, always cleared in
   `finally`). The timeout covers **headers and body read**.
5. `latencyMs = Math.round(performance.now() - t0)` measured when response headers arrive; on
   failure before headers, measured at failure.
6. If `keyword !== null`, read the body with `response.text()` and set
   `keywordMatched = body.includes(keyword)` (case-sensitive). Otherwise `keywordMatched = null`
   and the body is discarded (`response.body?.cancel()`).
7. Output is validated by type only (no runtime zod parse required).

### 5.2 Outcome rules (evaluated in this order)

| Situation | `ok` | `statusCode` | `keywordMatched` | `error` |
| --- | --- | --- | --- | --- |
| Timeout (before or during body read) | `false` | status if headers arrived, else `null` | `null` | `"timeout"` |
| Network/DNS/TLS error, invalid URL | `false` | `null` | `null` | `err.cause?.message ?? err.message` (e.g. `"connect ECONNREFUSED 127.0.0.1:1"`) |
| Body read fails (non-timeout) | `false` | status | `null` | the error message |
| `status !== expectedStatus` | `false` | status | evaluated if keyword set | `` `expected status ${expectedStatus}, got ${status}` `` |
| Keyword set and not found | `false` | status | `false` | `"keyword not found"` |
| Otherwise | `true` | status | `true` or `null` | `null` |

### 5.3 Tests

Use a local `node:http` server on port `0` (started in `beforeAll`, closed in `afterAll`) with
routes for: 200 with body containing a known keyword; 500; a 302 redirect to the 200 route; a
handler that delays longer than the timeout. Network error via an unused port (closed server).

## 6. Web (`@pulse/web`)

### 6.1 Structure

- `src/main.tsx` → renders `<App />` into `#root`, imports `index.css`
  (`@import "tailwindcss";`, Tailwind 4 via `@tailwindcss/vite`).
- `src/App.tsx` → page shell: `<header>` with `<h1>Pulse</h1>`, `<main>` containing
  `<section aria-labelledby="monitors-heading">` (`<h2 id="monitors-heading">Monitors</h2>` +
  `MonitorList`) and `<section aria-labelledby="add-heading">` (`<h2 id="add-heading">Add
  monitor</h2>` + `AddMonitorForm`). `App` owns the monitors state and passes
  `onCreated(monitor)` to the form, which appends to the list without refetch.
- State management: plain React (`useState`/`useEffect`); no data-fetching library in iteration 1.

### 6.2 API client — `src/api/client.ts`

```ts
import type { Monitor, MonitorCreateInput, MonitorUpdate, HealthResponse, ApiIssue, ErrorCode } from '@pulse/shared';

export class ApiClientError extends Error {
  constructor(
    readonly status: number,          // HTTP status, 0 for network failure
    readonly code: ErrorCode | 'NETWORK_ERROR',
    message: string,
    readonly issues: ApiIssue[] = [],
  ) { super(message); this.name = 'ApiClientError'; }
}

export interface ApiClient {
  health(): Promise<HealthResponse>;
  listMonitors(signal?: AbortSignal): Promise<Monitor[]>;
  getMonitor(id: string): Promise<Monitor>;
  createMonitor(input: MonitorCreateInput): Promise<Monitor>;
  updateMonitor(id: string, patch: MonitorUpdate): Promise<Monitor>;
  deleteMonitor(id: string): Promise<void>;
}

export function createApiClient(opts?: { baseUrl?: string; fetch?: typeof fetch }): ApiClient;
export const api: ApiClient; // createApiClient() with baseUrl "" (same origin / Vite proxy)
```

- Unwraps `{ data }`; sends `content-type: application/json` for bodies.
- Non-2xx: parses `ApiError` and throws `ApiClientError(status, code, message, issues)`; if the body
  is not an `ApiError`, `code = 'INTERNAL_ERROR'`, message `` `Request failed (${status})` ``.
- `fetch` rejection (not abort): throws `ApiClientError(0, 'NETWORK_ERROR', 'Network error')`.
  `AbortError` is re-thrown unchanged.

### 6.3 `MonitorList`

Props: `{ state: { status: 'loading' } | { status: 'error'; message: string } | { status:
'ready'; monitors: Monitor[] }; onRetry: () => void }`.

| State | Rendering |
| --- | --- |
| loading | `<p role="status">Loading monitors…</p>` |
| error | `<div role="alert">` containing `Couldn't load monitors: {message}` and a `<button>Retry</button>` calling `onRetry` |
| ready, empty | `<p>No monitors yet. Add your first one below.</p>` |
| ready, non-empty | `<table>` with `<caption class="sr-only">Monitors</caption>`, `<th scope="col">` headers **Name, URL, Method, Interval, Expected status, State**; one row per monitor in API order. Interval shown as `{n}s`; State shows text `Enabled`/`Paused` (not colour alone). URL rendered as text (not a link). |

### 6.4 `AddMonitorForm`

Props: `{ onCreated: (m: Monitor) => void; client?: ApiClient }` (defaults to `api`).

Fields (all with visible `<label htmlFor>`; ids prefixed `monitor-`):

| Label | Control | Default |
| --- | --- | --- |
| Name | `input type="text"` `required` | empty |
| URL | `input type="url"` `required` | empty |
| Method | `select` of `HTTP_METHODS` | GET |
| Check interval (seconds) | `input type="number"` min 30 max 86400 | 60 |
| Timeout (ms) | `input type="number"` min 1000 max 60000 | 10000 |
| Expected status | `input type="number"` min 100 max 599 | 200 |
| Keyword (optional) | `input type="text"` | empty |
| Enabled | `input type="checkbox"` | checked |

Behaviour:

1. `<form noValidate aria-labelledby="add-heading">`; submit button text **"Add monitor"**.
2. On submit, build `MonitorCreateInput` (numbers via `Number()`, empty keyword omitted) and
   validate client-side with `MonitorCreateSchema.safeParse`. On failure do not call the API.
3. Server `400` issues are mapped to fields by `issues[n].path[0]`; issues without a field
   key show in the form-level alert.
4. Field error: `<p id="monitor-{field}-error">` with the message; the input gets
   `aria-invalid="true"` and `aria-describedby` including that id. Errors clear for a field when it
   is edited.
5. After a failed submit, focus moves to the **first invalid field** (form order).
6. Non-validation API error / network error: `<div role="alert">` above the button with the
   message; inputs are preserved.
7. While submitting: button `disabled` and text **"Adding…"**; form `aria-busy="true"`.
8. On success: call `onCreated(monitor)`, reset fields to defaults, focus the Name input, and set
   a persistent polite live region (`<div role="status" aria-live="polite">`, rendered always, empty
   by default) to **`Monitor "{name}" added.`**
9. All controls reachable and operable by keyboard; visible focus styles (Tailwind
   `focus-visible:` ring); colour contrast ≥ 4.5:1 for text.

### 6.5 Dev server

`vite.config.ts`: React plugin, Tailwind plugin, `resolve.conditions` (§2.1), and
`server.proxy = { '/api': 'http://127.0.0.1:3000', '/health': 'http://127.0.0.1:3000' }`
(target overridable via `PULSE_API_URL` env). Vitest: `environment: 'jsdom'`,
`setupFiles: ['./src/test/setup.ts']` (imports `@testing-library/jest-dom/vitest`, runs `cleanup`).
Component tests use Testing Library + `@testing-library/user-event`, query by role/label, and inject
a fake `ApiClient` (or `fetch`) — **no network**.

## 7. Testing requirements

| Package | Tooling | Must cover |
| --- | --- | --- |
| shared | Vitest | defaults applied; each range boundary (min, max, min−1, max+1); URL protocol rejection (`ftp:`); unknown key rejection; HEAD+keyword rule; empty PATCH rejected; `keyword: null` accepted in update. |
| checker | Vitest + `node:http` | every row of §5.2 (incl. redirect followed → final status; timeout ≤ `timeoutMs` + 500 ms wall time). |
| api | Vitest + `inject` + `:memory:` | every row of §4.5 incl. errors; Location header; list ordering; PATCH merge + HEAD/keyword on merged; DELETE cascade (insert a `check_results` row directly, delete monitor, row gone); migrations idempotent and recorded in `schema_migrations`. |
| web | Vitest + jsdom + Testing Library | client: unwrap, error mapping, network error; MonitorList: all 4 states + retry; AddMonitorForm: labels, client validation + `aria-invalid`/`aria-describedby` + focus, server 400 mapping, success → `onCreated` + live region text + reset. |

## 8. Root scripts and CI

Root `package.json` scripts:

```json
{
  "build": "pnpm -r build",
  "test":  "pnpm -r test",
  "lint":  "pnpm -r lint",
  "dev":   "pnpm --parallel --filter @pulse/api --filter @pulse/web dev"
}
```

Every workspace package defines `build`, `test` (`vitest run`) and `lint`
(`tsc --noEmit -p tsconfig.json`). `pnpm test` and `pnpm lint` MUST succeed on a fresh clone after
`pnpm install` with **no** prior build. Each package's Vitest config is not type-checked by `lint`
unless included in its tsconfig (include it).

`.github/workflows/ci.yml`:

- Triggers: `push` to `main`, `develop`; `pull_request`.
- `permissions: contents: read`; `concurrency: { group: ci-${{ github.ref }}, cancel-in-progress: true }`.
- Job `ci` on `ubuntu-latest`, steps:
  1. `actions/checkout@v4`
  2. `pnpm/action-setup@v4` (version from `packageManager`)
  3. `actions/setup-node@v4` with `node-version-file: .nvmrc`, `cache: pnpm`
  4. `pnpm install --frozen-lockfile`
  5. `pnpm lint`
  6. `pnpm test`
  7. `pnpm build`

`pnpm-lock.yaml` MUST be committed.

## 9. Work breakdown (parallelisable)

| # | Task | Owner | Depends on |
| --- | --- | --- | --- |
| T1 | `@pulse/shared`: constants, schemas, types, API envelope types, tests | backend | — |
| T2 | `@pulse/checker`: `runHttpCheck` + tests | backend | T1 (types only) |
| T3 | `@pulse/api`: config, DB, migration runner, `001_init.sql`, `/health`, monitors CRUD, tests | backend | T1 |
| T4 | `@pulse/web`: Vite/Tailwind setup, API client, `MonitorList`, `AddMonitorForm`, `App`, tests | frontend | T1 (can start against this spec, mocking the client) |
| T5 | Root scripts, CI workflow, README "Getting started" + `docs/` links | either | T1–T4 |

Suggested commits: `chore: scaffold workspace`, `feat(shared): monitor and check-result schemas`,
`feat(checker): http check`, `feat(api): sqlite migrations and monitors CRUD`,
`feat(web): monitor dashboard and add form`, `ci: add lint/test/build workflow`, `docs: …`.

## 10. Acceptance criteria

Workspace

1. On a fresh clone, `pnpm install && pnpm lint && pnpm test` succeeds without running any build.
2. `pnpm build` succeeds and produces `packages/shared/dist`, `packages/checker/dist`,
   `apps/api/dist`, `apps/web/dist`; `node apps/api/dist/server.js` starts using the `dist` builds.
3. Package names are exactly `@pulse/shared`, `@pulse/checker`, `@pulse/api`, `@pulse/web`;
   library `exports` follow §2.1.

Shared

4. `MonitorCreateSchema.parse({ name: 'A', url: 'https://a.test' })` returns
   `method 'GET', intervalSeconds 60, timeoutMs 10000, expectedStatus 200, enabled true, keyword null`.
5. Values just outside every range in §3.2, non-http(s) URLs, unknown keys and HEAD+keyword are
   rejected; boundary values are accepted.

Checker

6. Against the local test server: 200 + keyword present → `ok true, error null, keywordMatched true`.
7. Status mismatch → `ok false`, `error "expected status 200, got 500"`.
8. Keyword absent → `ok false, keywordMatched false, error "keyword not found"`.
9. Slow endpoint with `timeoutMs 1000` → resolves in < 1.5 s with `ok false, error "timeout"`.
10. Connection refused → `ok false, statusCode null`, non-empty `error`; the promise never rejects.
11. `latencyMs` is a non-negative integer in all outcomes.

API

12. `GET /health` → `200 { status: "ok", version, uptimeSeconds }`.
13. `POST /api/v1/monitors` with minimal body → `201`, `Location` header equals
    `/api/v1/monitors/{data.id}`, body `data` matches `MonitorSchema` with defaults.
14. `GET /api/v1/monitors` → `200 { data: [] }` on an empty DB, and returns monitors in creation order.
15. `GET`/`PATCH`/`DELETE` with an unknown or non-UUID id → `404 { error: { code: "NOT_FOUND" } }`.
16. Invalid body, unknown field, `id` in body, or empty PATCH → `400 VALIDATION_ERROR` with
    non-empty `issues`, each having `path` and `message`.
17. PATCH `{ "method": "HEAD" }` on a monitor that has a keyword → `400` with an issue at
    `["keyword"]`; PATCH `{ "keyword": null }` clears the keyword → `200`.
18. `DELETE` → `204` with empty body; subsequent `GET` → `404`; related `check_results` rows deleted.
19. Malformed JSON → `400 BAD_REQUEST`; non-JSON content type → `415 UNSUPPORTED_MEDIA_TYPE`.
20. Running migrations twice is a no-op; `schema_migrations` contains `(1, '001_init.sql', <iso>)`.

Web

21. With the API returning monitors, the dashboard renders a table whose rows show each monitor's
    name, URL, method, interval and Enabled/Paused text; loading, empty and error (+Retry) states
    render as in §6.3.
22. Every form control is reachable by `getByLabelText` with the labels in §6.4.
23. Submitting an empty form shows errors for Name and URL, sets `aria-invalid="true"` and an
    `aria-describedby` pointing at the error text, focuses Name, and makes no API call.
24. A server `400` with an issue at `["url"]` displays that message under the URL field.
25. A successful submit calls `onCreated`, appends the monitor to the list, resets the form, and the
    `role="status"` region reads `Monitor "{name}" added.`
26. `pnpm --filter @pulse/web dev` with the API running lists monitors via the `/api` proxy with no
    CORS errors.

CI

27. `.github/workflows/ci.yml` runs install (frozen lockfile), lint, test, build on push to
    `main`/`develop` and on pull requests, and passes on the iteration-1 branch.
