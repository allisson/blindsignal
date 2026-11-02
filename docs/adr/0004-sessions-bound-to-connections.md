# Sessions are bound to connections

**Status:** accepted

A session belongs to the two connections that created and accepted it, not to the devices. When
either connection closes, the server ends the session and sends the other participant
`session.terminated` with reason `peer_disconnected`. Keeping orphaned sessions alive for a grace
period was rejected: it needs a reconciliation message, TTL state, and rules for reattaching a
session to a new connection of the same device, which also entangles the open duplicate-connection
policy (spec §13).

## Consequences

- An established DataChannel keeps working after a signaling disconnect, since the server cannot
  sever it (spec §6.4). An ICE restart after the SDK reconnects needs a new session and a new
  `RTCPeerConnection`.
- Session state reconciliation after reconnecting (spec §15) reduces to: no server-side session
  survived.
