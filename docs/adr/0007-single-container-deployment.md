# ADR 0007: Single-container deployment with the API serving the dashboard

- **Status:** Accepted
- **Date:** 2026-10-12
- **Deciders:** Pulse maintainers
- **Related:** [Iteration 4 spec §3.10–§3.12](../specs/auth-api-keys-docker-image-and-operator-docs.md#311-deploy-files-repo-root),
  [ADR 0001](0001-stack.md), [ADR 0003](0003-in-process-scheduler.md),
  [ADR 0006](0006-authentication-sessions-and-api-keys.md)

## Context

Pulse must be easy to deploy with Docker. Today the dashboard is only served by the Vite dev
server, which proxies `/api` to the API. In production nothing serves `apps/web/dist`. Forces:

- The session cookie is `SameSite=Lax` and CSRF relies on same-origin requests (ADR 0006).
  Serving the dashboard from a different origin would need CORS with credentials.
- One instance per SQLite file (ADR 0003). Persistent data must live on a volume.
- Small attack surface: non-root, no build toolchain at runtime, free base images only.
- better-sqlite3 is a native addon. Alpine uses musl.

## Decision

1. **One image, one process.** The API serves the built dashboard from `PULSE_WEB_DIR` with
   `@fastify/static` (MIT). Hashed `/assets/*` files are cached as immutable, and `index.html`
   is `no-cache`. Routing is hash-based, so there is no SPA fallback. The dashboard, API, status
   page and badges share one origin.
2. **Multi-stage `node:22-alpine` Dockerfile.** The build stage installs the toolchain (as a
   fallback for better-sqlite3 prebuilds), runs `pnpm install --frozen-lockfile` and `pnpm -r
   build`, then `pnpm deploy --prod` the API. The runtime stage copies only the deployed API and
   the web `dist`, runs as `node`, sets `HOST=0.0.0.0` and `DATABASE_PATH=/data/pulse.db`,
   declares `VOLUME /data`, and has a `HEALTHCHECK` that calls `/health` with Node's `fetch` (no
   curl or wget needed).
3. **TLS at a reverse proxy**, not in the container. `PULSE_TRUST_PROXY` makes `Secure` cookies
   and per-IP limits correct behind it.
4. **Allow-list `.dockerignore`**, so only workspace sources and manifests can enter the build
   context.
5. **Hadolint in CI** as the Dockerfile linter, because the repo had none. A text-level Vitest
   test also guards key invariants (non-root, healthcheck, volume, no secrets in `ENV`/`ARG`).

## Alternatives considered

| Option | Why not |
| --- | --- |
| Separate nginx container for the web app | Two images and a compose network for static files. It also needs the proxy to route `/api` correctly, or else CORS and cross-origin cookies. |
| Distroless / `node:22-slim` (glibc) | Distroless has no shell, which complicates support and healthchecks. The brief asks for Alpine, and glibc images are larger. Revisit if musl causes problems. |
| `curl`/`wget` healthcheck | It adds a package, or depends on BusyBox applets. Node is already present. |
| Serve the web app via `vite preview` | That is a dev tool and a second process. |
| Bake TLS (e.g. built-in ACME) | Out of scope and duplicates mature proxies (Caddy, nginx, Traefik). |

## Consequences

Positive:

- `docker compose up -d` gives a working, authenticated Pulse on one port with data on a named
  volume.
- Same-origin by construction, so no CORS configuration and cookies just work.

Negative / trade-offs:

- The API image includes the static assets, so a UI change requires an image rebuild.
- The build stage depends on pnpm's `deploy` behaviour (`--legacy` under pnpm 10). A pnpm upgrade
  may need a Dockerfile change.
- The image is single-arch unless CI adds buildx. Publishing to a registry is out of scope.
- `docker build` is verified in CI only. Locally, only the text-level invariants test runs.
