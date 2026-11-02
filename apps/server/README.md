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
| `BLINDSIGNAL_MAX_DEVICES_PER_APP` | `10000` | Device quota of an application that sets none (ADR 0011). |

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
