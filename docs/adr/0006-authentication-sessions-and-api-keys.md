# ADR 0006: Server-side sessions, scrypt passwords and hashed API keys behind a default-deny hook

- **Status:** Accepted
- **Date:** 2026-10-12
- **Deciders:** Pulse maintainers
- **Related:** [Iteration 4 spec §3.3–§3.9](../specs/auth-api-keys-docker-image-and-operator-docs.md#3-api-and-data-changes),
  [ADR 0001](0001-stack.md), [ADR 0003](0003-in-process-scheduler.md),
  [ADR 0005](0005-public-status-page-and-badges.md)

## Context

Until now the API has been unauthenticated. Anyone who can reach it can change monitors and read
channel URLs, and those URLs can contain tokens. Iteration 4 must protect it for a small team.
Forces:

- Two kinds of client: the dashboard in a browser (same origin) and scripts/CI (headers, no
  cookies).
- Logout and revocation must take effect immediately.
- One Node process and one SQLite file (ADR 0001/0003). No Redis, no external identity provider,
  free/open-source only.
- Alpine container images (ADR 0007) make native addons such as `argon2` a build and maintenance
  cost.
- Public endpoints (`/status`, `/api/v1/status`, `/badge/*`, `/health`) must stay public (ADR 0005).
- A newly added route must not be accidentally public.

## Decision

1. **Opaque server-side sessions in SQLite.** The cookie carries a 32-byte random id, signed with
   `@fastify/cookie`. The `sessions` table stores `sha256(id)`, the user, a per-session CSRF
   token and an absolute 7-day expiry. Logout deletes the row. Cookie: `HttpOnly`,
   `SameSite=Lax`, `Path=/`, and `Secure` when the request is HTTPS (or forced by
   `PULSE_COOKIE_SECURE`). The signing secret comes from `PULSE_SESSION_SECRET`. If that is
   unset, Pulse generates it once and stores it in `app_secrets`.
2. **scrypt from `node:crypto`** for the admin password (N = 2^15, r = 8, p = 3, 16-byte salt,
   32-byte key). It is stored as a self-describing string so parameters can be raised later.
   Comparison uses `timingSafeEqual`. Unknown emails are verified against a precomputed dummy
   hash, so both failure paths cost one derivation and return the same `401`.
3. **In-memory sliding-window login limiter** keyed by `ip|email`: 5 failures per 15 min → `429`
   with `Retry-After`. A blocked attempt does no hashing. The client IP comes from Fastify
   `trustProxy`, configured by `PULSE_TRUST_PROXY`.
4. **API keys** are `pulse_` + base64url(32 random bytes). Pulse stores only `sha256(key)`, plus a
   12-character display prefix, and shows the key once. A key authenticates via `Authorization:
   Bearer`. It has a single ordered `scope`: `read` allows `GET`/`HEAD`, and `write` allows
   everything. Revocation is a soft delete (`revoked_at`). Key and session management endpoints
   require a browser session, so a leaked key cannot mint keys.
5. **One root `onRequest` hook, default deny.** Every `/api/v1/*` request, including unmatched
   ones, needs a credential unless its route declares `config: { public: true }`. If an
   `Authorization` header is present, it is the only credential considered. Cookie-authenticated
   `POST`/`PUT`/`PATCH`/`DELETE` must send `X-Pulse-CSRF` equal to the session's token
   (synchronizer token pattern). The web app gets the token from the login response or `GET
   /api/v1/auth/session` and keeps it in memory. Non-API paths (`/health`, `/status`,
   `/badge/*`, static files) are outside the hook's scope.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Stateless JWT in a cookie | Logout can't revoke without a denylist, which is server state anyway. Larger cookies and more crypto to get right. |
| `@fastify/session` / `@fastify/secure-session` | `secure-session` is stateless (same revocation problem). `@fastify/session` needs a store adapter. Our table and about 60 lines are simpler to test with a fake clock. |
| argon2id (`argon2` npm) | Native addon. It needs prebuilds or a toolchain on Alpine and arm64, and adds supply-chain surface. scrypt is memory-hard, in Node core, and an OWASP-listed choice. We can migrate through the self-describing hash format. |
| bcrypt | Native or slow pure-JS. 72-byte input limit. Not memory-hard. |
| `@fastify/rate-limit` | It is built for request-rate limiting. We need "failures per IP+email" and a reset on success. A custom limiter is small and deterministic under fake timers. |
| `@fastify/csrf-protection` | Fine, but it adds a dependency for a constant-time compare against a per-session token we already store. |
| Double-submit cookie CSRF | Needs a JS-readable cookie and is weaker against subdomain cookie injection. A server-stored token is simple when sessions are server-side anyway. |
| Plain list of scopes (`["read","write"]`) | Allows meaningless combinations. The two levels are ordered. |
| Per-route `preHandler` auth | It is easy to forget on a new route. Default deny with explicit `config.public` fails closed, and a route-sweep test enforces it. |
| A `buildApp({ auth: false })` switch for tests | It could leak into production configs. Tests use helpers that seed a key instead. |

## Consequences

Positive:

- Revocation of sessions and keys is immediate. A leaked DB copy contains no usable session ids
  or API keys.
- No native auth dependencies. The only new runtime dependencies are `@fastify/cookie` and
  `@fastify/static` (ADR 0007).
- Public surfaces are unchanged and enforced by tests, and new routes are protected by default.

Negative / trade-offs:

- Rate-limit state is lost on restart and is per process. That is acceptable under the
  single-instance rule (ADR 0003), but an attacker gets a fresh window after each restart.
- Each failed login costs about 32 MiB and tens of ms of scrypt work, bounded by the libuv thread
  pool (4) and the limiter. There is no global per-IP cap across many emails yet.
- If the session secret is generated, it lives in the DB, so DB backups are sensitive. Operators
  who want separation set `PULSE_SESSION_SECRET`.
- Only one account exists. Recovery is a documented manual step (delete the user and restart
  with env).
- Every existing API test now has to authenticate, which is one-time churn handled by shared
  helpers.
