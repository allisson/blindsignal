# Connection timeout in the SDK

**Status:** accepted

The SDK restarts ICE, and then closes the session, when a peer connection reaches `failed`
(docs/protocol.md §10). Some connections never get there. With the relay forced and the TURN
server unreachable, gathering ends without a candidate, and Chromium and Firefox both leave
`connectionState` at `new` for good. The server's negotiation timeout covers only `pending`
sessions, so an accepted session that never connects lasts as long as both connections. The SDK
bounds the time a peer connection may take to connect.

## Rules

- **`connectTimeoutMs`, a client option, defaults to 30 s:** the default of the server's
  negotiation timeout (`BLINDSIGNAL_NEGOTIATION_TIMEOUT_SECONDS`).
- **Counted from each description exchange, on both sides.** The clock starts when the remote
  description is set: the answer on the requester, the offer on the target. An ICE restart brings
  a new exchange and starts it again. The time the target takes to accept is the server's
  negotiation timeout, not this one.
- **Stopped by `connected`, `failed`, or close.** A connection that drops after connecting is left
  to the browser's own `failed`.
- **Expiry counts as `failed`** and takes the existing path: the requester restarts ICE with the
  latest `rtc.ice_config`, up to `maxIceRestarts` in a row, then closes; the target waits for the
  requester's restart; without signaling for the session, either side closes.

## Considered options

- **Counted from the creation of the peer connection.** Rejected: on the requester it would
  include the time the target takes to accept, already bounded by the server.
- **On the requester only, from the offer.** Rejected: the target would keep a connection that
  never connects once the requester's signaling is gone.
- **A shorter default, 10 or 15 s.** Rejected: a relay over TCP or TLS may still be checking
  candidates; the application can lower it.

## Consequences

- A session that never connects closes after at most `connectTimeoutMs × (maxIceRestarts + 1)`,
  2 minutes by default, and the peer gets `closed_by_peer`.
- A connection that is slow but would have connected may be restarted, and lose its progress.
- In Firefox, an ICE restart cannot save a connection that fails before its DataChannel opens:
  Firefox closes the pending channel as the connection fails, which closes the session, and a
  channel created after the restart never opens, although ICE reconnects. The application creates
  a new session. The occasional Firefox failure of
  `examples/browser-demo/tests/datachannel.spec.ts:49` in CI ends this way, after ICE fails on the
  runner for a reason not found; the retry covers it.
