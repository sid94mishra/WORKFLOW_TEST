# Pulse — Iteration 4: Auth, API keys, Docker image and operator docs

- **Status:** Ready for implementation
- **Date:** 2026-10-12
- **Builds on:** [Iteration 1 spec](iteration-1.md) (conventions in §4.4 there still apply),
  [Iteration 2 spec](check-scheduler-and-ssrf-safe-checker.md),
  [Iteration 3 spec](incidents-webhook-notifications-status-page-and-badges.md)
- **Decisions:** [ADR 0006 – Authentication, sessions and API keys](../adr/0006-authentication-sessions-and-api-keys.md),
  [ADR 0007 – Single-container deployment](../adr/0007-single-container-deployment.md)

Normative words: **MUST**, **SHOULD**, **MAY** (RFC 2119). Anything not specified here is the
implementer's choice, provided all acceptance criteria (§6) pass.

## 1. Summary

Pulse becomes safe to run for a team and easy to deploy:

- **One admin account** is created on first start from `PULSE_ADMIN_EMAIL` and
  `PULSE_ADMIN_PASSWORD`. The password is hashed with Node's built-in **scrypt** and never stored
  or logged in plain text.
- **Sessions:** `POST /api/v1/auth/login` sets a signed, `HttpOnly`, `SameSite=Lax` cookie
  (`Secure` when the request is HTTPS) that points at a row in a server-side `sessions` table.
  It expires after 7 days. `POST /api/v1/auth/logout` deletes the row. Login is rate limited to
  5 failed attempts per 15 minutes per IP + email. Unknown emails and wrong passwords cost the
  same and return the same error.
- **API keys** (`pulse_` + 32 random bytes, base64url) for scripts and CI. A key is shown once
  and stored as a SHA-256 hash. It has a `read` or `write` scope, and Pulse tracks
  `last_used_at`. Callers send `Authorization: Bearer <key>`.
- **Default-deny protection:** every `/api/v1/*` route needs a session or an API key, except
  login and the public status endpoint. `/health`, `/status` and `/badge/*` stay public.
  Cookie-authenticated state-changing requests must send `X-Pulse-CSRF` matching the session's
  token.
- **Web:** a login page, a session check on boot, logout in the header, an **API keys** settings
  page (create → show once + copy, revoke), and a redirect to login on any `401`.
- **Deploy:** a multi-stage `Dockerfile` (`node:22-alpine`, non-root, `HEALTHCHECK` on
  `/health`, `/data` volume). The API also serves the built dashboard. Plus `docker-compose.yml`,
  `.env.example` and `.dockerignore`.
- **Docs:** `docs/operations.md` (every env var, first start, backups, upgrading, reverse proxy)
  and an updated README quick start. A test keeps the docs table in sync with the code.

## 2. Scope

**In scope**

| Package / area | Work |
| --- | --- |
| `@pulse/shared` | `auth.ts` (login, session, API key schemas and constants), new error codes (§3.1). |
| `@pulse/checker` | **No changes.** |
| `@pulse/api` | Config additions; migration `005_auth.sql`; password hashing; admin bootstrap; session store; login rate limiter; API key repository; auth hook (default deny, scope, CSRF); auth and API key routes; static web serving; log redaction; tests (§3.2–§3.10). |
| `@pulse/web` | Auth-aware API client (CSRF header, 401 callback); `AuthGate` + `LoginPage`; header with user email and **Log out**; `ApiKeysView` (§4). |
| Deploy | `Dockerfile`, `.dockerignore`, `docker-compose.yml`, `.env.example`; CI lint step for the Dockerfile (§3.11). |
| Docs | `docs/operations.md`, README (quick start, API table, security notes, status line, docs links), this spec, ADRs 0006 and 0007. |

**Out of scope** (later iterations)

- More than one user, roles, user management UI, password change or reset UI. Recovery is
  documented in `docs/operations.md` (§3.12).
- SSO, OAuth/OIDC, 2FA/TOTP, WebAuthn.
- Per-resource or fine-grained API key scopes, key expiry dates, key rotation helpers.
- Durable or cross-instance rate limiting. The limiter is in-memory, like the scheduler (one
  instance per database, ADR 0003). A global per-IP cap across many emails.
- Session secret rotation (multiple signing secrets), "remember me", sliding expiry.
- Publishing images to a registry, multi-arch builds, Helm/Kubernetes manifests, TLS inside the
  container (use a reverse proxy).
- A backup CLI or scheduled backups inside Pulse.
- Running `docker build` as part of the local workflow. CI MAY build the image (§3.11).
- Playwright e2e.

## 3. API and data changes

Conventions from iteration-1 §4.4 apply: `{ data }` envelopes, `{ error: { code, message,
issues? } }`, `404 NOT_FOUND` for unknown **or non-UUID** ids, `415` for non-JSON bodies, `400
VALIDATION_ERROR` with zod `issues`. Timestamps are ISO-8601 UTC strings (`toISOString()`).
Time comes from `Date.now()` / `new Date()` so tests can use `vi.useFakeTimers()` +
`vi.setSystemTime()`. **New precedence rule:** for `/api/v1/*`, `401` beats `404`, `415` and
`400`, and `403` (scope or CSRF) beats `404`, `415` and `400`. Unauthenticated callers learn
nothing about which routes or ids exist.

### 3.1 `@pulse/shared`

`@pulse/shared` still MUST NOT import Node built-ins. Key generation and hashing live in
`@pulse/api`.

#### 3.1.1 `api.ts`

`ErrorCode` gains `'UNAUTHORIZED' | 'FORBIDDEN' | 'CSRF_FAILED' | 'RATE_LIMITED'`.

#### 3.1.2 `auth.ts` (new, re-exported from `index.ts`)

```ts
export const SESSION_COOKIE = 'pulse_session';
export const CSRF_HEADER = 'x-pulse-csrf';
export const API_KEY_PREFIX = 'pulse_';
/** `pulse_` + base64url(32 bytes) = 6 + 43 chars. */
export const API_KEY_PATTERN = /^pulse_[A-Za-z0-9_-]{43}$/;
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 604 800
export const LOGIN_MAX_FAILURES = 5;
export const LOGIN_WINDOW_SECONDS = 15 * 60; // 900
```

| Schema | Definition |
| --- | --- |
| `LoginRequestSchema` | `z.strictObject({ email: z.string().trim().toLowerCase().pipe(z.email()).max(254), password: z.string().min(1).max(1024) })`. The 1024 cap bounds hashing cost. |
| `UserSchema` | `{ id: uuid, email: string }`. |
| `SessionInfoSchema` | `{ user: UserSchema, csrfToken: string, expiresAt: iso datetime }`. |
| `ApiKeyScopeSchema` | `z.enum(['read', 'write'])`. `write` implies `read`. |
| `ApiKeySchema` | `{ id: uuid, name: string, scope: ApiKeyScope, prefix: string, createdAt: iso, lastUsedAt: iso \| null }`. `prefix` is the first 12 characters of the key (`pulse_` + 6), so people can tell keys apart. |
| `ApiKeyCreateSchema` | `z.strictObject({ name: z.string().trim().min(1).max(100), scope: ApiKeyScopeSchema.default('read') })`. The default is least privilege. |
| `ApiKeyUpdateSchema` | `z.strictObject({ name: z.string().trim().min(1).max(100) })`. Only renaming is allowed; to change the scope, create a new key. |
| `ApiKeyCreatedSchema` | `ApiKeySchema.extend({ key: z.string().regex(API_KEY_PATTERN) })`. Returned only by `POST`. |

The brief says "scopes". We model it as a single `scope` field because the two values are
ordered (`write` ⊃ `read`). A list would allow meaningless combinations such as `["write"]`
without `read`.

### 3.2 Configuration (`apps/api/src/config.ts`)

`envSchema` gains the variables below. `readConfig` maps them into `Config.auth` and
`Config.http`. Invalid values make `readConfig` throw (existing behaviour), and `server.ts` exits
non-zero with the zod message. The message MUST NOT echo the password value: map issues to
`path + message` only.

| Variable | Default | Validation / meaning |
| --- | --- | --- |
| `PULSE_ADMIN_EMAIL` | — | Optional email. Used **only** when the `users` table is empty. |
| `PULSE_ADMIN_PASSWORD` | — | Optional, 12–1024 chars. Used only with `PULSE_ADMIN_EMAIL`, and only on first start. |
| `PULSE_SESSION_SECRET` | generated | Optional, ≥ 32 chars. Signs session cookies. If unset, Pulse generates 32 random bytes on first start and stores them in `app_secrets` (§3.3), so sessions survive restarts. |
| `PULSE_COOKIE_SECURE` | `auto` | `auto` \| `true` \| `false`. `auto` sets `Secure` when `request.protocol === 'https'`. |
| `PULSE_TRUST_PROXY` | `false` | `false` \| `true` \| an integer hop count \| comma-separated IPs/CIDRs. Passed to Fastify `trustProxy`. It decides `request.ip` (rate limiting) and `request.protocol` (Secure cookie). |
| `PULSE_WEB_DIR` | unset | Optional directory with the built dashboard (`apps/web/dist`). When set, the API serves it (§3.10). The Docker image sets it to `/app/web`. |

If exactly one of `PULSE_ADMIN_EMAIL` / `PULSE_ADMIN_PASSWORD` is set, that is a config error.

`HOST`, `PORT`, `DATABASE_PATH`, `LOG_LEVEL`, `PULSE_MAX_CONCURRENCY` and `PULSE_ALLOW_PRIVATE`
are unchanged. `PULSE_API_URL` (Vite dev proxy) is unchanged.

### 3.3 Database — `apps/api/migrations/005_auth.sql`

```sql
CREATE TABLE users (
  id            TEXT PRIMARY KEY,                -- uuid
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,                   -- "scrypt$<N>$<r>$<p>$<salt b64url>$<hash b64url>"
  created_at    TEXT NOT NULL
);

CREATE TABLE sessions (
  id_hash      TEXT PRIMARY KEY,                 -- sha256 hex of the 32-byte random session id
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token   TEXT NOT NULL,                    -- base64url(32 random bytes)
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL
);
CREATE INDEX sessions_expires_at ON sessions(expires_at);

CREATE TABLE api_keys (
  id           TEXT PRIMARY KEY,                 -- uuid
  name         TEXT NOT NULL,
  scope        TEXT NOT NULL CHECK (scope IN ('read', 'write')),
  prefix       TEXT NOT NULL,                    -- first 12 chars, for display only
  key_hash     TEXT NOT NULL UNIQUE,             -- sha256 hex of the full key
  created_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at   TEXT
);

CREATE TABLE app_secrets (
  name  TEXT PRIMARY KEY,                        -- e.g. 'session_secret'
  value TEXT NOT NULL
);
```

- The DB never stores a raw session id or a raw API key. A copy of the DB file cannot be replayed
  as live credentials.
- `revoked_at` is a soft delete. Revoked keys stay for audit, never authenticate, and are hidden
  from the list.
- `app_secrets.session_secret` is only written when `PULSE_SESSION_SECRET` is unset. Operators
  must treat the DB file as sensitive (documented in `docs/operations.md`).

### 3.4 Passwords (`apps/api/src/auth/password.ts`)

- `hashPassword(plain, params?)` uses `crypto.scrypt` (async, libuv thread pool) with a 16-byte
  random salt and a 32-byte key. The default params are **N = 2^15, r = 8, p = 3** (OWASP
  equivalent, 32 MiB per hash), with `maxmem` set high enough. The output is the self-describing
  string in §3.3, so the cost can be raised later without a migration.
- `verifyPassword(plain, stored)` parses the params from `stored`, derives the key and compares
  with `crypto.timingSafeEqual`. It returns `false`, and never throws, for a malformed hash.
- `createPasswordVerifier()` precomputes a **dummy hash** at start-up with the same params. Login
  for an unknown email calls `verifyPassword(password, dummyHash)` and ignores the result. Both
  paths therefore run exactly one scrypt derivation with identical params.
- `buildApp({ auth: { scryptParams } })` MAY lower N **for tests only**. `server.ts` never
  passes it.

### 3.5 Admin bootstrap (`apps/api/src/auth/bootstrap.ts`)

`ensureAdmin(db, admin?: { email, password }) → 'created' | 'exists' | 'missing'`, called from
`buildApp` after `migrate`:

- If `users` has a row → `'exists'`. Env values are ignored. `server.ts` logs at `info`
  `"admin account exists; PULSE_ADMIN_* ignored"` when the env is set.
- If it has no rows and `admin` is given → hash the password, then `INSERT INTO users … SELECT
  … WHERE NOT EXISTS (SELECT 1 FROM users)` inside a transaction. The result is exactly one admin,
  even after repeated starts. Returns `'created'`, and the server logs `admin account created for
  <email>`.
- If it has no rows and no `admin` → `'missing'`. `server.ts` logs an error naming the two
  variables and exits with code 1. `buildApp` itself does not fail, so tests can build apps
  without an admin.

The password MUST NOT appear in any log line, error message or DB column. `buildApp` configures
the Pino `redact` paths `req.headers.authorization`, `req.headers.cookie`,
`res.headers["set-cookie"]`, `PULSE_ADMIN_PASSWORD` and `password`.

### 3.6 Sessions and login rate limiter

**Cookie.** Use `@fastify/cookie` (MIT) with `secret` = the session secret.

| Attribute | Value |
| --- | --- |
| Name / value | `pulse_session` = signed(base64url(32 random bytes)) |
| `HttpOnly` | always |
| `SameSite` | `Lax` |
| `Secure` | per `PULSE_COOKIE_SECURE` (`auto` → when `request.protocol === 'https'`) |
| `Path` | `/` |
| `Max-Age` | `604800` (and `Expires` to match) |

**SessionStore** (`apps/api/src/auth/sessions.ts`):

- `create(userId) → { id, csrfToken, expiresAt }`. It stores `sha256(id)` and sets `expires_at =
  now + 7 d` (absolute, not sliding).
- `lookup(id) → { userId, email, csrfToken, expiresAt } | undefined`. It returns `undefined` if
  `expires_at <= now`, and deletes that row.
- `revoke(id)`. `pruneExpired()` runs on start-up and then hourly, on an `unref`'d interval that
  is cleared in `onClose`.

An unsigned, tampered or unknown cookie means **no session**. If that is the only credential,
the result is `401`.

**LoginRateLimiter** (`apps/api/src/auth/rate-limit.ts`). In memory, keyed by
`${request.ip}|${normalisedEmail}`:

- It is a sliding window of failure timestamps. `check(key)` returns `{ allowed: false,
  retryAfterSeconds }` when the key has ≥ 5 failures within the last 900 s. `retryAfterSeconds` =
  seconds until the oldest one ages out, rounded up, minimum 1.
- `recordFailure(key)` is called on wrong password, unknown email and unknown user alike.
  `reset(key)` is called on a successful login.
- A `429` is **not** a failure. It does not extend the window.
- It is bounded: at most 10 000 keys. Insert order evicts the oldest key. Empty keys are pruned.

### 3.7 API keys (`apps/api/src/api-keys/`)

- Generation: `pulse_` + `randomBytes(32).toString('base64url')` (43 chars). Storage:
  `sha256(key)` hex in `key_hash`, plus `prefix = key.slice(0, 12)`.
- Authentication: the header MUST match `^Bearer (\S+)$` (scheme case-insensitive), and the
  token MUST match `API_KEY_PATTERN`. Otherwise → `401`. Look up `key_hash = sha256(token) AND
  revoked_at IS NULL`. Comparing a hash of a 256-bit random secret by index lookup leaks nothing
  useful, so no constant-time comparison is needed here.
- `last_used_at` is set to now on a successful authentication when it is `NULL` or older than
  **60 s**. This caps writes. The update runs after auth succeeds, even if the route later
  returns 4xx.
- **Scope:** a `read` key may use `GET` and `HEAD` only. Any other method → `403 FORBIDDEN`
  `"API key scope 'read' does not allow <METHOD>"`. A `write` key may use every method.
- **Key and session management needs a session:** `/api/v1/api-keys*`, `/api/v1/auth/session`
  and `/api/v1/auth/logout` return `403 FORBIDDEN` `"This endpoint requires a browser session"`
  for API key callers. A leaked key cannot mint more keys.

### 3.8 Auth hook (`apps/api/src/auth/plugin.ts`)

The hook is registered at the root as an `onRequest` hook, **before** any route plugin. It runs
for every request, including unmatched ones (so `401` beats `404`).

1. **Public?** If the path does not start with `/api/v1/`, the request passes (health, status
   HTML, badges, static web and unknown non-API paths keep their current behaviour). Under
   `/api/v1/`, a route is public **only** if it is registered with `config: { public: true }`.
   Today those are `POST /api/v1/auth/login` and `GET /api/v1/status`. Route config is read
   from `request.routeOptions.config`, so an unmatched `/api/v1/*` URL is protected.
2. **Bearer.** If an `Authorization` header is present, it is the only credential that counts
   (cookies are ignored). Invalid, unknown or revoked → `401`. Valid → `request.auth = { kind:
   'apiKey', keyId, scope }`, then the scope check (§3.7).
3. **Cookie.** Otherwise, a valid session gives `request.auth = { kind: 'session', userId,
   email, csrfToken, sessionId }`. For `POST`, `PUT`, `PATCH` and `DELETE`, the
   `x-pulse-csrf` header MUST equal `csrfToken` (`timingSafeEqual` on equal-length buffers;
   length mismatch → fail). On failure → `403 CSRF_FAILED` `"Missing or invalid CSRF token"`.
4. **Neither** → `401 UNAUTHORIZED` `"Authentication required"`, with header `WWW-Authenticate:
   Bearer realm="pulse"`.

Errors use `apiError` (JSON `{ error }`). `request.auth` is declared on `FastifyRequest` via
module augmentation. Route modules MUST NOT add their own allow-lists. Making a route public is
done only with `config.public`, so a new route is protected by default.

### 3.9 Routes

#### 3.9.1 Auth (`apps/api/src/auth/routes.ts`)

| Method | Path | Auth | Request | Responses |
| --- | --- | --- | --- | --- |
| `POST` | `/api/v1/auth/login` | public | `LoginRequest` (JSON) | `200 { data: SessionInfo }` + `Set-Cookie`; `400` invalid body; `401 UNAUTHORIZED "Invalid email or password"`; `429 RATE_LIMITED "Too many login attempts; try again later"` + `Retry-After: <s>` |
| `POST` | `/api/v1/auth/logout` | session + CSRF | none | `204`, deletes the session row, and `Set-Cookie: pulse_session=; Max-Age=0` |
| `GET` | `/api/v1/auth/session` | session | — | `200 { data: SessionInfo }` (the web app reads the CSRF token here after a reload) |

Login order: validate the body → `limiter.check` (if blocked → 429, with **no** hashing) → look
up the user by email → `verifyPassword` against the user's hash or the dummy hash → on failure,
`recordFailure` + `401`. On success, `reset` + `sessions.create` + cookie. The `401` body is
byte-identical for an unknown email and a wrong password. A login with an existing valid cookie
creates a new session and leaves the old one alone.

#### 3.9.2 API keys (`apps/api/src/api-keys/routes.ts`) — session only

| Method | Path | Request | Responses |
| --- | --- | --- | --- |
| `GET` | `/api/v1/api-keys` | — | `200 { data: ApiKey[] }`, non-revoked, newest first |
| `POST` | `/api/v1/api-keys` | `ApiKeyCreate` | `201 { data: ApiKeyCreated }` + `Location: /api/v1/api-keys/:id`, and `Cache-Control: no-store`. This is the **only** response that contains `key`. |
| `GET` | `/api/v1/api-keys/:id` | — | `200 { data: ApiKey }`; `404` for unknown, revoked or non-UUID ids |
| `PATCH` | `/api/v1/api-keys/:id` | `ApiKeyUpdate` | `200 { data: ApiKey }`; `404`; `400` |
| `DELETE` | `/api/v1/api-keys/:id` | — | `204`, sets `revoked_at`. Takes effect on the next request. `404` if unknown or already revoked. |

Example:

```http
POST /api/v1/api-keys
Cookie: pulse_session=…
X-Pulse-CSRF: 9r…
Content-Type: application/json

{ "name": "CI", "scope": "read" }

201 { "data": { "id": "6f1c…", "name": "CI", "scope": "read", "prefix": "pulse_Q2xh4F",
                "createdAt": "2026-10-12T09:00:00.000Z", "lastUsedAt": null,
                "key": "pulse_Q2xh4F…(43 chars after the prefix)" } }
```

#### 3.9.3 Endpoint protection summary

| Path | Access |
| --- | --- |
| `GET /health` | public |
| `GET /status`, `GET /api/v1/status`, `GET /badge/:file` | public (unchanged output) |
| `POST /api/v1/auth/login` | public (rate limited) |
| `GET /api/v1/auth/session`, `POST /api/v1/auth/logout`, `/api/v1/api-keys*` | session only (+ CSRF for writes) |
| every other `/api/v1/*` (monitors, results, uptime, incidents, channels, deliveries, test) | session (+ CSRF for writes) **or** API key (scope rules) |
| `/`, `/assets/*` (when `PULSE_WEB_DIR` is set) | public static files, which contain no data |

### 3.10 Wiring (`apps/api/src/app.ts`, `server.ts`)

- `buildApp` gains `auth?: { admin?: { email: string; password: string }; sessionSecret?:
  string; cookieSecure?: 'auto' | boolean; scryptParams?: ScryptParams }`, `trustProxy?:
  FastifyServerOptions['trustProxy']` and `webDir?: string`. Order: open DB → migrate →
  resolve the session secret (option → `app_secrets` → generate and store) → `ensureAdmin` →
  Fastify with `trustProxy` and the logger `redact` → `@fastify/cookie` → auth hook → routes. The
  bootstrap result is exposed as `app.adminBootstrap` so `server.ts` can act on it.
- There is **no** option that turns auth off. Tests authenticate via helpers (§7).
- **Static web** (when `webDir` is set): `@fastify/static` (MIT) serves `webDir` at `/`, with
  `index.html` for `/`. Files under `/assets/` get `Cache-Control: public, max-age=31536000,
  immutable`. `index.html` gets `no-cache`. HTML responses SHOULD carry
  `Content-Security-Policy: default-src 'self'; img-src 'self' data:; style-src 'self';
  frame-ancestors 'none'`. The status page keeps its own CSP from ADR 0005. Every response
  SHOULD carry `X-Content-Type-Options: nosniff`. The dashboard uses hash routing, so there is no
  SPA fallback: unknown paths stay `404` JSON.
- `server.ts` passes the config through and handles `adminBootstrap === 'missing'` (exit 1). It
  logs a `warn` when `PULSE_COOKIE_SECURE=false`, or when `HOST` is not loopback and
  `PULSE_TRUST_PROXY=false` with `PULSE_COOKIE_SECURE=auto`: "cookies will not be Secure unless
  served over HTTPS".
- New runtime dependencies for `@pulse/api`: `@fastify/cookie` and `@fastify/static`, both MIT
  and from the Fastify org. Passwords, rate limiting and CSRF use Node built-ins only. No other
  runtime dependency is added.

### 3.11 Deploy files (repo root)

**`Dockerfile`** — multi-stage, every stage `FROM node:22-alpine` (pinned to a minor tag such as
`node:22.20-alpine` is RECOMMENDED):

1. `base`: `corepack enable` and `WORKDIR /repo`.
2. `build`: `apk add --no-cache python3 make g++`. This is the fallback in case the
   better-sqlite3 prebuild for musl is missing. Copy the manifests (`package.json`,
   `pnpm-lock.yaml`, `pnpm-workspace.yaml`, each package's `package.json`), run
   `pnpm install --frozen-lockfile`, copy the sources, run `pnpm -r build`, then `pnpm --filter
   @pulse/api deploy --prod --legacy /out`. The `--legacy` flag lets pnpm 10 deploy without
   `inject-workspace-packages`; if the implementer enables injection instead, this note must be
   updated. Then copy `apps/web/dist` → `/out/web`.
3. `runtime`: copy `/out` to `/app` (owned by `node`), and run `mkdir -p /data && chown
   node:node /data`. Set `ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
   DATABASE_PATH=/data/pulse.db PULSE_WEB_DIR=/app/web`, `VOLUME ["/data"]`, `EXPOSE 3000` and
   `USER node`. Add `HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD
   ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]`
   and `CMD ["node", "dist/server.js"]`. The runtime stage has no build toolchain and no dev
   dependencies. The `migrations/` folder is included via the api `files` field.

**`.dockerignore`** is an **allow-list**: `*` first, then `!` entries for `package.json`,
`pnpm-lock.yaml`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.npmrc` (if any), `apps/*/`,
`packages/*/`. Then re-exclude `**/node_modules`, `**/dist`, `**/data`, `**/*.db*`, `**/test`,
`**/*.test.*` and `**/.env*`. Files that are not part of the build can never enter the context.

**`docker-compose.yml`**: one `pulse` service (`build: .`, `image: pulse:local`, `ports:
["3000:3000"]`, `restart: unless-stopped`). It has `environment` with
`PULSE_ADMIN_EMAIL: ${PULSE_ADMIN_EMAIL:?set in .env}` and
`PULSE_ADMIN_PASSWORD: ${PULSE_ADMIN_PASSWORD:?set in .env}`, plus commented examples for every
other variable. It also has the named volume `pulse-data:/data`.

**`.env.example`** holds placeholders only (`PULSE_ADMIN_EMAIL=admin@example.com`,
`PULSE_ADMIN_PASSWORD=change-me-to-12+-chars`, …) and **no real secret**. It is already
allowed by `.gitignore`.

**CI** (`.github/workflows/ci.yml`): add a step that lints the Dockerfile with
`hadolint/hadolint-action@v3` (GPL-3.0, free). The repo has no Dockerfile linter today, and this
becomes "the repo's tooling". Fix every finding, or ignore it inline with a justification. CI
SHOULD also run `docker build .` without pushing. That build is not required locally.

### 3.12 Docs

**`docs/operations.md`** (new) has these sections:

1. **Configuration.** One Markdown table with columns `Variable | Default | Description`. It has
   one row per variable, written as `` `NAME` ``. It covers **every** `PULSE_*` name used in the
   code (including `PULSE_API_URL`, marked dev-only) plus `HOST`, `PORT`, `DATABASE_PATH`,
   `LOG_LEVEL` and `NODE_ENV`.
2. **First start.** Set the admin env, start (compose or `node`), log in. Explain that the env is
   ignored once an admin exists, and that a missing env on an empty DB means exit code 1.
3. **Backups.** The DB is in WAL mode, so copying only `pulse.db` while Pulse runs is unsafe.
   Give an online backup with `sqlite3 /data/pulse.db ".backup '/data/pulse-backup.db'"` via a
   throwaway `alpine` container with `apk add sqlite` on the same volume. The offline
   alternative: stop, then copy `pulse.db*`. Explain how to restore. The DB contains hashed
   credentials and possibly the generated session secret, so store backups privately.
4. **Upgrading.** Back up → pull/rebuild → restart. Migrations apply automatically and are
   forward-only. There is no downgrade without the backup.
5. **Reverse proxy.** Terminate TLS at the proxy and set `PULSE_TRUST_PROXY` (hop count or proxy
   IP) so `Secure` cookies and per-IP rate limiting work. Forward `X-Forwarded-For` and
   `X-Forwarded-Proto`. Include Caddy and nginx snippets. Run a single instance per DB (ADR 0003).
   Do not expose the container port directly to the internet without TLS.
6. **Account recovery.** Stop Pulse, run `DELETE FROM users;` with the sqlite3 CLI (this cascades
   to sessions; API keys survive), then start again with new `PULSE_ADMIN_*` values.
7. **Security checklist.** Strong admin password, HTTPS, least-privilege `read` keys for
   dashboards and CI, revoke unused keys, `PULSE_ALLOW_PRIVATE` off.

**README**: update the status line to Iteration 4. Add a "Quick start (Docker)" section
(`cp .env.example .env`, edit, `docker compose up -d`, open `http://localhost:3000`, log in).
The dev quick start now sets `PULSE_ADMIN_EMAIL` / `PULSE_ADMIN_PASSWORD`. Add an
authentication section: cookie + CSRF for the browser, `curl -H "Authorization: Bearer
pulse_…"` for scripts. Add the new endpoints to the API table and the new error codes. Rewrite
the security notes: remove "no authentication" and keep the SSRF and single-instance notes.
Channel URLs are now readable only by authenticated users. The env table moves to
`docs/operations.md`; the README links to it and keeps one sentence that names
`PULSE_MAX_CONCURRENCY` and `PULSE_ALLOW_PRIVATE`. Add docs links for the iteration 4 spec,
`operations.md`, and ADRs 0004–0007.

## 4. UI changes (`@pulse/web`)

The existing styling (Tailwind, slate/blue palette, focus rings) and component patterns (an
injected `client`, a deferred-promise-friendly state machine of `loading | ready | error`) apply.

### 4.1 API client (`src/api/client.ts`)

- `createApiClient({ baseUrl, fetch, onUnauthorized? })`. The client keeps a private
  `csrfToken`, set by `login` and `getSession` and cleared by `logout` and on `401`.
- For `POST`, `PUT`, `PATCH` and `DELETE`, it sends header `x-pulse-csrf: <token>` when a token
  is known. Every request uses `credentials: 'same-origin'`.
- On a `401` from any call **except** `login`, it clears the token, calls `onUnauthorized()`, and
  throws `ApiClientError(401, 'UNAUTHORIZED', …)`. `login`'s 401 just throws, so the form can
  show "Invalid email or password".
- `ApiClientError` gains an optional `retryAfterSeconds` (from `Retry-After` on 429).
- New methods: `getSession()`, `login(email, password)`, `logout()`, `listApiKeys()`,
  `createApiKey(input) → ApiKeyCreated`, `renameApiKey(id, name)` and `revokeApiKey(id)`. Types
  come from `@pulse/shared` via `src/api/types.ts`.

### 4.2 `AuthGate` (`src/components/AuthGate.tsx`) and `App`

- `App` wraps its content in `AuthGate`. On mount, `AuthGate` calls `getSession()` and shows
  `Loading…` (`role="status"`) until it gets one of:
  - `200` → `authenticated(session)`. It renders the app and provides `session` (email) to the
    header.
  - `401` → `anonymous`. It renders `LoginPage`.
  - any other error → an alert with **Retry**.
- `onUnauthorized` (wired when `App` creates or receives its client) switches the gate to
  `anonymous` from anywhere. It keeps `window.location.hash`, so after login the user lands on
  the same route. Data components need no 401 handling of their own.

### 4.3 `LoginPage` (`src/components/LoginPage.tsx`)

- A heading **Sign in to Pulse**. A form with labelled **Email** (`type="email"`,
  `autocomplete="username"`) and **Password** (`type="password"`,
  `autocomplete="current-password"`) fields, both required, and a submit button **Sign in**.
- While submitting, the button shows **Signing in…** and the fields and button are disabled.
- Errors render in a `role="alert"`:
  - 401 → **Invalid email or password**
  - 429 → **Too many attempts. Try again in N minutes.** (N = `ceil(retryAfterSeconds / 60)`,
    or "later" if unknown)
  - network/other → **Could not sign in. Check your connection and try again.**
  
  Focus moves to the alert. The password field is cleared on failure.
- On success, it calls `onLoggedIn(session)`.

### 4.4 Header

The header shows the signed-in email and a **Log out** button. While logging out, the button is
disabled and reads **Logging out…**. On success, or on a 401, the gate goes to `anonymous`. On
another error, a `role="alert"` shows "Could not log out" and the user stays signed in. Add
**API keys** (`#/settings/api-keys`) to `NAV`. `useHashRoute` gains `{ name: 'apiKeys' }`.

### 4.5 `ApiKeysView` (`src/components/ApiKeysView.tsx`)

- **List:** shows loading, empty ("No API keys yet.") and error (alert + **Retry**) states.
  `ready` shows a table with columns Name, Scope (`Read only` / `Read & write`), Key (`prefix…`
  in monospace), Created, and Last used (relative time, or **Never**).
- **Create form:** **Name** (required, max 100), **Scope** radios (default **Read only**), and
  **Create key**.
  - While submitting, it shows **Creating…** and is disabled.
  - A `400` at `["name"]` shows under the field with `aria-invalid`. Other errors show in an
    alert.
  - On success, the new row is prepended and a **one-time panel** (`role="region"`,
    `aria-label="New API key"`) appears. The panel says "Copy this key now. You won't be able to
    see it again." and shows the key in a read-only, monospace, select-all input. It has a
    **Copy** button (`navigator.clipboard.writeText`) that switches to **Copied** for 2 s, or
    shows "Copy failed — select and copy manually" if the clipboard is unavailable. A **Done**
    button removes the panel and drops the key from state. The key is never written to
    `localStorage`, the URL or the console.
- **Revoke:** each row has a **Revoke** button. It asks for confirmation inline ("Revoke
  <name>? Apps using it will stop working." with **Revoke key** / **Cancel**). While revoking,
  the button shows **Revoking…**. On success the row is removed. On error, an alert appears and
  the row stays.

## 5. Work breakdown

| # | Task | Owner | Depends on |
| --- | --- | --- | --- |
| B1 | `@pulse/shared`: `auth.ts` schemas/constants, new `ErrorCode`s + tests | backend | — |
| B2 | `@pulse/api`: config vars (§3.2) + `config.test.ts` cases; migration `005` + migrate test | backend | B1 |
| B3 | `@pulse/api`: `password.ts` (scrypt hash/verify, dummy hash) + `bootstrap.ts` (`ensureAdmin`) + session secret resolution + log redaction + tests | backend | B2 |
| B4 | `@pulse/api`: `SessionStore`, `LoginRateLimiter`, `@fastify/cookie`, auth routes (login/logout/session) + tests | backend | B3 |
| B5 | `@pulse/api`: auth `onRequest` hook (default deny, `config.public`, bearer/cookie, scope, CSRF, 401-before-404) and the test helpers; migrate **all existing API tests** to the helpers | backend | B4 |
| B6 | `@pulse/api`: API key repository + routes (session only, show once, hash, `last_used_at` throttle, revoke) + tests | backend | B5 |
| B7 | `@pulse/api`: `@fastify/static` web serving behind `webDir`, security headers, `server.ts` bootstrap/exit and warnings + tests | backend | B5 |
| B8 | Deploy: `Dockerfile`, `.dockerignore`, `docker-compose.yml`, `.env.example`, hadolint CI step (+ optional build job), Dockerfile invariants test | backend | B7 |
| B9 | Docs: `docs/operations.md`, README updates, env-var sync test, `documentation.test.ts` updates | backend | B2, B8 |
| F1 | Client: CSRF header, `onUnauthorized`, `retryAfterSeconds`, auth + API key methods, types + tests | frontend | B1 (can mock) |
| F2 | `AuthGate` + `LoginPage` + header email/logout + 401 redirect; update fake clients in existing tests | frontend | F1 |
| F3 | `ApiKeysView` + route/nav + tests | frontend | F1 |

Suggested commits: `feat(shared): auth and api key schemas`, `feat(api): auth config and
migration 005`, `feat(api): scrypt passwords and admin bootstrap`, `feat(api): sessions and
rate-limited login`, `feat(api): default-deny auth hook with csrf`, `test(api): authenticate
existing suites`, `feat(api): api keys`, `feat(api): serve dashboard from api`, `build: docker
image and compose`, `docs: operations guide and quick start`, `feat(web): auth-aware api
client`, `feat(web): login and logout`, `feat(web): api keys settings`.

## 6. Acceptance criteria

Admin and passwords

1. Starting with an empty DB and `PULSE_ADMIN_EMAIL=Admin@Example.com` +
   `PULSE_ADMIN_PASSWORD=<p>` creates exactly one `users` row (`email` stored lower-cased).
   `password_hash` starts with `scrypt$` and does not contain `<p>`. Building the app again on the
   same DB file, with the same or a different admin env, leaves exactly one row with the original
   hash (`adminBootstrap === 'exists'`). An empty DB without admin env → `'missing'`, and
   `server.ts` exits 1 (tested by calling the extracted `start()` with an injected `exit`). Only
   one of the two variables set → config error.
2. The password never leaks: with a captured Pino stream, building the app, a successful login,
   a failed login and a config validation error produce no log line or error message that
   contains the password. No DB column contains it, checked by scanning every text column of
   every table.
3. Unknown email vs wrong password: both return `401` with **byte-identical** bodies and the same
   headers (except `date`/`content-length`). `verifyPassword` is called exactly **once** in each
   case, with the same scrypt params (spy). With default params, the median of 5 timed attempts
   for each path differs by less than 50% (a loose guard against a missing dummy-hash path).
   `verifyPassword` uses `timingSafeEqual` and returns `false` on a malformed stored hash.

Sessions

4. A successful login → `200 { data: SessionInfo }` (validates against `SessionInfoSchema`). The
   `Set-Cookie` for `pulse_session` has `HttpOnly`, `SameSite=Lax`, `Path=/` and
   `Max-Age=604800`. Its value is signed: `unsignCookie` succeeds with the secret, and changing one
   character makes the next request `401`. `Secure` is absent over HTTP with `auto`, and present
   with `x-forwarded-proto: https` + `trustProxy: true`, and with `cookieSecure: true`. The
   `sessions` table holds `sha256(id)`, not the raw id.
5. With the cookie, `GET /api/v1/monitors` → `200`. After `POST /api/v1/auth/logout` (with CSRF)
   → `204`, a `Max-Age=0` cookie is set, the row is gone, and replaying the **old** cookie → `401`.
6. Fake clock: a session is accepted at `created + 7 d − 1 s` and rejected (`401`, row deleted) at
   `created + 7 d`. `pruneExpired` removes expired rows only. Sessions survive an app restart on
   the same DB file when the generated secret is reused from `app_secrets`. Setting a different
   `PULSE_SESSION_SECRET` invalidates them.

Rate limiting

7. For one IP + email, 5 failed logins → `401` each. The 6th attempt within 15 min → `429
   RATE_LIMITED` with `Retry-After` ≥ 1, **even with the correct password**, and `verifyPassword`
   is not called. The same email from another IP (`remoteAddress` in `inject`), and another email
   from the same IP, are still allowed. After advancing the fake clock past the oldest failure +
   900 s, a login is allowed again. 429s do not extend the window. A successful login resets the
   counter. The limiter never holds more than 10 000 keys.

API keys

8. `POST /api/v1/api-keys` (session + CSRF) → `201` with `key` matching `API_KEY_PATTERN`, and
   `prefix === key.slice(0, 12)`. `GET` list/one never includes `key`. The DB `key_hash` equals
   `sha256(key)` hex, and no column contains the raw key. `scope` defaults to `read`. The name
   rules and unknown fields → `400`.
9. `Authorization: Bearer <key>` authenticates. `lastUsedAt` goes from `null` to the request
   time. A second use 30 s later (fake clock) leaves it unchanged, and a use 61 s later updates
   it.
10. A `read` key: `GET /api/v1/monitors` → `200`. `POST`/`PATCH`/`DELETE` on monitors and
    channels, and `POST /api/v1/channels/:id/test`, → `403 FORBIDDEN`, with no DB change. A
    `write` key can create, update and delete a monitor. Any key on `/api/v1/api-keys*`,
    `/api/v1/auth/session` or `/api/v1/auth/logout` → `403`.
11. After `DELETE /api/v1/api-keys/:id` → `204`, that key → `401`, the key disappears from the
    list, and the row has `revoked_at` set. A second `DELETE` → `404`. Malformed bearer tokens
    (`Bearer`, `Bearer abc`, `Basic …`, a valid-looking but unknown key) → `401`. A bad bearer
    plus a valid cookie → `401`, because the bearer takes precedence.

Protection and CSRF

12. **Route sweep:** a test collects every registered route through an `onRoute` hook. Each
    route not in the public allow-list (`/health`, `/status`, `/api/v1/status`, `/badge/*`,
    `POST /api/v1/auth/login`, static files) is called **without credentials**, with its
    method, path params filled with a random UUID, and an empty JSON body. Each returns `401`
    with a JSON `{ error: { code: 'UNAUTHORIZED' } }` body. Unknown `/api/v1/nope` → `401`. A new
    route added without `config.public` therefore fails closed.
13. `/health`, `/status`, `/api/v1/status` and `/badge/{publicId}.svg` return their iteration-3
    responses without credentials. The iteration-3 status/badge tests pass unchanged apart from
    the helper import.
14. A cookie-authenticated `POST /api/v1/monitors` without `x-pulse-csrf` → `403 CSRF_FAILED`. With
    the wrong token, or a token of a different length → `403`. With the correct token → `201`.
    `GET`s need no CSRF header. API key requests need none. Login needs none.

Web

15. `client.test.ts`: the CSRF header is sent on mutating requests after `login`/`getSession`
    and not on `GET`. A `401` calls `onUnauthorized` once and throws `UNAUTHORIZED`. `login`'s 401
    does not call `onUnauthorized`. `Retry-After` maps to `retryAfterSeconds`. The URLs, methods
    and bodies of the new methods are correct.
16. `AuthGate`/`LoginPage`: loading state, then the login page when `getSession` → 401. Submit
    shows **Signing in…** with disabled controls. 401 → "Invalid email or password" alert, the
    password is cleared, and focus is on the alert. 429 → "Too many attempts. Try again in 15
    minutes." when `retryAfterSeconds=900`. Success → the dashboard renders, and the header shows
    the email. A later `401` from any data call (fake client triggers `onUnauthorized`) → the
    login page, and the hash route is kept. **Log out** → `Logging out…`, then the login page.
17. `ApiKeysView`: loading, empty and error + Retry states. Create shows **Creating…**, then the
    one-time panel with the key and a prepended row. **Copy** calls the stubbed
    `navigator.clipboard.writeText(key)` and shows **Copied**. A clipboard rejection shows the
    fallback text. **Done** removes the key from the DOM. A `400` at `["name"]` shows under the
    field with `aria-invalid`. Revoke needs confirmation, shows **Revoking…**, and removes the
    row. A revoke error shows an alert and keeps the row. `#/settings/api-keys` renders the view
    with `aria-current="page"` on its nav link.

Deploy and docs

18. Dockerfile invariants (a Vitest test that parses the `Dockerfile` as text): every `FROM` is
    `node:22…-alpine`, there are ≥ 2 stages, the final stage has `USER` other than root, plus
    `HEALTHCHECK` referencing `/health`, `VOLUME` containing `/data`,
    `DATABASE_PATH=/data/pulse.db`, `EXPOSE 3000`, and no `ARG`/`ENV` whose name contains
    `PASSWORD` or `SECRET`. `.dockerignore` starts with `*` and excludes `**/node_modules` and
    `**/.env*`. `docker-compose.yml` mounts a volume at `/data` and requires both admin vars. The
    hadolint step passes in CI.
19. Env-docs sync: a test scans the sources (`apps/*/src/**`, `packages/*/src/**`,
    `apps/web/vite.config.ts`, `Dockerfile`, `docker-compose.yml`, `.env.example`) for
    `/\bPULSE_[A-Z0-9_]+\b/`. It asserts that each name has a row in the configuration table of
    `docs/operations.md`, and that every `PULSE_*` row in that table appears in the code (no
    stale rows). The table also has rows for `HOST`, `PORT`, `DATABASE_PATH` and `LOG_LEVEL`.
    `docs/operations.md` has the sections listed in §3.12. `documentation.test.ts` asserts that
    the README quick start (`docker compose up`, `PULSE_ADMIN_EMAIL`, `Authorization: Bearer`,
    and a link to `docs/operations.md`) is present, and keeps the iteration 2/3 assertions
    (strings may now be satisfied by README **or** `operations.md` where moved).

Workspace

20. `pnpm lint`, `pnpm format:check`, `pnpm -r test` and `pnpm -r build` pass, and CI is green.
    The only new runtime dependencies are `@fastify/cookie` and `@fastify/static` (MIT). No real
    secret is committed: `.env.example` holds placeholders only, and tests generate their
    credentials at runtime. No test makes a real outbound request.

## 7. Test plan

**Test helpers** (`apps/api/test/helpers/auth.ts`). Existing suites are migrated to these
helpers, with no behaviour change to their assertions:

- `buildTestApp(opts)` calls `buildApp` with `scryptParams: { N: 2 ** 10, r: 8, p: 1 }`, a fixed
  test admin generated at runtime, and a random `sessionSecret`. It returns `{ app, inject }`.
  `inject` merges `authorization: Bearer <write key>` from a key seeded via
  `ApiKeyRepository.create`.
- `loginCookie(app) → { cookie, csrfToken }` performs a real login.
- `seedKey(app, scope) → key`.

| Package | Tooling | Tests (file → criteria) |
| --- | --- | --- |
| shared | Vitest | `test/auth.test.ts`: login email normalisation/limits, `ApiKeyCreate` default scope and strictness, `API_KEY_PATTERN` accepts generated-shape keys and rejects others, `ApiKeyCreated` includes `key`, and `ApiKey` does not. |
| api | Vitest + `inject` + `:memory:` / temp-file DB + `vi.useFakeTimers()`/`vi.setSystemTime()` | `test/config.test.ts` (new vars, pair rule, no password in errors). `test/migrate.test.ts` (005 on a v4 DB). `test/password.test.ts` (round trip, wrong password, malformed hash, params encoded). `test/admin-bootstrap.test.ts` (AC 1–2, temp-file DB for restart, captured log stream). `test/auth-login.test.ts` (AC 3–7, `remoteAddress` per IP). `test/auth-protection.test.ts` (AC 12–14, route sweep). `test/api-keys.test.ts` (AC 8–11). `test/static-web.test.ts` (temp `webDir` with `index.html` + `assets/x.js`: served, cache headers, CSP, unknown path 404, not served when unset). `test/server-start.test.ts` (`'missing'` → exit 1, warnings). `test/deploy-files.test.ts` (AC 18). `test/operations-docs.test.ts` (AC 19). `test/documentation.test.ts` updated. All existing suites go through `buildTestApp`. |
| web | Vitest + jsdom + Testing Library + `user-event`, fake `ApiClient`, deferred promises | `client.test.ts` (AC 15, mocked `fetch` returning `Response` objects). `AuthGate.test.tsx` + `LoginPage.test.tsx` (AC 16). `ApiKeysView.test.tsx` (AC 17, stubbed `navigator.clipboard`, fake timers for **Copied** reset). `App.test.tsx` (nav + header + route). The fake clients in existing component tests gain `getSession` and the new methods. |
| deploy | CI | hadolint step. Optional `docker build .` job (no push). |

No test may make a real outbound network request (unchanged from iteration 3). Timing-sensitive
assertions (AC 3) use generous bounds and the deterministic spy is the primary check. Playwright
e2e remains out of scope.
