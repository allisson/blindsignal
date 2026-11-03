# Self-hosted deployment with Compose

**Status:** accepted

Phase 10 asks for the Phase 3 Compose setup to be extended for self-hosted deployment. The
root `compose.yaml` serves development and the adapters' tests: it trusts the dev issuer, has
public passwords, and speaks plain WebSocket, which the SDK refuses beyond loopback. A
self-hosted deployment needs TLS, durable device records and registry, migrations before each
start, and its secrets out of the repository.

## Rules

- **`examples/self-hosted/` holds the deployment:** `compose.yaml`, a `Caddyfile`, and
  `.env.example`. The operator adds `.env` and `registry.json` there; both are ignored by Git.
  `docs/self-hosted.md` walks through it.
- **One server instance, with PostgreSQL and no Redis.** PostgreSQL keeps device records and the
  registry across restarts (ADR 0021); in-memory coordination is correct for one instance, and
  Redis is needed only by several (ADR 0023).
- **Caddy terminates TLS** with a certificate it obtains and renews for `BLINDSIGNAL_DOMAIN`, and
  proxies WebSocket upgrades to the server. It has a fixed address on its network, the only one in
  `BLINDSIGNAL_TRUSTED_PROXIES`, so the client IP comes from its `X-Forwarded-For` (spec §16).
- **Secrets live in `.env`, readable by the operator only** (`chmod 600`): the PostgreSQL password,
  from which Compose builds `BLINDSIGNAL_DATABASE_URL`, and the TURN secret when one is set.
- **PostgreSQL sits on an internal network,** with no published port and no route out; only the
  server and the migration reach it.
- **A one-shot `migrate` service applies the migrations,** and the server starts only after it
  succeeds (ADR 0019), so an upgrade is `docker compose up -d --build`.
- **`/metrics` is published on the host's loopback only,** like the development setup.
- **`stop_grace_period` is 10 seconds,** above the default shutdown timeout of 8, so the server
  exits on its own (ADR 0031).

## Considered options

- **Compose `secrets:` mounted as files.** Rejected: the server reads its configuration from the
  environment only, so it would need `_FILE` variables or a wrapper; on one host, whoever can read
  `.env` can read those files.
- **Redis and two server instances.** Rejected for this setup: one host gains no availability from
  a second instance on it, and `apps/server/README.md` covers several instances.
- **nginx or Traefik for TLS.** Rejected: both need certificate renewal configured apart; Caddy
  obtains and renews it with one line.
- **A `deploy/` directory.** Rejected: spec §19 has no such directory, and `examples/` already
  holds what an operator copies.

## Consequences

- The host needs ports 80 and 443 reachable and a DNS record for the domain, for the certificate.
- The image is built from the repository on the host until a published image exists.
- Backups of the `postgres-data` volume are the operator's; the roadmap's backup task covers them.
