# Pulse

Pulse is a self-hosted uptime monitor that will also serve public status pages. You define HTTP
monitors (URL, method, expected status, optional keyword, interval, timeout). Pulse checks them
and records the results. It is built on free, open-source software only and stores everything in
a single SQLite file.

> **Status: Iteration 1 (Foundation).** You can create, list, update and delete monitors through
> the REST API, and list or add them in the web dashboard. The HTTP check engine exists and is
> tested. Scheduled checks, status pages, auth and notifications come in later iterations (see
> [the iteration 1 spec](docs/specs/iteration-1.md#1-goal-and-scope)).

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

### API configuration

| Env var         | Default           | Notes                                     |
| --------------- | ----------------- | ----------------------------------------- |
| `PORT`          | `3000`            |                                           |
| `HOST`          | `127.0.0.1`       | Set `0.0.0.0` to listen on all interfaces |
| `DATABASE_PATH` | `./data/pulse.db` | Relative to the process working directory |
| `LOG_LEVEL`     | `info`            | Pino log level                            |

The parent directory of `DATABASE_PATH` is created if it is missing; use `:memory:` for an
ephemeral database. `pnpm dev` and `pnpm --filter @pulse/api start` run in `apps/api`, so the
default database lands in `apps/api/data/pulse.db`. An invalid `PORT` (not 1–65535) makes the API
exit with an error.

Migrations in `apps/api/migrations/*.sql` are applied automatically on startup and recorded in
`schema_migrations`.

## API (v1)

| Method   | Path                   | Result                                         |
| -------- | ---------------------- | ---------------------------------------------- |
| `GET`    | `/health`              | `200 { status: "ok", version, uptimeSeconds }` |
| `GET`    | `/api/v1/monitors`     | `200 { data: Monitor[] }` (oldest first)       |
| `POST`   | `/api/v1/monitors`     | `201 { data: Monitor }` + `Location` header    |
| `GET`    | `/api/v1/monitors/:id` | `200 { data: Monitor }` or `404`               |
| `PATCH`  | `/api/v1/monitors/:id` | `200 { data: Monitor }` (partial update)       |
| `DELETE` | `/api/v1/monitors/:id` | `204`                                          |

Errors use `{ error: { code, message, issues? } }`. Codes are `VALIDATION_ERROR`, `BAD_REQUEST`,
`NOT_FOUND`, `UNSUPPORTED_MEDIA_TYPE` and `INTERNAL_ERROR`. The full contract and the field rules
are in [docs/specs/iteration-1.md](docs/specs/iteration-1.md).

Example:

```sh
curl -X POST http://127.0.0.1:3000/api/v1/monitors \
  -H 'content-type: application/json' \
  -d '{"name":"Example","url":"https://example.com","keyword":"Example Domain"}'
```

## Security notes

Iteration 1 has **no authentication** and binds to `127.0.0.1` by default. Do not expose the API
to an untrusted network yet: anyone who can reach it can create, change and delete monitors. Auth
arrives in iteration 4. Monitor URLs are not restricted to public hosts; once scheduled checks
exist (iteration 2), a monitor could probe internal addresses, so only trusted users should be able
to create monitors.

## Docs

- [Iteration 1 spec](docs/specs/iteration-1.md)
- [ADR 0001 – Stack](docs/adr/0001-stack.md)

## Contributing

Use small, focused commits with [Conventional Commit](https://www.conventionalcommits.org/)
messages. Every feature ships with tests. Before you open a PR, run
`pnpm lint && pnpm format:check && pnpm test && pnpm build`.
