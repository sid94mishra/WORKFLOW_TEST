# ADR 0002: SSRF egress policy for the checker

- **Status:** Accepted
- **Date:** 2026-10-11
- **Deciders:** Pulse maintainers
- **Related:** [Iteration 2 spec §3.2](../specs/check-scheduler-and-ssrf-safe-checker.md#32-pulsechecker--ssrf-safe-checks),
  [ADR 0001](0001-stack.md)

## Context

From iteration 2 on, Pulse makes HTTP requests on its own to any URL a user stores. Without a
policy this is a server-side request forgery (SSRF) primitive: a monitor can probe the host's
loopback services, the private network, or the cloud metadata endpoint (`169.254.169.254`), and
the stored result (status code, latency, error text, keyword match) leaks what it found.

Forces:

- Checking the URL string is not enough. A public-looking hostname can resolve to `127.0.0.1`, and
  a public endpoint can redirect to a private one.
- **DNS rebinding:** if we resolve to validate and the HTTP client resolves again to connect, an
  attacker's DNS can answer "public" first and "private" second.
- Node's global `fetch` (bundled undici) offers no hook to validate or pin the address it connects
  to, and follows redirects internally.
- Local development and tests legitimately target `127.0.0.1`.
- Free/open-source only, small footprint, no egress proxy to operate.

## Decision

1. **Resolve, validate, pin.** For every hop the checker resolves the hostname itself
   (`dns.promises.lookup`, `all: true`) and requires **every** returned address to pass the
   policy. The validated addresses are stored per check. All requests go through a per-check
   `undici.Agent` whose `connect.lookup` answers **only** from that store. The connection can only
   reach an address that was validated, and DNS is not queried a second time.
2. **Manual redirects.** Requests use `redirect: 'manual'`. The checker follows at most 3
   redirects itself and applies step 1 to each target. Only `http:`/`https:` targets are allowed.
3. **Deny-list of non-public ranges.** Loopback, RFC 1918, link-local, unique-local, unspecified,
   CGNAT, multicast, reserved, plus the explicit metadata addresses. It is implemented with
   `node:net` `BlockList`. IPv4-mapped IPv6 is unwrapped first. Invalid input fails closed.
4. **One development switch.** `PULSE_ALLOW_PRIVATE=1` (checker option `allowPrivate`) turns off
   the policy for every range **except metadata addresses**, which stay blocked. The server logs a
   warning when it is on.
5. **Enforce in the checker, not at create time.** The API keeps accepting any http(s) URL.
   Blocked checks are stored as failed results with an explicit error such as
   `blocked address: evil.test resolves to 127.0.0.1 (loopback)`.
6. Add the **`undici`** npm package (MIT) to `@pulse/checker` and import both `fetch` and `Agent`
   from it, so the `dispatcher` matches the fetch implementation.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Validate the URL/resolved IP, then call global `fetch` | Open to rebinding (two resolutions) and to redirects followed inside fetch. |
| Pre-resolve, then request `http://<ip>/` with a `Host` header | Breaks TLS: SNI and certificate validation need the hostname, and fetch cannot override `servername`. |
| Re-implement the client on `node:http`/`node:https` with `lookup` | Works without a dependency, but means re-implementing redirects, decompression and the body/abort handling that fetch already gets right. |
| Allow-list of permitted hosts | Wrong default for an uptime monitor that must reach arbitrary public sites. |
| Outbound egress proxy (e.g. Smokescreen) or network policy | An extra service to run, against the one-process deployment goal of ADR 0001. Operators MAY add one as defence in depth. |
| Validate at `POST`/`PATCH` time | DNS can change after creation. It could at most be an early UX hint (future work), never the enforcement point. |

## Consequences

Positive:

- One choke point (`runHttpCheck`) enforces the policy for every caller: scheduler, future "test
  now" button, status pages.
- Rebinding and redirect bypasses are closed, and they can be tested without network access
  (injected resolver, request-counting local server).

Negative / trade-offs:

- A new runtime dependency (`undici`) that must stay compatible with Node 22.
- One `Agent` per check means no keep-alive reuse. Every check pays DNS + TCP + TLS. For an
  uptime monitor this is arguably the more honest latency.
- `latencyMs` now includes DNS resolution and redirect hops, which iteration 1 did not measure
  the same way.
- Monitors of intranet services need `PULSE_ALLOW_PRIVATE=1`, and that switch applies to the
  whole instance. A per-CIDR allow-list is possible future work.
- `HTTP(S)_PROXY` environment variables are ignored by the pinned agent.
