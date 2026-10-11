# ADR 0001: Technology stack and repository layout

- **Status:** Accepted
- **Date:** 2026-10-11
- **Deciders:** Pulse maintainers
- **Related:** [Iteration 1 spec](../specs/iteration-1.md)

## Context

Pulse is a self-hosted uptime monitor with public status pages. Operators run it on a
single small VM or container, often without a separate database server. The project must
use only free/open-source tooling, keep its runtime footprint small, and share one
definition of its domain types between the API, the check engine and the web UI so
that they cannot drift.

Forces:

- **Single-binary-ish deployment:** one Node process plus one data file is the target.
- **Type safety end to end:** request validation, DB mapping and UI forms should all use
  the same schema.
- **Fast feedback:** tests and type-checks must run without a prior build step.
- **Contributor friendliness:** mainstream tools with good docs, no proprietary services.

## Decision

| Concern | Choice | Rationale |
| --- | --- | --- |
| Runtime | **Node.js 22 LTS** | Built-in `fetch`/`AbortController`, `crypto.randomUUID`, `--conditions` flag; LTS until 2027. |
| Package manager / monorepo | **pnpm 10 workspaces** (`apps/*`, `packages/*`) | Strict, fast, disk-efficient; `pnpm -r` runs scripts in topological order. |
| Language | **TypeScript, `strict`, ESM only** (`module`/`moduleResolution: NodeNext`) | One module system; Node-native ESM avoids dual-package hazards. |
| Intra-repo resolution | **`"source"` export condition** → `src/index.ts`; `types`/`default` → `dist/` | Tests, dev servers and `tsc --noEmit` consume sources directly; published/runtime builds use `dist`. |
| HTTP API | **Fastify 5** (`apps/api`) | Fast, first-class TypeScript, `inject()` for in-process tests without opening sockets. |
| Persistence | **SQLite via better-sqlite3**, plain `.sql` migration files | Zero-ops embedded DB in one file; synchronous API is simple and fast for this workload; SQL migrations are reviewable and tool-agnostic. |
| Schemas / validation | **zod 4** in `packages/shared` | Single source of truth for runtime validation and static types (`z.infer`), usable in Node and the browser. |
| Check engine | **`packages/checker`** using global `fetch` + `AbortController` | No HTTP client dependency; isolated, unit-testable against a local `node:http` server; reusable by the future scheduler. |
| Web UI | **React 19 + Vite + Tailwind CSS 4** (`apps/web`) | Mainstream SPA stack, fast dev server with an `/api` proxy, utility CSS without a component-library lock-in. |
| Unit / component tests | **Vitest** (+ Testing Library + jsdom for web) | Shares Vite's resolver/transform (incl. the `source` condition), Jest-compatible API, native ESM/TS. |
| E2E tests (later) | **Playwright** | Free, cross-browser, first-class TS. |
| CI | **GitHub Actions** | Free for public repos; standard `setup-node`/pnpm caching. |

## Alternatives considered

- **Express / Koa / Hono instead of Fastify.** Express 5 is ubiquitous but has weaker typing and no
  built-in `inject`; Hono is attractive for edge runtimes we don't target. Fastify wins on
  testing ergonomics and plugin/hook model.
- **PostgreSQL (or MySQL).** Better for multi-node/high write concurrency, but requires a second
  service to operate, contradicting the single-process self-host goal. SQLite in WAL mode is ample
  for thousands of monitors. Revisit if horizontal scaling is ever required.
- **Prisma / Drizzle / Knex.** Prisma adds a codegen step and a native engine; Drizzle/Knex add an
  abstraction over ~2 tables. Plain SQL + a ~40-line migration runner keeps the data layer
  transparent. Revisit Drizzle if the schema grows substantially.
- **Next.js / Remix.** SSR is unnecessary for an authenticated-later dashboard; it would couple UI
  and API deployment. Public status pages may revisit SSR/SSG in a later ADR.
- **Jest.** Requires extra ESM/TS transform configuration; Vitest works out of the box with Vite
  and our `source` condition.
- **npm / Yarn workspaces, Turborepo, Nx.** pnpm alone covers topological scripts at our scale;
  build orchestration tools can be added later without restructuring.
- **TypeScript project references (`tsc -b`) instead of the `source` condition.** Requires builds
  before type-checking/tests and more config per package; the custom-condition approach gives
  zero-build feedback with standard `exports`.
- **Ajv/TypeBox (Fastify-native JSON Schema).** Faster validation but would duplicate types for
  the browser; zod gives one schema for API and UI.

## Consequences

Positive:

- One `pnpm install` and one data file; `pnpm test`/`pnpm lint` work on a fresh clone without
  building.
- Domain types are defined once (`@pulse/shared`) and enforced at the API boundary and in the UI.
- API tests run in-process (`fastify.inject` + `:memory:` SQLite) — fast and hermetic.

Negative / trade-offs:

- better-sqlite3 is a native module: installs need a prebuilt binary or a C++ toolchain
  (`onlyBuiltDependencies` allows its build script). Single-writer semantics limit write
  throughput (acceptable for this domain).
- The `source` condition must be configured consistently in three places (tsconfig
  `customConditions`, Vite/Vitest `resolve.conditions`, Node `--conditions=source` for dev). Build
  tsconfigs must disable it so emitted code resolves sibling packages via `dist`, which makes
  `pnpm -r build` order-dependent (handled by pnpm's topological sort).
- Hand-written SQL means mapping snake_case rows to camelCase objects ourselves (a small
  repository module in `apps/api`).
- zod validation is slower than compiled JSON Schema; irrelevant at expected request rates.
