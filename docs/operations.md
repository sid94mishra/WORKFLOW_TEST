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

## Security checklist

Use a strong admin password and HTTPS, give dashboards and CI read-only keys where possible, revoke
unused keys, keep `PULSE_ALLOW_PRIVATE` off, and protect database backups.
