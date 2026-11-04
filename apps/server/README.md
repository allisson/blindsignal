# BlindSignal server

The signaling server: WebSocket on `node:http` (ADR 0001), in-memory or PostgreSQL storage
(ADR 0021), and the registry file as control plane (ADR 0005). It runs its TypeScript sources through Node's type stripping, in
development and in the container image alike.

## Running

```sh
# From the repository root, with Node.js 26 and pnpm:
# (the script runs in apps/server, so the registry path is absolute)
BLINDSIGNAL_ENV=development BLINDSIGNAL_REGISTRY_PATH="$PWD/examples/registry.dev.json" \
  pnpm --filter @blindsignal/server start

# Or with Docker Compose, which mounts the same example registry:
docker compose up --build
```

`examples/registry.dev.json` registers the `notes` and `chat` applications with the development
issuer, whose private key is public in this repository; it loads only with
`BLINDSIGNAL_ENV=development`. Tokens for them come from `mintDevToken` in `packages/dev-issuer`.

The image (`Dockerfile`, ADR 0033) runs in production mode by default, as `node`, and works
with a read-only root filesystem and no capabilities (`--read-only --cap-drop ALL`). It needs at least
`BLINDSIGNAL_REGISTRY_PATH` and `BLINDSIGNAL_ALLOWED_ORIGINS`. It speaks plain WebSocket: put it
behind a TLS-terminating proxy and list that proxy in `BLINDSIGNAL_TRUSTED_PROXIES` (spec §16).
`docs/external-testing.md` covers the Compose workflow and exposing the server through a
Cloudflare Quick Tunnel, `docs/self-hosted.md` a production deployment on one host, and
`docs/cloud-run.md` one on Cloud Run; `docs/deployment.md` helps choose between them.

## Configuration

Every setting is an environment variable. An invalid value stops the server at startup; the error
names the variable, never its value.

| Variable | Default | Meaning |
|---|---|---|
| `BLINDSIGNAL_ENV` | `production` | `development` trusts the dev issuer and allows every origin when none is listed. |
| `BLINDSIGNAL_REGISTRY_PATH` | required | Path of the registry file (ADR 0005). |
| `BLINDSIGNAL_PORT` | `8080` | Signaling port: WebSocket, `/healthz`, and `/readyz`. |
| `BLINDSIGNAL_ADMIN_PORT` | `9090` | Admin port: `/metrics`. |
| `BLINDSIGNAL_ADMIN_HOST` | `127.0.0.1` | IP address the admin port binds to. |
| `BLINDSIGNAL_LOG_LEVEL` | `info` | `info`, `warn`, or `error`: events below it are not written (ADR 0037). |
| `BLINDSIGNAL_ALLOWED_ORIGINS` | required in production | Comma-separated origins allowed at the upgrade, or `*`. Defense in depth, not authentication. |
| `BLINDSIGNAL_TRUSTED_PROXIES` | none | Comma-separated IPs and CIDRs whose forwarding header is honored for the client IP. |
| `BLINDSIGNAL_FORWARDED_HEADER` | `x-forwarded-for` | `x-forwarded-for` or `cf-connecting-ip`. |
| `BLINDSIGNAL_ICE_SERVERS` | `[]` | JSON array of `{ "urls": [...] }`, STUN only, sent in `rtc.ice_config` (ADR 0009). |
| `BLINDSIGNAL_TURN_URLS` | none (off) | Comma-separated `turn:` and `turns:` URLs, sent in `rtc.ice_config` with a credential minted for each message (ADR 0017). |
| `BLINDSIGNAL_TURN_SECRET` | none | The secret shared with the TURN server (Coturn `static-auth-secret`), at least 32 bytes; required with `BLINDSIGNAL_TURN_URLS`. |
| `BLINDSIGNAL_TURN_CREDENTIAL_TTL_SECONDS` | `900` | Lifetime of each TURN credential, at least the maximum token lifetime plus the clock skew (ADR 0009), and at most `86400` (ADR 0017). |
| `BLINDSIGNAL_TOKEN_MAX_LIFETIME_SECONDS` | `600` | Maximum `exp - iat` (ADR 0006). |
| `BLINDSIGNAL_TOKEN_CLOCK_SKEW_SECONDS` | `60` | Clock-skew tolerance on token times. |
| `BLINDSIGNAL_TOKEN_MAX_NAMESPACES` | `100` | Maximum namespaces in one token. |
| `BLINDSIGNAL_JWKS_TIMEOUT_SECONDS` | `5` | Timeout of each fetch of an application's `jwksUri` (spec §5.3). |
| `BLINDSIGNAL_JWKS_CACHE_SECONDS` | `600` | How long a fetched key set is kept. |
| `BLINDSIGNAL_JWKS_COOLDOWN_SECONDS` | `30` | Minimum time between fetches of one issuer's key set, after an unknown `kid` or a failed fetch. |
| `BLINDSIGNAL_JWKS_MAX_BYTES` | `65536` | A larger key set response fails the fetch. |
| `BLINDSIGNAL_HEARTBEAT_INTERVAL_SECONDS` | `30` | WebSocket ping interval. |
| `BLINDSIGNAL_CLOSE_TIMEOUT_SECONDS` | `5` | A connection the server closes is terminated when its client has not answered the close this long after (ADR 0011). |
| `BLINDSIGNAL_SHUTDOWN_DELAY_SECONDS` | `0` | On `SIGTERM`, readiness fails and upgrades get HTTP `503` this long before the connections close. Set it to the time the load balancer takes to stop routing to a failing instance (ADR 0031). |
| `BLINDSIGNAL_STARTUP_TIMEOUT_SECONDS` | `30` | A server not listening this long after it started, such as one waiting on an unreachable Redis, logs `server.start_failed` and exits with `1` (ADR 0031). |
| `BLINDSIGNAL_SHUTDOWN_TIMEOUT_SECONDS` | `8` | Deadline of the shutdown, delay included, above the delay; past it the server logs `server.shutdown_timeout` and exits with `1`. Keep it below the platform's grace period: 10 seconds on Cloud Run and in `docker stop` (ADR 0031). |
| `BLINDSIGNAL_MAX_CONNECTION_SECONDS` | `0` (none) | Each connection is closed with `1001` between 90% and 100% of this lifetime; the SDK reconnects. Set it below the hosting platform's request timeout, such as Cloud Run's (ADR 0029). |
| `BLINDSIGNAL_PRESENCE_LEASE_SECONDS` | `90` | Presence lease and quota-slot lease, renewed on every answered ping. |
| `BLINDSIGNAL_NEGOTIATION_TIMEOUT_SECONDS` | `30` | How long a session may stay `pending`. |
| `BLINDSIGNAL_DEVICE_TTL_DAYS` | `30` | A device record not seen for this long stops counting toward the quota. |
| `BLINDSIGNAL_DEVICE_SWEEP_INTERVAL_SECONDS` | `3600` | How often expired device records are deleted (ADR 0012). |
| `BLINDSIGNAL_DATABASE_URL` | unset | A `postgres://` URL: device records and the last accepted registry go to PostgreSQL, shared by every instance. Unset keeps them in memory, for one instance (ADR 0021). Connect as the role that owns the tables, as the migration command does (ADR 0027); for Supabase, see `docs/supabase.md`. |
| `BLINDSIGNAL_DATABASE_POOL_SIZE` | `10` | Connections in the PostgreSQL pool. |
| `BLINDSIGNAL_REDIS_URL` | unset | A `redis://` or `rediss://` URL: presence, sessions, quotas, rate limits, and `jti` claims are shared by every instance through Redis or Valkey. Requires `BLINDSIGNAL_DATABASE_URL`. Unset keeps them in memory, for one instance (ADR 0023). Run it with `maxmemory-policy noeviction`, and restart every instance after it loses data: until then, a used token can authenticate again (ADR 0035). |
| `BLINDSIGNAL_REDIS_PREFIX` | `blindsignal:` | Starts every Redis key and channel. Give each deployment sharing a Redis its own: pub/sub ignores the database number (ADR 0022). |
| `BLINDSIGNAL_REDIS_COMMAND_TIMEOUT_SECONDS` | `2` | A Redis operation not answered within it fails, as when Redis is unreachable (ADR 0023). |
| `BLINDSIGNAL_REGISTRY_SYNC_INTERVAL_SECONDS` | `60` | With `BLINDSIGNAL_REDIS_URL`, how often each instance rereads the stored registry, in case it missed another instance's reload (ADR 0024). |
| `BLINDSIGNAL_DEPENDENCY_PROBE_TIMEOUT_SECONDS` | `2` | How long a scrape of `/metrics` waits for each dependency's probe before reporting it down (ADR 0028). |
| `BLINDSIGNAL_MAX_MESSAGE_BYTES` | `65536` | Maximum message size in UTF-8 bytes, at most `65536` (docs/protocol.md §1). |
| `BLINDSIGNAL_AUTHENTICATION_TIMEOUT_SECONDS` | `10` | A connection not authenticated this long after it opened is closed with `1008`. |
| `BLINDSIGNAL_MAX_UNAUTHENTICATED_PER_IP` | `20` | Concurrent unauthenticated connections per client IP; more get HTTP `429` at the upgrade. |
| `BLINDSIGNAL_MAX_UNAUTHENTICATED` | `1000` | Concurrent unauthenticated connections in all; more get HTTP `429` at the upgrade. |
| `BLINDSIGNAL_MAX_CONNECTIONS` | `0` (none) | Open connections on this instance, authenticated or not; more get HTTP `503` at the upgrade. Set it at or below the platform's concurrency per instance, such as Cloud Run's (ADR 0030). |
| `BLINDSIGNAL_RATE_LIMIT_CONNECTION_ATTEMPTS` | `5,20` | Connection attempts per client IP, as `rate,burst`; more get HTTP `429` with `Retry-After`. |
| `BLINDSIGNAL_RATE_LIMIT_AUTHENTICATION` | `1,10` | `auth.authenticate` and `auth.refresh` per client IP, as `rate,burst`; more get `rate_limited`. Devices on one development machine share `127.0.0.1`: tests with many of them raise this and `BLINDSIGNAL_RATE_LIMIT_CONNECTION_ATTEMPTS`, as `examples/minimal-app/playwright.config.ts` does. |
| `BLINDSIGNAL_MAX_QUEUED_MESSAGES` | `1024` | Frames and events waiting on one connection, at least `2`; reading pauses at half, and a full queue closes with `1013` (ADR 0013). |
| `BLINDSIGNAL_MAX_BUFFERED_BYTES` | `1048576` | Bytes waiting in one connection's send buffer, at least `65536`; more close with `1013` (ADR 0013). |
| `BLINDSIGNAL_ABUSE_ALERT_THRESHOLD` | `0` (off) | An application's `rate_limited` and `quota_exceeded` errors within one window that raise an abuse alert (ADR 0016). |
| `BLINDSIGNAL_ABUSE_ALERT_WINDOW_SECONDS` | `60` | The abuse alert's window. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset (off) | An OTLP/HTTP endpoint, such as `http://collector:4318`: metrics are also pushed there (ADR 0038). `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`, the full URL, turns it on too, and `OTEL_EXPORTER_OTLP_HEADERS` adds headers, such as a backend's credentials. |
| `OTEL_METRIC_EXPORT_INTERVAL` | `60000` | Milliseconds between OTLP pushes. |

The pre-authentication limits are keyed by the client IP (`BLINDSIGNAL_TRUSTED_PROXIES`) and apply
to every application, which is not known yet (ADR 0011). The unauthenticated caps count this
instance's connections; the rate-limit buckets live in the coordination adapter.

Quotas and rate limits (ADR 0011) are server defaults: an application's registry entry overrides
each one under `quotas` and `rateLimits`. Load tests validate the defaults before every minor and
major release (ADR 0049); `docs/load-report.md` has each run's results. A rate limit is `rate,burst`: tokens added per second, and the bucket's size.

| Variable | Default | Registry key |
|---|---|---|
| `BLINDSIGNAL_MAX_CONNECTIONS_PER_APP` | `10000` | `quotas.connections` |
| `BLINDSIGNAL_MAX_DEVICES_PER_APP` | `10000` | `quotas.devices` |
| `BLINDSIGNAL_MAX_SESSIONS_PER_APP` | `10000` | `quotas.sessions` |
| `BLINDSIGNAL_MAX_SESSIONS_PER_DEVICE` | `16` | `quotas.sessionsPerDevice` |
| `BLINDSIGNAL_MAX_NAMESPACES_PER_DEVICE` | `100` | `quotas.namespacesPerDevice` |
| `BLINDSIGNAL_MAX_SESSION_DURATION_SECONDS` | `0` (no limit) | `quotas.sessionDurationSeconds` |
| `BLINDSIGNAL_RATE_LIMIT_DISCOVERY` | `2,10` | `rateLimits.discovery` |
| `BLINDSIGNAL_RATE_LIMIT_SESSION_CREATE` | `2,10` | `rateLimits.session_create` |
| `BLINDSIGNAL_RATE_LIMIT_PAIRING` | `0.1,3` | `rateLimits.pairing` |
| `BLINDSIGNAL_RATE_LIMIT_SIGNALING` | `50,100` | `rateLimits.signaling` |
| `BLINDSIGNAL_RATE_LIMIT_RTC` | `10,30` | `rateLimits.rtc` |
| `BLINDSIGNAL_RATE_LIMIT_RTC_ICE_CANDIDATE` | `20,50` | `rateLimits.rtc_ice_candidate` |

Every quota and rate limit is enforced. Signaling, discovery, session creation, and
`pairing.create` are counted per connection, and `rtc.*` per session; every frame takes a signaling token, malformed ones and those
sent before authentication too, under the server default until the application is known. A
message above a limit gets `rate_limited` with `retryAfterMs` and is dropped; the connection stays
open. A connection reads its application's limits at `auth.authenticate` and each `auth.refresh`,
so a reloaded registry's limits apply from its next refresh.

## PostgreSQL

Apply the migrations before each release, with the same `BLINDSIGNAL_DATABASE_URL`; the server
refuses to start on a schema behind its release (ADR 0019):

```sh
BLINDSIGNAL_DATABASE_URL=postgres://... pnpm --filter @blindsignal/storage-postgresql migrate
# In the container image:
docker run --rm -e BLINDSIGNAL_DATABASE_URL blindsignal node adapters/storage/postgresql/src/migrate-command.ts
```

The registry file stays the control plane. At startup and on `SIGHUP` it is checked against the
registry stored by any instance, so a revoked application cannot be reactivated after a restart
or by another instance (ADR 0021). With the database down, authentications and `auth.refresh`
get `server_error` and reconnect with backoff, and reloads are rejected.

## Several instances

With `BLINDSIGNAL_DATABASE_URL` and `BLINDSIGNAL_REDIS_URL` set, any number of instances serve one
deployment behind a load balancer: devices on different instances discover each other, open
sessions, and signal (ADR 0023). Redis runs standalone or with Sentinel, not as a Cluster
(ADR 0022). With Redis down, operations fail with `server_error` and clients reconnect with
backoff. A `SIGHUP` to one instance reaches the others through Redis, or at their next sync when
Redis was down (ADR 0024); signal one instance, not every one. When an instance fails, its
clients reconnect on the others, and their peers' sessions end within one heartbeat; set
`BLINDSIGNAL_MAX_SESSION_DURATION_SECONDS` so a session whose peer never returns ends too
(ADR 0026).

## Signals

- `SIGHUP` reloads the registry file, all or nothing, and closes the connections of suspended,
  revoked, or removed applications and of revoked devices (ADR 0005). With Compose:
  `docker compose kill -s SIGHUP server`. One sent during startup reloads once the server can.
- `SIGTERM` and `SIGINT` fail readiness, wait `BLINDSIGNAL_SHUTDOWN_DELAY_SECONDS`, close every
  connection with `1001`, and exit with `0` once sessions and presence are released, or with `1`
  after `BLINDSIGNAL_SHUTDOWN_TIMEOUT_SECONDS` (ADR 0031).

## Logs and metrics

Logs are one JSON object per line on stdout, with `time`, `level`, and `event`, plus the
connection ID, application ID, client IP, or error code where they apply. They never carry tokens,
secrets, payloads, `sub`, or `device_id`. The server keeps no logs itself; keep those with a
client IP (`connection.opened`) for at most 14 days (`docs/adr/0012-metadata-retention.md`).
Storage logs `storage.ready`, `storage.connection_lost`, `connection.failed` (with the error's
SQLSTATE or name), `devices.expired`, and `devices.sweep_failed` (ADR 0021); coordination logs
`coordination.ready` and `coordination.connection_lost` (ADR 0023), and the registry logs
`registry.publish_failed` and `registry.sync_failed` (ADR 0024).

`BLINDSIGNAL_LOG_LEVEL` drops the events below it; at `warn`, no per-connection event, and so no
client IP, is written. An uncaught exception or unhandled rejection logs `server.crashed` with its
`origin`, the error's name as `reason`, and its stack frames, never its message, then exits with
`1` (ADR 0037). A failed startup logs `server.start_failed` and exits with `1`: its `reason` is the
message of a configuration, registry, or schema error, which names keys and versions only, and
otherwise the error's name, with its `code` when it has one (ADR 0037).

Metrics go through the OpenTelemetry SDK (ADR 0038). `GET /metrics` on the admin port serves
them, process-local, in the Prometheus text format; a counter appears once first incremented.
With `OTEL_EXPORTER_OTLP_ENDPOINT` set they are also pushed over OTLP/HTTP, with `service.name`
`blindsignal` and a `service.instance.id` per process; a failed push logs
`telemetry.export_failed`, and on `SIGTERM` the server pushes once more within the shutdown's
deadline. The series: messages by type, authentications by result, errors by code, sessions created and
terminated, pairings by result, registry reloads, connections closed by backpressure, open connections, and sessions
(counted by the instance of the connection that requested each, ADR 0023), and device records
deleted by the retention sweep (`blindsignal_devices_expired_total`).

It also reports the process (ADR 0037): `process_start_time_seconds`, which changes on every
restart, `process_resident_memory_bytes`, `nodejs_heap_size_used_bytes`, and
`nodejs_eventloop_delay_seconds{stat="p99"|"max"}`, the event loop's delay since the previous
collection. Each scrape or push resets the delay, so read each instance from one place.

Two histograms, in seconds (ADR 0038): `blindsignal_authentication_duration_seconds{result}`, from
an `auth.authenticate`'s receipt to its reply, by the result `blindsignal_authentications_total`
counts; and `blindsignal_session_acceptance_seconds`, from `session.create` to `session.accepted`,
measured by the requester's connection.

Each scrape also probes PostgreSQL and Redis, when configured, and reports
`blindsignal_dependency_up{dependency="postgresql"|"redis"}`: 1 when the probe answered within
`BLINDSIGNAL_DEPENDENCY_PROBE_TIMEOUT_SECONDS`, 0 otherwise. Alert on it: `/readyz` never depends
on PostgreSQL or Redis, so an outage keeps every instance in the load balancer (ADR 0028).
`/healthz` is liveness, and `/readyz` fails only while the server drains.
The `blindsignal_application_*` series break connections, sessions, messages, sessions created,
and errors down by application (`app_id`), once a token is verified
(`docs/adr/0015-application-usage-metrics.md`).

An application whose `rate_limited` and `quota_exceeded` errors reach
`BLINDSIGNAL_ABUSE_ALERT_THRESHOLD` within one window logs `application.abuse_suspected` (`warn`)
and counts `blindsignal_abuse_alerts_total{app_id}`, once per window. The server does not suspend
it: set `status: "suspended"` in the registry and send `SIGHUP` (ADR 0005, ADR 0016).

With TURN configured, `blindsignal_turn_credentials_issued_total{app_id}` counts the credentials
sent in `rtc.ice_config`, one per authentication and `auth.refresh`. Relay traffic is measured by
the TURN server's own metrics, not here (`docs/adr/0017-turn-credentials.md`); `docs/turn-operations.md`
configures the TURN server.

Spec §18's initial metrics, and where each one is:

| Spec §18 | Here |
|---|---|
| Active WebSocket connections | `blindsignal_connections` |
| Authentication success/failure | `blindsignal_authentications_total{result}` |
| Rejected unknown or suspended applications | `blindsignal_authentications_total{result="application_unavailable"}` for a suspended or revoked application; an issuer missing from the registry counts as `invalid_token` |
| Active connections and sessions per application | `blindsignal_application_connections`, `blindsignal_application_sessions` |
| Rate-limit events, quota consumption | `blindsignal_application_errors_total{code="rate_limited"\|"quota_exceeded"}`, `blindsignal_abuse_alerts_total` |
| Presence registration and expiration | `blindsignal_messages_total{type="namespace.join"\|"namespace.leave"}`; a lease that expires is not counted, and `blindsignal_devices_expired_total` counts device records |
| Session creation and failure | `blindsignal_sessions_created_total`, `blindsignal_sessions_terminated_total{reason}`, and the time to acceptance in `blindsignal_session_acceptance_seconds` |
| Pairing | `blindsignal_pairings_total{result}`: `approved`, `rejected`, or `timeout`, counted by the requester's instance (ADR 0042) |
| Signaling message counts and errors | `blindsignal_messages_total{type}`, `blindsignal_errors_total{code}` |
| Reconnection frequency | `blindsignal_authentications_total`, against `blindsignal_connections` |
| WebRTC negotiation success/failure, direct versus relay, ICE connection duration | Not here: they happen between the browsers. The SDK reports each session's connection type to the application (`packages/sdk`); relay traffic is on the TURN server |
