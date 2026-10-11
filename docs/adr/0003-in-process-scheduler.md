# ADR 0003: In-process check scheduler and monitor status

- **Status:** Accepted
- **Date:** 2026-10-11
- **Deciders:** Pulse maintainers
- **Related:** [Iteration 2 spec §3.4–§3.5](../specs/check-scheduler-and-ssrf-safe-checker.md#35-scheduler-appsapisrcschedulerschedulerts),
  [ADR 0001](0001-stack.md)

## Context

Monitors must run every `intervalSeconds` (30 s – 24 h) on their own. ADR 0001 targets one Node
process and one SQLite file, with no Redis or separate worker. Requirements:

- ±10 % jitter so monitors that share an interval don't fire in lockstep.
- A global cap on concurrent checks (`PULSE_MAX_CONCURRENCY`, default 8).
- Clean shutdown: no orphaned timers, and in-flight results get written before the DB closes.
- Deterministic tests with fake timers.
- A monitor status that flips to `down` after 3 consecutive failures and back to `up` on one
  success.

## Decision

1. **A `Scheduler` class inside `@pulse/api`** with one `setTimeout` per enabled monitor. All
   effects (`listEnabled`, `runCheck`, `record`, `random`, logger) are injected, so tests drive it
   with Vitest fake timers and deferred promises, with no I/O.
2. **Fixed rate with per-run jitter.** Each run's delay is `interval × (0.9 + 0.2 × random())`.
   The next timer is armed when the current one fires. If a run of the same monitor is still
   queued or in flight, the firing is skipped. The first run happens within the first 10 % of
   the interval.
3. **A FIFO semaphore** limits in-flight checks to `maxConcurrency`.
4. **Explicit change notifications.** The monitor routes call `upsert`/`remove` after writes, so
   changes take effect immediately without polling the DB.
5. **Shutdown ordering.** `stop()` clears timers, drops queued runs and awaits in-flight runs and
   their writes. Checks are bounded by `timeoutMs` ≤ 60 s. One Fastify `onClose` hook awaits
   `stop()` and then closes the DB.
6. **Status is stored on the monitor row** (`status`, `consecutive_failures`, `last_checked_at`)
   and updated in the same transaction as the `check_results` insert. Each result also stores the
   status it produced (`up` / `degraded` / `down`). `degraded` means "failing but not yet
   confirmed down" (1–2 consecutive failures). Uptime percentages use the raw `ok` flag, not the
   status.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Global tick (e.g. every second) that queries "due" monitors from SQLite | Simple and self-healing, but needs a `next_run_at` column, writes per run and a polling loop. Per-monitor timers are more precise and easier to test with fake timers. Worth revisiting if timers ever drift from DB state. |
| Job queue (BullMQ + Redis, pg-boss, Agenda) | Extra infrastructure, against the single-process goal of ADR 0001. |
| Cron library (`node-cron`, `croner`) | Intervals aren't cron expressions, the library still needs our own jitter and concurrency, and it adds a dependency for little gain. |
| Separate worker process | Needs IPC or DB polling for monitor changes and two processes to deploy. Deferred until load requires it. |
| Fixed delay (next run armed after the check ends) | The cadence drifts by check duration and queue wait. Fixed rate keeps the advertised interval. |
| Derive status on the fly from the last N results | Every list/detail read would pay for it. Storing it makes `GET /monitors` cheap and gives notifications (iteration 5) a natural transition point. |

## Consequences

Positive:

- No new infrastructure or dependencies. Behaviour is fully covered by fast, deterministic tests.
- Status transitions happen in exactly one place (`ResultRepository.record`), ready for
  notifications later.

Negative / trade-offs:

- **Single instance only.** Two API processes on the same DB would both run every check. This
  must be documented. Leader election or DB-claimed runs come later if horizontal scaling is
  needed.
- Schedules are in memory. After a restart every monitor runs again within 10 % of its interval,
  so long intervals (e.g. 24 h) "restart" their cadence.
- Shutdown can take up to the longest in-flight `timeoutMs` (≤ 60 s). Orchestrator grace periods
  must be at least that long.
- `check_results` grows without bound until retention lands (about 86 k rows per monitor per
  30 days at the 30 s minimum).
