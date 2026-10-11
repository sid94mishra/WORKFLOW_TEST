# ADR 0005: Server-rendered public status page, daily rollups and badges

- **Status:** Accepted
- **Date:** 2026-10-11
- **Deciders:** Pulse maintainers
- **Related:** [Iteration 3 spec §3.8–§3.9](../specs/incidents-webhook-notifications-status-page-and-badges.md#38-public-status-page),
  [ADR 0001](0001-stack.md), [ADR 0003](0003-in-process-scheduler.md)

## Context

Pulse must publish a status page (`/status`, HTML with no JavaScript, plus a JSON twin) and
shields-style SVG badges. Forces:

- The page is **public**, while the rest of the API is unauthenticated and meant for trusted
  networks only. Only data that is explicitly marked public may appear, and only fields that are
  safe to show.
- 90 daily uptime bars per monitor. At the 30 s minimum interval, one monitor has about 260 k
  results in 90 days, and a page view must not scan them all.
- No JavaScript on the page, no extra service, and free/open-source only (ADR 0001).
- `/status` and `/api/v1/status` must always agree.

## Decision

1. **Render in Fastify with a pure function and no template engine.** `buildStatusPage(now)`
   returns the `StatusPage` object (validated by a zod schema in `@pulse/shared`).
   `/api/v1/status` serialises it, and `/status` passes **the same object** to
   `renderStatusPageHtml(page)`, a pure function that uses template literals and one `escapeHtml`
   helper. The CSS is inline and hand-written. A `Content-Security-Policy` of
   `default-src 'none'; style-src 'unsafe-inline'; img-src 'self'` forbids scripts entirely.
2. **A daily rollup table**, `daily_uptime(monitor_id, day, total_checks, ok_checks)`, keyed by
   UTC `YYYY-MM-DD`. It is upserted in the same `record` transaction as the result, and migration
   003 backfills it from `check_results`. The status page reads at most 90 rows per monitor.
   Retention of raw `check_results` can later prune rows older than 30 days without losing the
   90-day history.
3. **Opt-in exposure.** There is a `monitors.public` flag (default `false`). Public output
   contains only the monitor `id`, `name`, status, last-check time, uptime and incident times.
   It **never** includes the URL, method, keyword, error text or incident `cause`, because those
   can reveal internal hosts.
4. **Badges are hand-built SVG strings** in the shields "flat" layout. Text widths come from a
   fixed per-character estimate, so no font metrics library is needed. Every interpolated string
   is XML-escaped. Responses carry `Cache-Control: public, max-age=60`.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Render the status page in the React SPA | Needs JavaScript and the SPA bundle, which violates the "no JS" requirement. |
| Template engine (`@fastify/view` + eta/handlebars) or React SSR | One page doesn't justify a new dependency. React SSR would also pull React into the API. Template literals with one escape helper are easy to audit. |
| Aggregate `check_results` with `GROUP BY` on every request | Simple, but costs O(results), and the raw rows will be pruned later. |
| Separate static-site generator writing HTML files | Needs a writable web root and a second serving path. Data would also be stale between generations. |
| Badges via shields.io (`img.shields.io/endpoint`) | External service dependency, and it leaks monitor IDs to a third party. |
| `badge-maker` npm package | Accurate widths, but a dependency for about 40 lines of SVG. We can switch later without breaking the contract. |

## Consequences

Positive:

- The HTML and JSON views cannot disagree, because both are projections of one object. Tests
  compare them directly.
- Status page cost is O(public monitors × 90), independent of check frequency.
- Nothing becomes public unless someone opts in. Error text never leaks.

Negative / trade-offs:

- The rollup duplicates information that is in `check_results`. Rows inserted outside
  `ResultRepository.record` (for example, a test that seeds with SQL) don't show up in the bars.
  Tests must seed through `record`.
- Badge text widths are approximate (±a few px for unusual glyphs).
- The status page uses minimal inline styles and doesn't share Tailwind classes with the
  dashboard.
- It has no custom branding (title or logo) and no custom domain handling yet.
