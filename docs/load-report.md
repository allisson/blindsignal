# Load test report

Results of `tests/load/load.ts` against the server defaults (ADR 0049). Each run adds a section.

## Run 1 — 2026-11-04

Setup: one Apple M1 with 8 cores and 16 GiB, macOS 26.6.2, Node.js 26.13.0, the client and the
instances on the same machine. Two topologies: one instance with the in-memory adapters, and two
instances with PostgreSQL 18.6 and Valkey 9.1.3 in containers, on a database with no device yet.
Every default as `apps/server/README.md` lists it; 10,000 devices of one application, four per
user and namespace, opened at 500 per second; 2,500 sessions, one per user, at once, each with a
4 KiB offer and answer and 10 candidates each way.

```sh
node tests/load/load.ts
node tests/load/load.ts --instances 2 --database-url postgres://... --redis-url redis://...
```

| Phase | One instance, in memory | Two instances, PostgreSQL and Valkey |
|---|---|---|
| Fleet: connect, authenticate, join, discover | 20 s; p50 1.1 ms, p99 26 ms; no rejection | 52 s; p50 6.5 s, p99 8.2 s; 12,920 HTTP `429`, 3,792 devices retried |
| Memory with 10,000 connections | 283 MiB RSS | 200 and 166 MiB RSS, 5,000 connections each |
| Hold, 65 s: two heartbeats | No connection closed; event loop p99 12 ms | No connection closed; event loop p99 13 ms |
| Sessions: 55,000 relayed messages | 1.1 s; relay p50 304 ms, p99 455 ms; event loop p99 1.0 s; no rejection | 2.2 s; relay p50 938 ms, p99 1.2 s; event loop p99 32 ms; no rejection |
| Restart: every device reconnects | 13 s after the instance was ready; at most 5 attempts; 7,532 HTTP `429` | 11 s; at most 5 attempts; 6,177 HTTP `429` |

The session latencies are those of 2,500 negotiations started in the same instant, a burst no
deployment sees; 100 sessions at once relayed with a p99 of 31 ms in memory and 77 ms through
Valkey.

### Each default

| Default | Result |
|---|---|
| `BLINDSIGNAL_MAX_CONNECTIONS_PER_APP` `10000` | Kept: one instance holds them with 283 MiB. |
| `BLINDSIGNAL_MAX_DEVICES_PER_APP` `10000` | Kept: 10,000 devices enrolled. With PostgreSQL, new devices of one application enroll one at a time (ADR 0010), about 190 per second here: a faster burst of new devices waits, and gets HTTP `429` from the unauthenticated cap until it does. Devices already enrolled reconnect without the lock. |
| `BLINDSIGNAL_MAX_UNAUTHENTICATED` `1000` | Kept: every HTTP `429` came from it, since no device made more attempts than its per-IP buckets allow, and the SDK's backoff brought every device back within 13 s of a restart. |
| `BLINDSIGNAL_RATE_LIMIT_CONNECTION_ATTEMPTS` `5,20`, `BLINDSIGNAL_RATE_LIMIT_AUTHENTICATION` `1,10` | Kept: a device's reconnection took at most 5 attempts, under each burst. |
| `BLINDSIGNAL_RATE_LIMIT_DISCOVERY` `2,10`, `BLINDSIGNAL_RATE_LIMIT_SESSION_CREATE` `2,10`, `BLINDSIGNAL_RATE_LIMIT_SIGNALING` `50,100` | Kept: no `rate_limited`. |
| `BLINDSIGNAL_RATE_LIMIT_RTC` `10,30`, `BLINDSIGNAL_RATE_LIMIT_RTC_ICE_CANDIDATE` `20,50` | Kept: no `rate_limited` with 10 candidates each way. Both sides share a session's bucket: 25 candidates each way sent at once passed, and 26 lost their excess to `rate_limited`. |
| `BLINDSIGNAL_HEARTBEAT_INTERVAL_SECONDS` `30`, `BLINDSIGNAL_PRESENCE_LEASE_SECONDS` `90` | Kept: no connection closed over 65 s. |
| `BLINDSIGNAL_MAX_QUEUED_MESSAGES` `1024`, `BLINDSIGNAL_MAX_BUFFERED_BYTES` `1048576` | Kept: no connection closed with `1013` during the sessions. |
| `BLINDSIGNAL_MAX_SESSIONS_PER_APP` `10000`, `BLINDSIGNAL_MAX_SESSIONS_PER_DEVICE` `16`, `BLINDSIGNAL_MAX_NAMESPACES_PER_DEVICE` `100`, `BLINDSIGNAL_RATE_LIMIT_PAIRING` `0.1,3` | Not reached: 2,500 sessions, one per device, one namespace, no pairing. |

Findings:

- **New devices enroll one at a time per application with PostgreSQL,** about 190 per second on
  this machine, so the first connection of 10,000 new devices took 52 s, with HTTP `429` retries
  meanwhile. The enrollment counts the application's devices in its transaction, which grows with
  them.
- **A device with more than 25 candidates loses some** when it sends them at once, since both
  sides share the session's `rtc.ice_candidate` bucket; how many a browser gathers grows with its
  network interfaces and TURN URLs.
- **The event loop stalls for about a second** under 55,000 relays at once on one instance; on two
  instances, each relaying through Valkey, it stays under 33 ms.
- **On one host, the restart's reconnections cannot all use IPv4:** the old connections keep about
  10,000 loopback ports in `TIME_WAIT`, of about 16,000, so the script reconnects over IPv6, and a
  run waits for the previous one's `TIME_WAIT` sockets to expire.
