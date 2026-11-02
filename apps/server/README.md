# BlindSignal server

The signaling server: WebSocket on `node:http` (ADR 0001), in-memory adapters, and the registry
file as control plane (ADR 0005). It runs its TypeScript sources through Node's type stripping, in
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

`examples/registry.dev.json` registers the `notes` application with the development issuer, whose
private key is public in this repository; it loads only with `BLINDSIGNAL_ENV=development`. Tokens
for it come from `mintDevToken` in `packages/dev-issuer`.

The image (`Dockerfile`) runs in production mode by default and needs at least
`BLINDSIGNAL_REGISTRY_PATH` and `BLINDSIGNAL_ALLOWED_ORIGINS`. It speaks plain WebSocket: put it
behind a TLS-terminating proxy and list that proxy in `BLINDSIGNAL_TRUSTED_PROXIES` (spec §16).

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
| `BLINDSIGNAL_ALLOWED_ORIGINS` | required in production | Comma-separated origins allowed at the upgrade, or `*`. Defense in depth, not authentication. |
| `BLINDSIGNAL_TRUSTED_PROXIES` | none | Comma-separated IPs and CIDRs whose forwarding header is honored for the client IP. |
| `BLINDSIGNAL_FORWARDED_HEADER` | `x-forwarded-for` | `x-forwarded-for` or `cf-connecting-ip`. |
| `BLINDSIGNAL_ICE_SERVERS` | `[]` | JSON array of `{ "urls": [...] }`, STUN only, sent in `rtc.ice_config` (ADR 0009). |
| `BLINDSIGNAL_TOKEN_MAX_LIFETIME_SECONDS` | `600` | Maximum `exp - iat` (ADR 0006). |
| `BLINDSIGNAL_TOKEN_CLOCK_SKEW_SECONDS` | `60` | Clock-skew tolerance on token times. |
| `BLINDSIGNAL_TOKEN_MAX_NAMESPACES` | `100` | Maximum namespaces in one token. |
| `BLINDSIGNAL_HEARTBEAT_INTERVAL_SECONDS` | `30` | WebSocket ping interval. |
| `BLINDSIGNAL_PRESENCE_LEASE_SECONDS` | `90` | Presence lease, renewed on every answered ping. |
| `BLINDSIGNAL_NEGOTIATION_TIMEOUT_SECONDS` | `30` | How long a session may stay `pending`. |
| `BLINDSIGNAL_DEVICE_TTL_DAYS` | `30` | A device record not seen for this long stops counting toward the quota. |
| `BLINDSIGNAL_MAX_MESSAGE_BYTES` | `65536` | Maximum message size in UTF-8 bytes, at most `65536` (docs/protocol.md §1). |
| `BLINDSIGNAL_AUTHENTICATION_TIMEOUT_SECONDS` | `10` | A connection not authenticated this long after it opened is closed with `1008`. |
| `BLINDSIGNAL_MAX_UNAUTHENTICATED_PER_IP` | `20` | Concurrent unauthenticated connections per client IP; more get HTTP `429` at the upgrade. |
| `BLINDSIGNAL_MAX_UNAUTHENTICATED` | `1000` | Concurrent unauthenticated connections in all; more get HTTP `429` at the upgrade. |
| `BLINDSIGNAL_RATE_LIMIT_CONNECTION_ATTEMPTS` | `5,20` | Connection attempts per client IP, as `rate,burst`; more get HTTP `429` with `Retry-After`. |
| `BLINDSIGNAL_RATE_LIMIT_AUTHENTICATION` | `1,10` | `auth.authenticate` and `auth.refresh` per client IP, as `rate,burst`; more get `rate_limited`. |

The pre-authentication limits are keyed by the client IP (`BLINDSIGNAL_TRUSTED_PROXIES`) and apply
to every application, which is not known yet (ADR 0011). The unauthenticated caps count this
instance's connections; the rate-limit buckets live in the coordination adapter.

Quotas and rate limits (ADR 0011) are server defaults: an application's registry entry overrides
each one under `quotas` and `rateLimits`. The defaults are starting values until load testing sets
them (spec §8.2). A rate limit is `rate,burst`: tokens added per second, and the bucket's size.

| Variable | Default | Registry key |
|---|---|---|
| `BLINDSIGNAL_MAX_CONNECTIONS_PER_APP` | `10000` | `quotas.connections` |
| `BLINDSIGNAL_MAX_DEVICES_PER_APP` | `10000` | `quotas.devices` |
| `BLINDSIGNAL_MAX_SESSIONS_PER_APP` | `10000` | `quotas.sessions` |
| `BLINDSIGNAL_MAX_SESSIONS_PER_DEVICE` | `16` | `quotas.sessionsPerDevice` |
| `BLINDSIGNAL_MAX_NAMESPACES_PER_DEVICE` | `100` | `quotas.namespacesPerDevice` |
| `BLINDSIGNAL_RATE_LIMIT_DISCOVERY` | `2,10` | `rateLimits.discovery` |
| `BLINDSIGNAL_RATE_LIMIT_SESSION_CREATE` | `2,10` | `rateLimits.session_create` |
| `BLINDSIGNAL_RATE_LIMIT_SIGNALING` | `50,100` | `rateLimits.signaling` |
| `BLINDSIGNAL_RATE_LIMIT_RTC` | `10,30` | `rateLimits.rtc` |
| `BLINDSIGNAL_RATE_LIMIT_RTC_ICE_CANDIDATE` | `20,50` | `rateLimits.rtc_ice_candidate` |

Of these, only the connection and device quotas are enforced so far; the other limits are enforced as
the Phase 6 tasks land (docs/roadmap.md).

## Signals

- `SIGHUP` reloads the registry file, all or nothing, and closes the connections of suspended,
  revoked, or removed applications and of revoked devices (ADR 0005). With Compose:
  `docker compose kill -s SIGHUP server`.
- `SIGTERM` and `SIGINT` fail readiness, close every connection with `1001`, and exit once
  sessions and presence are released.

## Logs and metrics

Logs are one JSON object per line on stdout, with `time`, `level`, and `event`, plus the
connection ID, application ID, client IP, or error code where they apply. They never carry tokens,
secrets, payloads, `sub`, or `device_id`.

`GET /metrics` on the admin port serves process-local counters and gauges in the Prometheus text
format: messages by type, authentications by result, errors by code, sessions created and
terminated, registry reloads, open connections, and sessions.
