# VPS deployment

BlindSignal on one VPS: the setup of `docs/self-hosted.md`, behind a firewall, with an optional TURN
relay on the same host. The decisions are in `docs/adr/0036-vps-deployment.md`. This guide was
tested on a simulated host, a privileged Docker-in-Docker container reached from a second
container, not on a provider's VPS yet.

## Requirements

- A Linux VPS with a public IPv4 address, such as Debian or Ubuntu, with Docker Engine and the
  Compose plugin installed from Docker's repository.
- A DNS record for the signaling domain, such as `signal.example.com`, pointing at it.
- With TURN, the bandwidth for the relayed sessions you expect: relayed traffic passes through the
  host twice, in and out.

## Preparing the host

- Log in with SSH keys only, and as a user other than root. Membership of the `docker` group is
  equivalent to root; give it only to operators.
- Turn on the distribution's automatic security updates, such as `unattended-upgrades`.
- Clone the repository where it will stay, such as `/opt/blindsignal`.

## Firewall

| Port | Protocol | For |
| --- | --- | --- |
| 22 | TCP | SSH, from your addresses only where the provider allows it |
| 80 | TCP | Caddy: the certificate challenge and the redirect to HTTPS |
| 443 | TCP | Caddy: `wss://` |
| 3478 | UDP and TCP | TURN, with the `turn` profile |
| 5349 | TCP | TURN over TLS, with the `turn` profile |
| 49152–65535 | UDP | TURN relay addresses, with the `turn` profile |

Open these in the provider's firewall when it has one, since it filters before the host. On the
host, `ufw` does the same:

```sh
sudo ufw default deny incoming
sudo ufw allow 22/tcp
sudo ufw allow 3478
sudo ufw allow 5349/tcp
sudo ufw allow 49152:65535/udp
sudo ufw enable
```

- **Ports Docker publishes bypass `ufw`.** Docker inserts its own rules ahead of `ufw`'s, so 80 and
  443 answer without a `ufw` rule, and a port added to `compose.yaml` would answer whatever `ufw`
  says. `compose.yaml` publishes only 80 and 443 to the internet, and `/metrics` on the host's
  loopback; keep it that way.
- **Coturn is behind `ufw`.** It runs on the host's network, so its ports need the rules above;
  without them clients cannot allocate.
- PostgreSQL has no published port and no route out (ADR 0032); nothing to open.

## Signaling

Follow the setup and checks of `docs/self-hosted.md` in `/opt/blindsignal/examples/self-hosted`.

## TURN on the same host

Coturn runs as the `turn` profile of the same Compose project, on the host's network. It uses the
signaling domain and Caddy's certificate for it, so it needs no DNS record or certificate of its
own; start it after Caddy has obtained the certificate.

1. Generate the secret, `openssl rand -base64 48`, and add it to `.env` with the URLs:

   ```sh
   BLINDSIGNAL_TURN_URLS=turn:signal.example.com:3478?transport=udp,turn:signal.example.com:3478?transport=tcp,turns:signal.example.com:5349?transport=tcp
   BLINDSIGNAL_TURN_SECRET=<the secret>
   BLINDSIGNAL_TURN_PUBLIC_IP=<this host's public addresses, space-separated>
   ```

   The relay never reaches the addresses in `BLINDSIGNAL_TURN_PUBLIC_IP`, and Coturn does not
   start without it: `curl -4 https://ifconfig.co`, and `curl -6` too if the host has IPv6.

2. Review `turnserver.conf`: set `external-ip` if the VPS sits behind NAT, as on AWS or Google
   Cloud, where its interface has a private address; and adjust `user-quota`, `total-quota`, and
   `max-bps` to the relayed sessions you expect (`docs/turn-operations.md`).
3. Start it; `up` also recreates the server with the new variables, so it issues credentials:

   ```sh
   docker compose --profile turn up -d --wait
   ```

### Checks

- `docker compose logs coturn` shows `Certificate file found` with the path of the signaling
  domain's certificate. Until Caddy has it, the container logs `waiting for the certificate from
  Caddy` and restarts.
- From another machine, `openssl s_client -connect signal.example.com:5349 -servername signal.example.com`
  shows the certificate Caddy obtained.
- A client with `iceTransportPolicy: 'relay'` connects, and the session's connection type is
  `relay` (`packages/sdk`).

### Certificate renewal

Caddy renews the certificate on its own; Coturn reads it at startup and on `SIGUSR2`, which reloads
it without ending allocations. Send it daily from the host's crontab:

```sh
15 4 * * * cd /opt/blindsignal/examples/self-hosted && docker compose kill -s SIGUSR2 coturn >/dev/null 2>&1
```

### Limits

- A network that allows only HTTPS reaches neither 3478 nor 5349. For those clients, run TURN on an
  address of its own with `turns:` on 443 (`docs/turn-operations.md`), and list it in
  `BLINDSIGNAL_TURN_URLS`.
- Restarting Coturn, or rotating its secret (`docs/secrets-and-keys.md`), ends every allocation;
  clients recover through the SDK's ICE restart.

## Operations

- Upgrades, registry changes, and logs: `docs/self-hosted.md`, with `--profile turn` on every
  `docker compose up` when TURN runs.
- Backups: the daily dump of `docs/backup-and-recovery.md`, from the same crontab.
- One host is one point of failure: a reboot closes every connection, and clients reconnect when it
  is back.
