# Metadata retention

**Status:** accepted

Spec §4.4 and §17 require BlindSignal to minimize metadata and to define its retention, without
fixing either. The server keeps each piece of metadata only while the protocol needs it, keeps no
history of who connected to or signaled whom, and writes logs it does not store itself. Session
history and an audit trail were rejected: they would make the server a record of who talks to
whom, which the MVP does not need and the privacy principle argues against.

## What the server holds

| Metadata | Held | Gone |
|---|---|---|
| Device record: identity, first and last authentication | Coordination of the device quota (ADR 0011) | Expires once not authenticated for the device TTL (`BLINDSIGNAL_DEVICE_TTL_DAYS`, 30 days); stops counting at once and is deleted |
| Device connection claim | While the connection is open (ADR 0008) | On close |
| Presence lease: namespace, device, connection | While joined (spec §7.3) | On leave, close, or lease expiry (`BLINDSIGNAL_PRESENCE_LEASE_SECONDS`) |
| Session: namespace, participants, state | While the session lives (ADR 0004) | On its end; nothing is kept after it |
| `(iss, jti)` of each accepted token | Replay protection (ADR 0006) | At `exp` plus the clock skew |
| Rate-limit buckets, keyed by client IP, connection, or session | ADR 0011 | Once full again |
| Quota slots and unauthenticated-connection counts | ADR 0011 | When the holder ends |
| Revoked devices in the registry file | While the revocation must hold (ADR 0005) | When the operator removes the entry, which admits the device again |

Tokens, SDP, and ICE candidates (which carry network addresses) are processed in flight and never
stored, logged, or counted. Application payloads never reach the server (spec §4.1).

## Rules

- **Expired state is deleted, not only ignored.** An adapter may delete lazily, on its next
  operation, but never keeps expired metadata past its next sweep. The in-memory device repository
  deletes expired records when the application's next new device authenticates; its state also
  ends with the process. Durable adapters (roadmap Phase 9) delete expired device records on a
  schedule.
- **Logs are written, never kept, by the server:** one JSON line per event on standard output, with
  a fixed set of fields: connection IDs, application IDs, close and error codes, and the client IP
  on `connection.opened` only, so an operator can tie abuse to a connection. No user, device,
  namespace, session participant, token, or payload is logged (tested).
- **Operators keep logs with a client IP for at most 14 days.** The server README states it;
  BlindSignal cannot enforce a log pipeline it does not run.
- **Metrics are aggregates** labeled only by message type, error code, authentication result,
  termination reason, and the backpressure limit reached (ADR 0013); they identify no application
  user, device, or address and need no limit.

## Considered options

- **No client IP in logs.** Rejected: rate limits answer floods without closing them (ADR 0011),
  and the IP is the operator's only way to act on an abusive client, at the firewall or the proxy.
- **A hashed or truncated IP.** Rejected: an IPv4 hash is reversed by enumerating the address
  space, and a truncated address no longer identifies the abusive client.

## Consequences

- An operator can see, while it lasts, which devices are connected, present, and in sessions with
  whom, and for 14 days which addresses opened connections; spec §17 asks this visibility to be
  documented, and the threat model lists it as an accepted risk.
- Investigating a past session is impossible by design: once ended, nothing records it.
- A device record past its TTL may stay in memory until the next new device of its application or
  a restart; it no longer counts toward any quota.
