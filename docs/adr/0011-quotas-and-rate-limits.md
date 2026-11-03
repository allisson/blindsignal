# Quotas and rate limits

**Status:** accepted

Spec §8 lists rate-limit categories and quotas without fixing their keys, their algorithm, or how
a rejection reaches the client. Rate limits use a token bucket per key; quotas are concurrency or
count limits checked when a resource is acquired. Both are configured, never hardcoded: defaults
come from the environment and an application's registry entry (ADR 0005) may override its own.
Initial values are set through load testing (spec §8.2).

## Quotas

| Scope | Quota | Checked on |
|---|---|---|
| Application | Concurrent connections | `auth.authenticate` |
| Application | Registered devices (live records, ADR 0010) | `auth.authenticate` of a new device |
| Application | Concurrent sessions | `session.create` |
| Device | Concurrent sessions | `session.create`, for both devices |
| Device | Joined namespaces | `namespace.join` |
| Server | Maximum message size | every frame |

- **A session takes a slot from creation,** while still `pending`, for the application and for
  both devices, and releases them when it ends. A target with no free slot gets the requester
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
| Authentication attempts (`auth.authenticate`, `auth.refresh`) | Client IP |
| Discovery requests | Connection |
| Session creation | Connection |
| Signaling messages, every type | Connection |
| `rtc.*` messages | Session |
| `rtc.ice_candidate` | Session, in its own bucket |
| Pairing attempts | Post-MVP, with pairing |

- **Token bucket:** each category has a configurable rate and burst. A message takes one token
  from every bucket that applies to it.
- **Before the upgrade:** connection attempts above the limit, or beyond the unauthenticated
  connection cap, are refused with HTTP `429` and no WebSocket is opened.
- **After the upgrade:** a message above a limit gets `error` `rate_limited` with `retryAfterMs`
  from the bucket and is dropped; the connection stays open. `invalid_message` replies count
  toward the connection's signaling bucket, so malformed traffic is limited too.

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
