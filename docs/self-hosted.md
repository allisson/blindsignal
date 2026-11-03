# Self-hosted deployment

BlindSignal on one host with Docker Compose: Caddy terminates TLS, one server instance signals,
and PostgreSQL keeps device records and the registry. The files are in `examples/self-hosted/`;
the decisions behind them are in `docs/adr/0032-self-hosted-compose.md`.

## Requirements

- A Linux host with Docker Engine and the Compose plugin.
- A DNS record pointing the signaling domain, such as `signal.example.com`, at the host.
- Ports 80 and 443 reachable from the internet: Caddy answers Let's Encrypt's challenge on them and
  serves `wss://` on 443.
- The public keys of each application that will issue tokens (`docs/token-issuance.md`).

## Setup

1. Clone the repository on the host and enter `examples/self-hosted/`. The image is built from the
   repository.
2. Create `.env` from the example, readable by you only, and fill it in:

   ```sh
   cp .env.example .env
   chmod 600 .env
   sed -i "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$(openssl rand -hex 32)/" .env
   ```

   Set `BLINDSIGNAL_DOMAIN` and `BLINDSIGNAL_ALLOWED_ORIGINS`, the web origins of your
   applications. Any other variable of `apps/server/README.md` can be added there too.
3. Write `registry.json`, the control plane (ADR 0005): one entry per application, with its
   issuer and its `jwksUri` or `publicKeys`, as `docs/token-issuance.md` describes. The server
   refuses to start on an invalid registry and names the field.
4. Start it:

   ```sh
   docker compose up -d --build --wait
   ```

   `migrate` applies the migrations and exits, then the server starts, then Caddy obtains the
   certificate.

## Checks

- `curl https://signal.example.com/readyz` answers `ok`.
- `docker compose logs migrate` ends with `applied 1, 2`, or `schema up to date` on later starts.
- `docker compose logs server` shows `storage.ready` with `postgresql`, and `server.listening`.
- `curl http://127.0.0.1:9090/metrics`, on the host, shows
  `blindsignal_dependency_up{dependency="postgresql"} 1`.
- The SDK connects with `wss://signal.example.com`, and the `ip` of `connection.opened` in the
  server's logs is the client's, not Caddy's `172.30.0.10`.

## Operations

- **Registry changes:** edit `registry.json`, then
  `docker compose kill -s SIGHUP server`. The reload is all or nothing, and closes the connections
  of suspended, revoked, or removed applications (ADR 0005); `registry.reloaded` or
  `registry.reload_rejected` in the logs tells which. `docs/application-lifecycle.md` covers
  onboarding, suspension, and revocation.
- **Secrets:** rotate the PostgreSQL password with `docs/secrets-and-keys.md`; editing
  `POSTGRES_PASSWORD` in `.env` alone breaks the migration.
- **Upgrades:** `git pull`, then `docker compose up -d --build --wait`. The migrations run before
  the new server starts; clients reconnect on their own after the old one closes their
  connections with `1001` (ADR 0031).
- **Logs:** `docker compose logs -f server`, one JSON object per line, with no token, secret, or
  payload (`apps/server/README.md`).
- **TURN:** the `turn` profile runs Coturn on this host (`docs/vps.md`), or run it elsewhere as
  `docs/turn-operations.md` describes; either way, set `BLINDSIGNAL_TURN_URLS` and
  `BLINDSIGNAL_TURN_SECRET` in `.env`.
- **Backups:** keep `.env` and `registry.json` off the host, and dump the `postgres-data` volume's
  database daily; `docs/backup-and-recovery.md` has the commands and the restore.

## Limits

- One instance: a restart closes every connection, and clients reconnect when it is back. Several
  instances need Redis and a load balancer (`apps/server/README.md`, ADR 0023).
- The address range `172.30.0.0/24` is fixed in `compose.yaml`; change it, and
  `BLINDSIGNAL_TRUSTED_PROXIES` with it, if the host already uses that range.
