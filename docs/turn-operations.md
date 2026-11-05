# Operating TURN

How to run a TURN server for BlindSignal (roadmap Phase 8, ADR 0017). TURN is optional: without it,
sessions connect wherever a direct path exists, and `rtc.ice_config` carries only the STUN servers.
With it, browsers on networks that block direct paths relay through it. The relay sees only
DTLS-encrypted traffic, never payloads (spec §12.3). This guide uses Coturn 4.18, the version the
tests run. Its configuration has not run in a deployment yet: the tests use a Coturn on loopback,
and the cross-network test is deferred (ADR 0017). To run it on the signaling host, with
`examples/self-hosted/`, see `docs/vps.md`.

## The shared secret

The signaling server mints each credential from a secret it shares with Coturn (ADR 0017). Generate
one, and give the same value to both:

```sh
openssl rand -base64 48
```

- `BLINDSIGNAL_TURN_SECRET` on the signaling server, and `static-auth-secret` with `use-auth-secret`
  on Coturn.
- `BLINDSIGNAL_TURN_URLS` lists the URLs clients use, for example
  `turn:turn.example.com:3478?transport=udp,turns:turn.example.com:443?transport=tcp`.
- Changing the secret invalidates the credentials already issued for new allocations; clients get
  new ones at their next authentication or `auth.refresh`, within the maximum token lifetime.

## Configuration

A minimal `turnserver.conf`, with the restrictions below:

```ini
use-auth-secret
static-auth-secret=<the secret>
realm=turn.example.com
fingerprint
listening-port=3478
tls-listening-port=443
cert=/etc/coturn/cert.pem
pkey=/etc/coturn/key.pem
# Behind NAT: the public address, then the private one.
external-ip=203.0.113.10/10.0.0.10
min-port=49152
max-port=65535
no-multicast-peers
no-tcp-relay
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=::1
denied-peer-ip=fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff
denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff
denied-peer-ip=::ffff:0:0-::ffff:ffff:ffff
denied-peer-ip=64:ff9b::-64:ff9b::ffff:ffff
denied-peer-ip=<the TURN host's public address, one line each>
# Sized for the expected relayed sessions; see Limits.
user-quota=<allocations per credential>
total-quota=<allocations per server>
max-bps=<bytes per second per allocation>
prometheus
prometheus-address=10.0.0.10
```

- **Peers.** A relay sends traffic wherever its client asks, so without `denied-peer-ip` it
  reaches the network that hosts it: private ranges, loopback, link-local, and the cloud metadata
  address `169.254.169.254` (threat model §4.4). The IPv4-mapped (`::ffff:0:0/96`) and NAT64
  (`64:ff9b::/96`) ranges are denied whole, since each holds an IPv4 address the IPv4 lines deny;
  Coturn takes ranges as `first-last`, not CIDR, and refuses to start on an invalid one. The TURN
  host's own public addresses are denied too, one line each, IPv4 and IPv6: otherwise a relay
  reaches every service the host listens on, the signaling server included when they share it
  (`docs/vps.md`). Never set
  `allow-loopback-peers`. `no-tcp-relay` turns off TCP relays (RFC 6062), which browsers never
  ask for, and which would reach any TCP service, mail servers included, from the TURN server's
  address. The test Coturn of `compose.yaml` denies none of these, because its relay addresses are private container
  addresses; never copy it to production.
- **Ports.** `3478` over UDP and TCP, `443` over TCP for `turns:`, and the relay range over UDP,
  open to clients. `turns:` on `443` passes networks that allow only HTTPS. A `turns:` URL needs a
  certificate browsers trust, for the host name in the URL; Firefox rejects any other.
- **Limits.** Each credential is its own Coturn user, since its username carries its expiry and a
  random value:
  `user-quota` bounds the allocations of one credential, `total-quota` those of the server,
  `max-bps` the bandwidth of each, in bytes per second. Size them for the expected concurrent
  relayed sessions; `examples/self-hosted/turnserver.conf` starts from `user-quota=48` (16
  sessions of up to 3 allocations), `total-quota=1000`, and `max-bps=125000`. Never leave them
  unset: Coturn's default is no limit, and the threat model counts on them (§4.4).

## Credential expiry

A credential's expiry bounds when an allocation can be created, not how long it lasts. Coturn
4.18 checks the expiry in the username only on the allocation request; refreshes of the
allocation, its permissions, and its channels pass after it, and a relayed session lasts while its
client keeps refreshing. Neither setting changes that:

- `stale-nonce`: the client answers the `438 Stale nonce` with a new nonce and the same expired
  credential, and its permission and channel refreshes pass.
- `max-allocate-lifetime`: caps the lifetime of each refresh, not the allocation's total.

So the quotas above bound what a stolen credential relays, and restarting Coturn ends every
allocation; legitimate sessions recover through the SDK's ICE restart with the latest
`rtc.ice_config` (ADR 0017).

To check another Coturn version or TURN server, open a relayed DataChannel between two peer
connections in one browser, with a credential that expires in 15 s, and keep sending past the
browser's permission refresh, about 5 minutes. The TURN server runs on loopback with verbose logs,
which show each refresh and its result:

```sh
docker run --rm --name turn-probe -p 127.0.0.1:3478:3478/udp coturn/coturn:4.18.0 \
  --use-auth-secret --static-auth-secret=blindsignal-test-turn-secret-never-in-production \
  --realm=blindsignal.test --log-file=stdout --verbose --stale-nonce=20
```

The credential is `username = <now + 15>:notes` and
`credential = base64(HMAC-SHA1(secret, username))`, with `iceTransportPolicy: 'relay'`. On
Coturn 4.18, Chromium and Firefox both kept the channel open for 8 minutes, with and without
`stale-nonce`.

## Metrics

`prometheus` serves Coturn's metrics on port `9641`; keep it on a private address, like the
signaling server's admin port. Relay traffic is in the `turn_traffic_*` counters, aggregated by
realm. Never set `prometheus-username-labels`: Coturn warns that it leaks memory with ephemeral
usernames, and this scheme mints one per credential (ADR 0017). Relay use per application comes
from the signaling server's `blindsignal_turn_credentials_issued_total{app_id}`, one per
authentication and `auth.refresh` (`apps/server/README.md`), and from Coturn's logs, whose
usernames carry the application ID.
