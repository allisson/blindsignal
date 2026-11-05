# Deployment

Where to start when deploying BlindSignal: choosing a topology, what every production deployment
needs, and how to upgrade one. The setups themselves are in the guides this document links; every
setting is in `apps/server/README.md#configuration`. An application team's side is in
`docs/onboarding.md`.

## Choosing a topology

| Topology | Instances | Guide | Tested |
|---|---|---|---|
| Local development, in memory | One | `apps/server/README.md#running`, `docs/external-testing.md` | In CI, and across networks through Cloudflare Quick Tunnels (`docs/connectivity-report.md`) |
| One host: Compose, Caddy, PostgreSQL | One | `docs/self-hosted.md` | CI builds the image, runs it read-only, and validates the Compose file (ADR 0033) |
| One VPS: the above behind a firewall, with Coturn | One | `docs/vps.md` | On a simulated host, not on a provider's VPS |
| Cloud Run | One, or several with PostgreSQL and Redis | `docs/cloud-run.md` | Not on Cloud Run: the image ran locally with its settings |
| Several instances behind a load balancer | Any | `apps/server/README.md#several-instances` | Two instances in CI, and in the load tests (`docs/load-report.md`) |

They combine with:

- **PostgreSQL** (`BLINDSIGNAL_DATABASE_URL`): device records and the registry survive a restart,
  and several instances share them. Any PostgreSQL, or Supabase's (`docs/supabase.md`).
- **Redis or Valkey** (`BLINDSIGNAL_REDIS_URL`): needed by several instances, for presence,
  sessions, quotas, and rate limits. Standalone or with Sentinel, not as a Cluster (ADR 0022).
- **TURN** (`docs/turn-operations.md`): optional. Without it, sessions connect only where a direct
  path exists; with it, browsers on networks that block direct paths relay through it. It needs a
  host with UDP, which Cloud Run is not.

Without PostgreSQL, one instance keeps everything in memory: a restart forgets every device, and
the in-memory adapters are never safe for several instances. Development mode
(`BLINDSIGNAL_ENV=development`) trusts the development issuer, whose private key is public in this
repository; never expose it.

## Every production deployment

- [ ] `BLINDSIGNAL_ENV` is unset or `production`, and the registry names no development issuer.
- [ ] A TLS-terminating proxy serves `wss://`, and `BLINDSIGNAL_TRUSTED_PROXIES` lists that proxy
      only, never `0.0.0.0/0`: the per-IP limits key on the client IP it forwards.
- [ ] `BLINDSIGNAL_ALLOWED_ORIGINS` lists the origins of every application's pages.
- [ ] The admin port, with `/metrics`, is not reachable from the internet; it binds to
      `127.0.0.1` by default.
- [ ] Behind a platform with a request timeout or a connection cap per instance,
      `BLINDSIGNAL_MAX_CONNECTION_SECONDS` and `BLINDSIGNAL_MAX_CONNECTIONS` sit below them
      (ADR 0029, ADR 0030), and `BLINDSIGNAL_SHUTDOWN_TIMEOUT_SECONDS` below its grace period
      (ADR 0031).
- [ ] With several applications and `BLINDSIGNAL_MAX_CONNECTIONS` set, each application's
      `quotas.connections` sits below what the instances hold together, so one application cannot
      take every instance's connections (ADR 0011).
- [ ] With PostgreSQL, the migrations run before each release, as the role that owns the tables
      (`apps/server/README.md#postgresql`), and a daily backup is restored once to check it
      (`docs/backup-and-recovery.md`).
- [ ] With Redis, `maxmemory-policy` is `noeviction`, each deployment sharing it has its own
      `BLINDSIGNAL_REDIS_PREFIX`, and every instance restarts after Redis loses data
      (ADR 0035). Outside a private network of its own, Redis takes a password over
      `rediss://`.
- [ ] OTLP credentials in `OTEL_EXPORTER_OTLP_HEADERS` go only to an `https://` endpoint.
- [ ] With TURN, `denied-peer-ip` covers the ranges of `docs/turn-operations.md` and the TURN
      host's own public addresses.
- [ ] Each secret has an owner and a rotation (`docs/secrets-and-keys.md`).
- [ ] Logs with a client IP are kept 14 days at most (ADR 0012): `BLINDSIGNAL_LOG_LEVEL=warn`
      writes none, or the log store deletes them.
- [ ] Metrics are scraped from `/metrics` or pushed over OTLP (ADR 0038), and someone watches
      them; set `BLINDSIGNAL_ABUSE_ALERT_THRESHOLD` to turn the abuse alert on (ADR 0016).
- [ ] Quotas and rate limits stay at the defaults the load tests validated
      (`docs/load-report.md`), or an application's registry entry overrides them.

Registering, suspending, and revoking applications and devices is in
`docs/application-lifecycle.md`.

## Upgrading

The server follows semantic versioning (ADR 0043), and ADR 0044 sets what an upgrade may assume.
Each guide has the commands for its platform: `docs/self-hosted.md#operations`,
`docs/cloud-run.md#releases-and-registry-changes`.

1. **Go one minor version at a time.** A rolling upgrade is supported between consecutive minor
   versions of one major, and from the latest minor of major N to `N+1.0.0`; to skip versions, go
   through each in turn. A major version that cannot run next to its predecessor says so in its
   `CHANGELOG.md` entry, and its upgrade stops every instance first.
2. **Back up PostgreSQL** (`docs/backup-and-recovery.md`).
3. **Apply the new release's migrations** before any instance of it starts. The instances still
   running keep working: a migration keeps the previous version working, and a server accepts a
   schema newer than its own (ADR 0019).
4. **Replace the instances.** Each one fails readiness, waits `BLINDSIGNAL_SHUTDOWN_DELAY_SECONDS`,
   and closes its connections with `1001`; the SDK reconnects to another instance or to the new
   one (ADR 0031). With several instances, replace them one at a time, and set the delay to the
   time the load balancer takes to stop routing to a failing instance.
5. **Check** `/readyz`, `storage.ready` and `coordination.ready` in the logs, and
   `blindsignal_dependency_up` on `/metrics`.

**Rolling back** is redeploying the previous minor version, which accepts the newer schema.
Migrations are never reverted.

**A new protocol major** reaches the server first, in a minor version that speaks both majors.
Applications adopt the SDK of the new major once every instance speaks it. The server drops the
old major only in a later major version, at least 6 months after the first SDK release of the new
one (ADR 0044).

Until `1.0.0`, only the latest release of each artifact gets fixes.
