# ADR 0004: Incident lifecycle and in-process notification delivery

- **Status:** Accepted
- **Date:** 2026-10-11
- **Deciders:** Pulse maintainers
- **Related:** [Iteration 3 spec §3.3–§3.6](../specs/incidents-webhook-notifications-status-page-and-badges.md#33-incident-lifecycle-appsapisrcresultsrepositoryts),
  [ADR 0002](0002-ssrf-egress-policy.md), [ADR 0003](0003-in-process-scheduler.md)

## Context

Iteration 3 turns status transitions into incidents and pushes them to webhook and Slack
channels. Requirements and forces:

- At most one open incident per monitor. `degraded` (1–2 failures) must not open one.
- A notification must never delay a check. Slow or failing endpoints are retried (3 attempts with
  backoff), and every attempt is recorded (the last 20 per channel).
- Webhook URLs are user-supplied outbound targets, so they are an SSRF primitive just like monitor
  URLs (ADR 0002). Slack-style webhook URLs also contain a secret token.
- ADR 0001 targets one process and one SQLite file. There is no queue infrastructure.
- Tests must be deterministic with fake timers and an injected `fetch`.

## Decision

1. **Incidents are derived in `ResultRepository.record`**, in the same transaction that writes
   the result and the monitor status (ADR 0003 §6). The rule depends on state, not on the
   transition: *new status `down` and no open incident → open one; new status `up` and an open
   incident → resolve it.* A partial unique index (`incidents(monitor_id) WHERE status = 'open'`)
   enforces "one open incident" in the database as well. `record` returns the incident event (if
   any) to its caller.
2. **The notifier is in-process and fire-and-forget.** After the transaction commits, the
   `record` wrapper in `buildApp` calls `notifier.enqueue(event)`. That call is synchronous and
   cheap, and it never awaits a network call. The `Notifier` has its own concurrency cap (4) that
   is separate from the check cap, and its own `setTimeout`-based retry timers (attempts at 0 s,
   +2 s, +10 s). Every attempt is written to `delivery_attempts`, and older rows are pruned to 20
   per channel in the same transaction.
3. **Outbound requests reuse the checker's egress policy.** `@pulse/checker` gets a `postJson()`
   that runs the same resolve → validate every address → pin flow as `runHttpCheck`, with
   `redirect: 'manual'`. A 3xx counts as a failure, so redirects are never followed. Metadata
   addresses stay blocked even when `PULSE_ALLOW_PRIVATE=1`.
4. **Channel URLs are also validated when they are created or changed.** This is a deliberate
   exception to ADR 0002 decision 5. Channel URLs are few and change rarely, and the user is
   present at that moment, so an early `400` is useful. This check is a UX guard only. The send
   path is still the enforcement point, because DNS can change after creation.
5. **Shutdown drops pending retries.** `notifier.stop()` clears retry timers (and logs how many
   deliveries it dropped), then awaits in-flight sends. Each send is bounded by a 10 s timeout.
   The single `onClose` hook stops the scheduler, then the notifier, then closes the DB.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Transactional outbox table polled by a worker loop | Survives restarts, but adds a polling loop, a `next_attempt_at` column and lease handling. For 3 attempts within about 12 s, losing in-flight retries on restart is acceptable at this stage. Revisit if delivery guarantees become a requirement. |
| Send inline inside the scheduler's `record` | A slow Slack endpoint would hold a check slot and delay other monitors. This directly violates the requirement. |
| Job queue (BullMQ/Redis, pg-boss) | Extra infrastructure, against ADR 0001. |
| Open incidents on the `degraded → down` transition only (edge-triggered) | An edge trigger misses monitors that are already `down` when migration 003 runs, and it can't recover if a row is lost. The state-based rule is idempotent and self-healing. |
| Global `fetch` for webhooks | Open to DNS rebinding and to redirects into private ranges (ADR 0002). |
| Follow redirects for webhooks | Webhook endpoints don't need redirects, and every hop would be another SSRF surface. Failing on 3xx is simpler and safer. |

## Consequences

Positive:

- Status, result and incident always agree, because they are written in one transaction. Checks
  are never blocked by notification I/O.
- One egress policy (ADR 0002) covers checks and notifications, and one set of tests proves it.
- Everything is driven by injected `fetch`/`resolveHost` and fake timers. Tests make no network
  calls.

Negative / trade-offs:

- **At-most-once on restart:** a retry that is pending when the process stops is lost (it is
  logged). An incident that opens while the process is down is notified on the next `down` check
  after start-up, because the state-based rule still opens it then.
- `started_at` is the time of the check that confirmed `down` (the 3rd consecutive failure), not
  the first failure. This keeps the "degraded is not an incident" semantics simple.
- Webhook payloads are unsigned (no HMAC) in this iteration. Receivers must treat the URL as the
  secret.
- Channel URLs, which may contain tokens, are returned by the unauthenticated API until auth
  arrives (iteration 4). The API must stay bound to a trusted network.
