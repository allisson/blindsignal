# Recovery from a failed instance

**Status:** accepted

ADR 0023 keeps a copy of each session on each participant's connection, and ADR 0022 lets
presence and slots expire when an instance stops. Testing a client that reconnects on another
instance after its instance fails, without draining, showed two gaps:

- A connection that closed while Redis was unreachable failed to release what it held, and the
  rejection went unhandled, which stops a Node.js process.
- The peer's copy of a session with a device on the failed instance never ended. The device
  reconnected elsewhere and opened new sessions, but its peer kept the old one, renewing its quota
  slots on every heartbeat and relaying its `rtc.*` to a connection that no longer existed, until
  the maximum session duration (ADR 0014), which is off by default, or until its own connection
  closed.

## Rules

- **A failed release is logged as `connection.failed`,** with the error's code or name only, as
  any other connection failure. What it left expires with its lease (presence, slots), or the
  device's next authentication replaces it (the device claim, ADR 0008).
- **On every heartbeat, each connection checks the peer of each of its sessions.** It reads the
  peer's device claim (`CoordinationAdapter.connectionOf`); when the claim no longer names the
  peer's connection, because it was released or another connection took it, the connection ends
  its copy with `peer_disconnected`, tells its client, and frees the session's slots. The check
  costs one read per session per heartbeat.
- **The SDK needs no change.** `peer_disconnected` keeps an open DataChannel and closes one still
  negotiating (`docs/protocol.md` §10).

## Considered options

- **A lease per connection,** renewed on every heartbeat and checked by the peer. Rejected for now:
  it also ends the session of a peer whose device never reconnects, but needs a new
  `CoordinationAdapter` operation and contract for a case the maximum session duration bounds.
- **Only documenting `BLINDSIGNAL_MAX_SESSION_DURATION_SECONDS`.** Rejected: with its default of no
  limit, every failed instance leaks a session slot on each peer.
- **Releasing each part on its own,** so one failure does not stop the rest. Rejected: with Redis
  unreachable every part fails alike.

## Consequences

- A session whose peer reconnects on another instance ends within one heartbeat interval
  (`BLINDSIGNAL_HEARTBEAT_INTERVAL_SECONDS`) of the reconnect.
- A session whose peer's instance fails and whose device never reconnects keeps the failed
  connection's claim, so it still lasts until the maximum session duration or until this side's
  connection closes. Multi-instance deployments should set
  `BLINDSIGNAL_MAX_SESSION_DURATION_SECONDS` or `quotas.sessionDurationSeconds` (ADR 0014).
- A peer that closes normally still ends the session at once, through `session.terminated`; the
  check only catches what that event cannot reach.
