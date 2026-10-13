# Operating Pulse

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | HTTP listening address. |
| `PORT` | `3000` | HTTP listening port. |
| `DATABASE_PATH` | `./data/pulse.db` | SQLite database path. |
| `LOG_LEVEL` | `info` | Pino log level. |
| `NODE_ENV` | unset | Set to `production` in the container image. |
| `PULSE_ADMIN_EMAIL` | unset | First-start administrator email. |
| `PULSE_ADMIN_PASSWORD` | unset | First-start administrator password (12–1024 characters). |
| `PULSE_SESSION_SECRET` | generated | Optional 32+ character cookie signing secret. |
| `PULSE_COOKIE_SECURE` | `auto` | `auto`, `true`, or `false` for the session cookie Secure attribute. |
| `PULSE_TRUST_PROXY` | `false` | `false`, `true`, proxy hops, or trusted proxy addresses. |
| `PULSE_WEB_DIR` | unset | Built dashboard directory served by the API. |
| `PULSE_METRICS_PUBLIC` | `false` | Set `true` only when `/metrics` may be scraped without credentials. |
| `PULSE_MAX_CONCURRENCY` | `8` | Maximum concurrent checks, from 1 to 64. |
| `PULSE_ALLOW_PRIVATE` | `0` | Set `1` only for development networks; metadata addresses remain blocked. |
| `PULSE_API_URL` | `http://127.0.0.1:3000` | Development-only Vite proxy target. |

## First start

Set both `PULSE_ADMIN_EMAIL` and `PULSE_ADMIN_PASSWORD`, then start Pulse and sign in. They are
used only while the users table is empty; later values are ignored. An empty database without both
variables exits with code 1.

## Backups

Pulse uses SQLite WAL mode. Do not copy just `pulse.db` while it is running. Use an online backup,
for example in a throwaway container sharing `/data`: `apk add sqlite` then
`sqlite3 /data/pulse.db ".backup '/data/pulse-backup.db'"`. Offline, stop Pulse and copy
`pulse.db*`. Restore by stopping Pulse and replacing the database files. Backups contain password
hashes and may contain the generated session secret, so keep them private.

## Upgrading

Back up, pull or rebuild the image, then restart. Migrations run automatically and are forward-only;
there is no downgrade without the backup.

## Reverse proxy

Terminate TLS at a reverse proxy and set `PULSE_TRUST_PROXY` to its hop count or address. Forward
`X-Forwarded-For` and `X-Forwarded-Proto` so Secure cookies and per-IP login limits work.

```caddy
pulse.example.com { reverse_proxy 127.0.0.1:3000 }
```

```nginx
location / { proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Proto $scheme; proxy_pass http://127.0.0.1:3000; }
```

Run one instance per SQLite database and do not expose the container directly to the internet without TLS.

## Account recovery

Stop Pulse, run `DELETE FROM users;` with sqlite3, then restart with new `PULSE_ADMIN_*` values.
The cascade removes sessions; API keys remain.

## Metrics

Prometheus can scrape `GET /metrics`. It accepts a browser session or an API key; use a read key
for Prometheus. It exposes monitor truth, recorded-check latency and totals, open incidents, and
active maintenance. Counters and latency histograms reset when Pulse restarts. Public mode exposes
every monitor name, so leave `PULSE_METRICS_PUBLIC=false` unless that is intentional.

| Family | Type | Labels | Meaning |
| --- | --- | --- | --- |
| `pulse_monitor_up` | gauge | `monitor`, `id` | Last stored truth for enabled, non-pending monitors. |
| `pulse_check_duration_seconds` | histogram | none | Recorded check latency since process start. |
| `pulse_checks_total` | counter | `result` | Recorded checks since process start, split into `ok` and `fail`. |
| `pulse_open_incidents` | gauge | none | Current number of open incidents. |
| `pulse_maintenance_active` | gauge | `monitor`, `id` | Whether each monitor currently has active maintenance. |

```yaml
scrape_configs:
  - job_name: pulse
    metrics_path: /metrics
    scheme: https
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/pulse-read-key   # a Pulse API key with scope "read"
    static_configs:
      - targets: ['status.example.com']
```

An alert can avoid planned work with `pulse_monitor_up == 0 unless on(id) pulse_maintenance_active == 1`.

## Maintenance windows

Maintenance schedules use UTC. Weekly repeats occur on the selected UTC weekdays and can cross
midnight. Checks continue to count toward uptime; alerts and newly-created notification events are
suppressed during the active occurrence. A title is public when its window affects a public monitor.

## Security checklist

Use a strong admin password and HTTPS, give dashboards and CI read-only keys where possible, revoke
unused keys, keep `PULSE_ALLOW_PRIVATE` off, and protect database backups.
