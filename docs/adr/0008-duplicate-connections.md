# One connection per device; the newer one replaces the older

**Status:** accepted

A device, identified by `(app_id, sub, device_id)` (ADR 0006), may connect again while it
already has a connection: a reconnect racing a half-open socket, or a second browser tab sharing
the same device identity (spec §13). A device has at most one connection, and a newer one
replaces the older. The alternatives were worse:

- **Rejecting the newer connection** would block a reconnect behind a half-open connection until
  the heartbeat detects it.
- **Allowing several connections per device** leaves ambiguous which one receives a
  `session.request` addressed to the device.
- **Electing a leader tab in the SDK** (Web Locks, `BroadcastChannel`) adds cross-tab
  coordination and message proxying to the SDK for no server-side gain.

## Rules

- **Replacement happens only after the newer connection authenticates.** An unauthenticated
  socket, or one whose token names another identity, never affects an existing connection.
  Authentications of the same device are serialized: the last one to succeed wins.
- **The older connection is closed with `superseded`** (close code `4003`). Its sessions end as on
  any disconnect (ADR 0004): the other participants receive `session.terminated` with reason
  `peer_disconnected`. Its namespaces are left; the newer connection joins them again itself.
- **The SDK never reconnects automatically after `superseded`.** It exposes the state, so the
  application can show "active in another tab" and reconnect only on a user action. Two tabs
  therefore cannot replace each other in a loop (spec §8.3).
- **The per-device connection limit is 1 by design,** not a configurable quota.

## Consequences

- Only one tab of a device is connected at a time. An application that wants several tabs active
  must give each its own `device_id`.
- After a network interruption, two tabs of one device may both reconnect with backoff; the last
  to authenticate wins and the other stops at `superseded`.
