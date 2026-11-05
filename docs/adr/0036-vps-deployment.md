# VPS deployment and TURN on the signaling host

**Status:** accepted

Phase 10 asks for VPS deployment to be documented. A VPS is the host `examples/self-hosted/` already
targets (ADR 0032): one Linux machine with a public address. What a VPS adds is the internet in front
of it, so a firewall, and the question of where TURN runs. `docs/turn-operations.md` puts `turns:`
on port 443 for networks that allow only HTTPS, but on one address Caddy already holds 443.

## Rules

- **Coturn runs on the signaling host, as the `turn` profile of `examples/self-hosted/`,** on the
  host's network: the relay needs a range of UDP ports, which Docker cannot publish one by one at
  any practical cost. Without the profile, nothing changes.
- **`turn:` on 3478 over UDP and TCP, and `turns:` on 5349.** Caddy keeps 443. A network that allows
  only HTTPS reaches neither; such clients need a TURN server on an address of its own, with
  `turns:` on 443 (`docs/turn-operations.md`).
- **`turns:` uses Caddy's certificate,** for the signaling domain, read from Caddy's data volume.
  Coturn runs as root with no capability but `NET_BIND_SERVICE`, which its binary carries as a
  file capability, to read a key Caddy keeps as root's with mode 600. A daily `SIGUSR2` makes Coturn
  reload the certificate after Caddy renews it, without ending allocations.
- **The TURN secret reaches Coturn through the environment** and a file written in a `tmpfs` at
  startup, never its command line. Coturn's configuration, without the secret, is
  `examples/self-hosted/turnserver.conf`, with the peer restrictions of `docs/turn-operations.md`.
  Amended by the Phase 12 abuse review: `BLINDSIGNAL_TURN_PUBLIC_IP` lists the host's public
  addresses, which the startup adds as `denied-peer-ip`; without it, Coturn does not start.
- **The firewall is the provider's, or `ufw`, with the same ports open:** SSH, 80, 443, and with
  TURN 3478, 5349, and the relay range. Ports Docker publishes bypass `ufw`, so `compose.yaml`
  publishes only 80 and 443 to the internet and `/metrics` on loopback; Coturn, on the host's
  network, is behind `ufw` like any host process.

## Considered options

- **Coturn on a second host or address, with `turns:` on 443.** Rejected as the default: a second
  machine for what one serves, for the minority of networks that allow only 443. It stays the
  documented path for them.
- **Caddy routing 443 to Coturn by SNI.** Rejected: the stock Caddy has no TCP routing by SNI, and a
  plugin build is another image to maintain.
- **Coturn's ports published by Docker.** Rejected: one proxy per port for 16384 relay ports, or a
  narrow relay range that limits concurrent allocations.
- **The secret on Coturn's command line,** from `.env` through Compose. Rejected: any user on the
  host sees it in the process list (ADR 0034).
- **A certificate of Coturn's own.** Rejected: a second ACME client for the same name Caddy already
  certifies.
- **Rules in Docker's `DOCKER-USER` chain.** Rejected: nothing Docker publishes needs filtering, and
  the rules would be one more thing to keep across Docker upgrades.

## Consequences

- One host is one point of failure for signaling and relay, and the relay shares its bandwidth.
- The setup was tested on a simulated host, a privileged Docker-in-Docker container reached from a
  second container; it has not run on a real VPS yet.
