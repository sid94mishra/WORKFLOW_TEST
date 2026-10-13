# Pulse

Pulse is a self-hosted uptime monitor with incident notifications, public status pages and badges. You define HTTP
monitors (URL, method, expected status, optional keyword, interval, timeout). Pulse checks them
and records the results. It is built on free, open-source software only and stores everything in
a single SQLite file.

> **Status: Iteration 5 (maintenance windows and Prometheus metrics).** Pulse schedules
> enabled monitors, records incidents, publishes status pages, and protects its management API
> with browser sessions and scoped API keys.

## Layout

```
.
├─ packages/
│  ├─ shared/    @pulse/shared  – zod schemas + types (Monitor, CheckResult, API envelopes)
│  └─ checker/   @pulse/checker – runHttpCheck(): status, latency, keyword match, timeout
├─ apps/
│  ├─ api/       @pulse/api     – Fastify 5 + better-sqlite3, SQL migrations, REST API
│  └─ web/       @pulse/web     – React 19 + Vite + Tailwind dashboard
├─ docs/
│  ├─ specs/     iteration specs (start with iteration-1.md)
│  └─ adr/       architecture decision records
└─ .github/workflows/ci.yml     lint, format check, test and build on PRs and pushes
```

Library packages export a `source` condition that points at `src/`. That way tests, type checks
and dev servers run against the sources without a prior build. The details are in
[spec §2.1](docs/specs/iteration-1.md#21-module-resolution-the-source-condition).

## Requirements

- Node.js 22 (see `.nvmrc`)
- pnpm 10 (`corepack enable` picks up the version pinned in `package.json`)

## Getting started

```sh
pnpm install
export PULSE_ADMIN_EMAIL=admin@example.com
export PULSE_ADMIN_PASSWORD=change-me-to-12+-chars
pnpm dev          # API on http://127.0.0.1:3000 and the dashboard on http://localhost:5173
```

The Vite dev server proxies `/api` and `/health` to the API, so the dev setup needs no CORS. Set
`PULSE_API_URL` to proxy to an API on another address (default `http://127.0.0.1:3000`).

### Scripts (run from the repo root)

| Command       | What it does                                            |
| ------------- | ------------------------------------------------------- |
| `pnpm dev`    | Run the API (tsx watch) and the web app (Vite) together |
| `pnpm lint`   | Type-check every package (`tsc --noEmit`)               |
| `pnpm test`   | Run every package's Vitest suite                        |
| `pnpm build`  | Build all packages in dependency order                  |
| `pnpm format` | Format the repo with Prettier (`format:check` in CI)    |

Run the built API with `pnpm build && pnpm --filter @pulse/api start` (or
`node apps/api/dist/server.js`).

### Quick start (Docker)

```sh
cp .env.example .env
# edit PULSE_ADMIN_EMAIL and PULSE_ADMIN_PASSWORD
docker compose up -d
```

Open http://localhost:3000 and sign in. See [operator configuration](docs/operations.md) for all
environment variables. `PULSE_MAX_CONCURRENCY` and `PULSE_ALLOW_PRIVATE` remain especially useful
development settings.

Migrations in `apps/api/migrations/*.sql` are applied automatically on startup and recorded in
`schema_migrations`.

## API (v1)

| Method             | Path                                   | Result                                                    |
| ------------------ | -------------------------------------- | --------------------------------------------------------- |
| `GET`              | `/health`                              | `200 { status: "ok", version, uptimeSeconds }`            |
| `GET`              | `/api/v1/monitors`                     | `200 { data: Monitor[] }` (oldest first)                  |
| `POST`             | `/api/v1/monitors`                     | `201 { data: Monitor }` + `Location` header               |
| `GET`              | `/api/v1/monitors/:id`                 | `200 { data: Monitor }` or `404`                          |
| `GET`              | `/api/v1/monitors/:id/results`         | Recent check results (`limit`, default 50, max 500)       |
| `GET`              | `/api/v1/monitors/:id/uptime`          | Uptime and latency summary (`window`: `24h`, `7d`, `30d`) |
| `PATCH`            | `/api/v1/monitors/:id`                 | `200 { data: Monitor }` (partial update)                  |
| `DELETE`           | `/api/v1/monitors/:id`                 | `204`                                                     |
| `GET`              | `/api/v1/incidents`                    | Incidents, open first (`status`, `monitorId`, `limit`)    |
| `GET`              | `/api/v1/incidents/:id`                | One incident                                              |
| `GET/POST`         | `/api/v1/channels`                     | List or create notification channels                      |
| `GET/PATCH/DELETE` | `/api/v1/channels/:id`                 | Read, update or delete a channel                          |
| `POST`             | `/api/v1/channels/:id/test`            | Send a test notification                                  |
| `GET`              | `/api/v1/channels/:id/deliveries`      | Recent delivery attempts                                  |
| `GET`              | `/api/v1/status`                       | Public status page data                                   |
| `GET/POST`         | `/api/v1/maintenance`                  | List or schedule maintenance windows                      |
| `GET/PATCH/DELETE` | `/api/v1/maintenance/:id`              | Read, update or delete a maintenance window               |
| `GET`              | `/metrics`                             | Prometheus metrics (authenticated by default)             |
| `POST`             | `/api/v1/auth/login`                   | Create a browser session                                  |
| `GET/POST`         | `/api/v1/auth/session`, `/auth/logout` | Get or end the browser session                            |
| `GET/POST`         | `/api/v1/api-keys`                     | List or create a scoped API key                           |
| `GET/PATCH/DELETE` | `/api/v1/api-keys/:id`                 | Read, rename, or revoke an API key                        |
| `GET`              | `/status`                              | Public no-JavaScript status page                          |
| `GET`              | `/badge/:monitorId.svg`                | Public monitor uptime or status badge                     |

Errors use `{ error: { code, message, issues? } }`. Codes are `VALIDATION_ERROR`, `BAD_REQUEST`,
`NOT_FOUND`, `UNSUPPORTED_MEDIA_TYPE`, `UNAUTHORIZED`, `FORBIDDEN`, `CSRF_FAILED`, `RATE_LIMITED`
and `INTERNAL_ERROR`. The full contract and the field rules
are in [docs/specs/iteration-1.md](docs/specs/iteration-1.md).

Maintenance windows suppress new incident notifications while checks continue to record truthful
uptime. Prometheus-compatible metrics are available at `/metrics`; see the [operations guide](docs/operations.md), the [Iteration 5 spec](docs/specs/maintenance-windows-and-metrics.md), and [ADR 0008](docs/adr/0008-maintenance-windows-and-metrics.md).

Browser writes use the signed cookie plus `X-Pulse-CSRF`. Scripts use a scoped bearer key:

```sh
curl -H 'Authorization: Bearer pulse_…' http://127.0.0.1:3000/api/v1/monitors
```

Set a monitor's `public` flag to `true` to include it in `/status` and make a badge available.
Embed a public monitor's uptime badge with:

```md
![uptime](https://pulse.example.com/badge/MONITOR_UUID.svg)
```

## Incidents and notification channels

An incident opens when a monitor reaches `down` (three consecutive failed checks), and resolves
on the next successful check. Create `webhook` or `slack` channels and subscribe them to monitor
ids. Pulse sends `incident.opened` and `incident.resolved` JSON webhook payloads containing the
event, sent time, channel, monitor, and incident; Slack channels receive a `{ "text": "…" }`
payload. Delivery is retried up to three times and the most recent 20 attempts per channel are
available from the deliveries endpoint.

`/status` renders the same public data as `/api/v1/status` without JavaScript and shows 90 UTC
daily uptime bars. Use `/badge/:monitorId.svg?type=status` for a current-status badge.

## Security notes

Pulse has one administrator, signed HTTP-only sessions, CSRF protection, and read/write API keys.
Use HTTPS in production, keep API keys least-privileged, and revoke unused keys. The checker
resolves and validates every address on the initial request and every redirect, blocks loopback/private/link-local/metadata and reserved ranges by default, and pins validated DNS answers for the request. `PULSE_ALLOW_PRIVATE=1` is only for local development: metadata addresses remain blocked.

Notification channel URLs may contain secret tokens and are readable only by authenticated callers.
Channel validation and each delivery
also apply the egress policy; metadata addresses are always blocked, even with
`PULSE_ALLOW_PRIVATE=1`.

The scheduler is in-process and a Pulse deployment must use a single API instance for each SQLite
database. Monitor status begins as `pending`, becomes `up` after success, `degraded` after one or
two consecutive failures, and `down` after three; disabled monitors are paused and display as
`Paused` in the dashboard.

## Docs

- [Iteration 1 spec](docs/specs/iteration-1.md)
- [Iteration 2 spec](docs/specs/check-scheduler-and-ssrf-safe-checker.md)
- [Iteration 3 spec](docs/specs/incidents-webhook-notifications-status-page-and-badges.md)
- [Iteration 4 spec](docs/specs/auth-api-keys-docker-image-and-operator-docs.md)
- [Operations guide](docs/operations.md)
- [ADR 0001 – Stack](docs/adr/0001-stack.md)
- [ADR 0002 – SSRF egress policy](docs/adr/0002-ssrf-egress-policy.md)
- [ADR 0003 – In-process scheduler](docs/adr/0003-in-process-scheduler.md)
- [ADR 0004 – Incidents and notification delivery](docs/adr/0004-incidents-and-notification-delivery.md)
- [ADR 0005 – Public status pages and badges](docs/adr/0005-public-status-page-and-badges.md)
- [ADR 0006 – Authentication, sessions and API keys](docs/adr/0006-authentication-sessions-and-api-keys.md)
- [ADR 0007 – Single-container deployment](docs/adr/0007-single-container-deployment.md)

## Contributing

Use small, focused commits with [Conventional Commit](https://www.conventionalcommits.org/)
messages. Every feature ships with tests. Before you open a PR, run
`pnpm lint && pnpm format:check && pnpm test && pnpm build`.
