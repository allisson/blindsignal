# Security reviews

Each review of BlindSignal, its findings, and what became of each (`docs/adr/0048-security-review.md`).
A finding is **blocking** when it violates an invariant of `AGENTS.md`, or a mitigation that the
threat model or an ADR declares is not applied or has no negative test. A non-blocking finding is
**fixed**, **accepted** (with the threat model's accepted risk that records it), or **open**
(tracked in the roadmap's Phase 12).

## 2026-11: before the first release

**Scope:** the whole repository at `3dcbb5b`, one reviewer per trust boundary of
`docs/threat-model.md` §3, against `AGENTS.md`, the spec, and the ADRs. `pnpm audit --prod`
reported no advisory.

### Blocking, fixed in #113

| Boundary | Finding | Fix |
|---|---|---|
| SDK ↔ server | A pong the server never asked for renewed the connection's leases, outside every rate limit | Only the pong answering the server's own ping renews them |
| SDK ↔ server | `ws` answered every ping on its own, so a client that never read could grow the send buffer past `maxBufferedBytes` (ADR 0013) | The server answers pings, and terminates a connection whose buffer is past the limit |
| Issuer ↔ server | The JWKS refetch cooldown did not apply when the fetch itself failed, so each unknown `kid` refetched an unreachable JWKS | A failed fetch starts the cooldown too |
| Operator ↔ server | A stored registry that trusts the development issuer was accepted outside development mode, through a sync from storage | The sync refuses it, as loading the file does |
| Operator ↔ server | IP logs were kept beyond the 14 days of ADR 0012 by the deployments' default log retention | `docs/self-hosted.md` and `docs/cloud-run.md` set the retention, or the `warn` level that logs no IP |
| Server ↔ adapters | Redis could evict or lose the `jti` history while the instances ran, which allows a replay | `maxmemory-policy noeviction`, and a restart of the instances after Redis loses data (ADR 0035) |
| Server ↔ adapters | ADR 0022's key prefix could not be set, so two deployments sharing one Redis shared their keys | `BLINDSIGNAL_REDIS_PREFIX` |

### Non-blocking, fixed

| Boundary | Finding | Fix |
|---|---|---|
| Device ↔ device | `denied-peer-ip` left out the IPv4-mapped and NAT64 IPv6 ranges, which reach IPv4 peers the other lines deny | Both ranges denied in `docs/turn-operations.md` and `examples/self-hosted/turnserver.conf` |
| Supply chain | Dependabot proposed updates to the image's base only, and the actions were referenced by tag | Dependabot for npm and the actions too, the actions pinned by commit, and `pnpm audit --prod` in CI (ADR 0048) |
| Supply chain | `.dockerignore` did not leave out `.env` files | `**/.env*` |

### Non-blocking, accepted

| Boundary | Finding | Accepted risk |
|---|---|---|
| Operator ↔ server | With several instances, a suspension or revocation whose event is lost reaches an instance only at its next sync, up to `BLINDSIGNAL_REGISTRY_SYNC_INTERVAL_SECONDS` later (ADR 0024) | Threat model §5, risk 13; spec §5.5 |

### Non-blocking, open

| Boundary | Finding |
|---|---|
| SDK ↔ server | The SDK buffers ICE candidates that arrive before the remote description with no cap and no timeout |
| SDK ↔ server | `DeviceKey.from` accepts an extractable key, or one that is not an ECDSA key |
| SDK ↔ server | `iceServers` is checked only when the client is built, and accepts a `credential` on a `stun:` URL |
| SDK ↔ server | The server URL may carry userinfo or a query string |
| SDK ↔ server | `auth.refresh` leaves the connection's pairing requests open when the new token drops `pairing` |
| Issuer ↔ server | The JWKS response has no size limit, and its fetch timeout and cooldown are not configurable as spec §5.3 asks |
| Issuer ↔ server | A token's `aud` may be an array that holds the server's audience among others |
| Issuer ↔ server | A production registry whose `jwksUri` serves the development key is not refused |
| Operator ↔ server | A `SIGHUP` that arrives before the signal handlers are installed ends the process |
| Operator ↔ server | An unreachable Redis at startup leaves the server waiting, with no deadline |
| Operator ↔ server | `server.start_failed` and the crash log can carry text from an error message |
| Operator ↔ server | The TURN credential lifetime has no upper bound |
| Operator ↔ server | `docs/cloud-run.md` does not require TLS and authentication for Redis, and OTLP headers may go over plain HTTP |
| Server ↔ adapters | An event delivered from another instance is not checked against the session again |
| Server ↔ adapters | Coordination events are parsed without a schema |
| Server ↔ adapters | A device's claim in Redis has no TTL |
| Examples | `examples/backend-issuer` has no rate limit on its token endpoint, keeps unbounded state in memory, and its session cookie has no `__Host-` prefix, expiry, or sign-out |
| Examples | `examples/browser-demo` sends a token to any `wss://` server its `?server=` names, and `examples/minimal-app`'s device IDs can collide with the page's element IDs |
| Tests | The scan for secrets in served files skips the `*.test.ts` files the examples serve |
| Tests | No test covers a JWKS fetch that times out or redirects, a token without `iat` or `exp`, or concurrent use of one `jti` or rate limit |

## 2026-11: abuse resistance

**Scope:** the repository at `a02bdfc`, one reviewer per surface: before authentication, after
it, quotas and rate limits, TURN, and several instances; against spec §8, §13, and §21, ADR 0011,
ADR 0013, ADR 0016, and ADR 0017.

### Blocking, fixed in #115

| Boundary | Finding | Fix |
|---|---|---|
| SDK ↔ server | A client that reset its socket during the upgrade ended the process, since Node drops the socket's error handler there | The upgrade handles the socket's errors |
| SDK ↔ server | A refused upgrade only ended its side, so a client that never closed its own held a slot of the unauthenticated caps | The server destroys the socket once its answer is sent |
| SDK ↔ server | A connection the server closed waited 30 s for the client's close frame, holding its slot | `BLINDSIGNAL_CLOSE_TIMEOUT_SECONDS`, default 5 (ADR 0011) |
| Device ↔ device | `examples/self-hosted/turnserver.conf` set no quota, and relayed TCP to any address (threat model §4.4) | `user-quota`, `total-quota`, `max-bps`, and `no-tcp-relay` (ADR 0017, `docs/turn-operations.md`) |
| SDK ↔ server | No test showed that a refused authentication or refresh issues no TURN credential (ADR 0009) | A negative test |

### Non-blocking, accepted

| Boundary | Finding | Accepted risk |
|---|---|---|
| Operator ↔ server | The abuse alert counts per instance, and is off by default (`BLINDSIGNAL_ABUSE_ALERT_THRESHOLD=0`) | Threat model §5, risk 8 |

### Non-blocking, open

| Boundary | Finding |
|---|---|
| SDK ↔ server | `sdp` and `candidate` have no size limit of their own, so one peer can fill the other's send buffer and have it closed with `1013` |
| SDK ↔ server | Joining and leaving a namespace in a loop fans presence out to its devices, with no rate limit of its own |
| SDK ↔ server | A `discovery.result` can exceed 64 KiB, which the SDK drops |
| SDK ↔ server | `session.create` and `pairing.create` read the namespace's whole presence to check one device |
| SDK ↔ server | Pending sessions can hold the 16 session slots of a target, and raise no alert |
| SDK ↔ server | One user can fill its application's device quota for the 30 days of the device TTL |
| SDK ↔ server | One application can fill an instance's connection cap |
| SDK ↔ server | A pairing request fans out to every present device of its user, with no cap |
| SDK ↔ server | A session's duration timer uses the requester's limits only |
| SDK ↔ server | A heartbeat whose renewal fails, or a lower `namespacesPerDevice`, does not trim what the connection holds |
| SDK ↔ server | Per-connection rate limits start again at each reconnection |
| SDK ↔ server | Per-IP limits do not aggregate IPv6 addresses by prefix |
| SDK ↔ server | `auth.refresh` shares the per-IP authentication bucket |
| SDK ↔ server | Both sides of a session share one `rtc` bucket |
| SDK ↔ server | No HTTP header or request timeout bounds a client before the upgrade |
| Operator ↔ server | The abuse alert does not name the connection |
| Server ↔ adapters | Redis commands have no timeout, so an upgrade waits on `consumeRateLimit` while Redis does not answer |
| Device ↔ device | A TURN username is its expiry and application ID only, so the credentials of one application minted in the same second are the same, and share its `user-quota` |
| Device ↔ device | `denied-peer-ip` does not deny the TURN host's own public address |
| Tests | No test sends `rtc.ice_config` from a client (spec §21), or runs the abuse rules against Redis and two instances |
