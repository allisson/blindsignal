# Quotas and rate limits

**Status:** accepted

Spec §8 lists rate-limit categories and quotas without fixing their keys, their algorithm, or how
a rejection reaches the client. Rate limits use a token bucket per key; quotas are concurrency or
count limits checked when a resource is acquired. Both are configured, never hardcoded: defaults
come from the environment and an application's registry entry (ADR 0005) may override its own.
Initial values are set through load testing (spec §8.2). Amended by the Phase 12 load tests: ADR
0049 defines them, and their first run, in `docs/load-report.md`, kept every default.

## Quotas

| Scope | Quota | Checked on |
|---|---|---|
| Application | Concurrent connections | `auth.authenticate` |
| Application | Registered devices (live records, ADR 0010) | `auth.authenticate` of a new device |
| Application | Concurrent sessions | `session.create` |
| Device | Concurrent sessions | `session.create`, for both devices |
| Device | Joined namespaces | `namespace.join` |
| Device | Pending sessions to one target: 1, not configurable | `session.create` |
| Application | Devices one pairing request reaches (`pairingApprovers`, ADR 0042) | `pairing.create` |
| Server | Maximum message size | every frame |

- **A session takes a slot from creation,** while still `pending`, for the application and for
  both devices, and releases them when it ends; connections and sessions renew their slots on
  every heartbeat, so a lost instance frees them (ADR 0022). A target with no free slot gets the requester
  `peer_unavailable`, like any unreachable target, so the target's load is not revealed and
  `session.accept` never fails on a quota.
- **Exceeding a quota returns `quota_exceeded`** (retryable, no `retryAfterMs`: a slot frees when
  something else ends, not after a known delay). On `auth.authenticate` it closes the connection;
  on `session.create` and `namespace.join` it does not.
- **No per-device connection quota:** it is 1 by design (ADR 0008).
- **No maximum session duration:** a session already ends with its connection (ADR 0004).
  Superseded by ADR 0014, which adds it as an optional quota.
- **Message size** is server-wide, since it is checked before the frame is parsed and the
  application is known; an oversized message is `message_too_large`.

## Rate limits

| Category | Key |
|---|---|
| Connection attempts | Client IP |
| Concurrent unauthenticated connections | Client IP, and global |
| Authentication attempts (`auth.authenticate`) | Client IP |
| Token refreshes (`auth.refresh`) | Device |
| Discovery requests | Device |
| Session creation | Device |
| Signaling messages, every type | Device; connection before authentication |
| `rtc.*` messages | Session and sending device |
| `rtc.ice_candidate` | Session and sending device, in its own bucket |
| Pairing attempts | Device (ADR 0042) |
| Presence changes (`namespace.join`, `namespace.leave`) | Device |

Amended by the Phase 12 abuse review: the keys above were the connection, the session, and the
client IP for `auth.refresh`; see "rate limits" below.

- **Token bucket:** each category has a configurable rate and burst. A message takes one token
  from every bucket that applies to it.
- **Before the upgrade:** connection attempts above the limit, or beyond the unauthenticated
  connection cap, are refused with HTTP `429` and no WebSocket is opened. Amended by the Phase 12
  abuse-resistance review: the refused socket is destroyed once the response is written, so a
  client that never closes its side, or resets it, holds no slot and cannot end the process; and a
  connection the server closes, at the authentication deadline or otherwise, is terminated when
  its client has not answered the close within `BLINDSIGNAL_CLOSE_TIMEOUT_SECONDS` (default 5).
- **After the upgrade:** a message above a limit gets `error` `rate_limited` with `retryAfterMs`
  from the bucket and is dropped; the connection stays open. `invalid_message` replies count
  toward the connection's signaling bucket, so malformed traffic is limited too.

## Amended by the Phase 12 abuse review: size and fan-out

- **Presence changes take a token** from a `presence` bucket per connection
  (`BLINDSIGNAL_RATE_LIMIT_PRESENCE`, default `1,10`), since each one fans out to every device of
  the namespace. Only a join or leave that changes presence takes one: a repeated join renews the
  lease, and a leave of a namespace not joined does nothing.
- **One pending session per requester and target.** A slot keyed by both devices, limit 1, is held
  from `session.create` until the target accepts or the session ends; another `session.create` to
  the same target gets `quota_exceeded`. A single device can then no longer hold every session slot
  of a target with requests it never lets finish. The limit is fixed: it is a rule of the protocol,
  not a capacity.
- **A full target counts toward the abuse alert** (ADR 0016), as a `quota_exceeded` does, while
  the requester still gets `peer_unavailable`: the operator learns of a target held busy, and the
  requester still learns nothing of its load.
- **A `discovery.result` fits in the protocol's maximum message size,** which the SDK enforces:
  the server lists the devices that fit and sets `truncated: true` when it left some out. Paging
  was considered and left out: a namespace that large is outside the per-user namespaces the
  examples use, and presence events still report every change.
- **`pairingApprovers`** (`BLINDSIGNAL_MAX_PAIRING_APPROVERS`, default 10) bounds the devices one
  `pairing.create` reaches (ADR 0042).

## Amended by the Phase 12 abuse review: rate limits

- **Buckets after authentication are per device,** keyed by application, user, and device ID, so a
  reconnection starts no new bucket; the IDs come from a verified token, so no client names
  another device's bucket. The tabs of one device share them, as only one is connected at a time
  (ADR 0008). Before authentication, the signaling bucket stays per connection, bounded by the
  authentication deadline and the per-IP attempts.
- **`auth.refresh` takes a `refresh` bucket per device** (`BLINDSIGNAL_RATE_LIMIT_REFRESH`, default
  `0.1,5`, overridable as `rateLimits.refresh`) instead of the per-IP authentication bucket, which
  a connected client could otherwise spend for every client behind its IP. The default is a
  starting value until load testing sets it (ADR 0049).
- **Each participant of a session has its own `rtc` and `rtc_ice_candidate` buckets,** so one peer
  cannot spend the other's. A session's total rate is twice the policy.
- **Per-IP limits count an IPv6 client by its prefix** (`BLINDSIGNAL_IPV6_PREFIX_LENGTH`, default
  64), since one host is commonly given a whole /64; `128` counts each address. IPv4 addresses are
  counted as they are. Logs keep the whole address.
- **A request's headers have a deadline before the upgrade:**
  `BLINDSIGNAL_HTTP_HEADERS_TIMEOUT_SECONDS`, default 10, from the socket's opening, a socket that
  sends nothing included, checked every second. Node's defaults, 60 seconds checked every 30, let
  a slow client hold a socket that no cap counts yet.

## Client IP

- The configuration lists trusted proxies as CIDR ranges and names one forwarding header:
  `x-forwarded-for` or `cf-connecting-ip`.
- From a trusted peer, the server reads that header. For `X-Forwarded-For` it walks the list from
  right to left, skips trusted addresses, and takes the first untrusted one. A missing or invalid
  header falls back to the TCP peer address.
- From any other peer, forwarding headers are ignored and the TCP peer address is the client IP.

## Consequences

- Behind a misconfigured proxy, every client shares the proxy's address and its pre-authentication
  buckets; the deployment profiles (spec §14.2, §14.3) document the trusted-proxy setting.
- A flooding connection is answered, not closed: each excess message costs one small `error`.
  Closing after repeated violations, and abuse-triggered suspension (spec §8.3), are post-MVP.
