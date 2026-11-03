# Maximum connection lifetime

**Status:** accepted

Spec §15 asks the implementation to account for hosting platforms that limit how long a connection
or request lasts. Cloud Run, for one, treats a WebSocket as a long request and cuts it at the
service's request timeout, at most 60 minutes. The SDK already reconnects after such a cut, like
after any abnormal closure (`docs/protocol.md` §10), but the server learns of it only when the
socket errors or misses a ping, and the connections opened together, after a deployment, are all
cut together.

## Rules

- **`BLINDSIGNAL_MAX_CONNECTION_SECONDS` bounds a connection's lifetime;** 0, the default, sets
  none. Deployments behind a platform with a request timeout set it below that timeout, with room
  for a heartbeat interval: 3300 behind a 3600-second timeout.
- **The server closes the connection with `1001` (Going Away)** between 90% and 100% of that
  lifetime, at a random point, so connections opened together reconnect apart. The close releases
  the connection's sessions, presence, slots, and device claim at once, as on shutdown.
- **The SDK needs no change:** it reconnects with backoff after `1001`, joins its namespaces again,
  and treats its server-side sessions as ended; an open DataChannel stays open (`docs/protocol.md`
  §10).
- **The limit applies to every connection, authenticated or not,** from the moment the upgrade
  completes.

## Considered options

- **Only documenting the platform's cut.** Rejected: an abrupt cut leaves presence and slots held
  until their lease expires, and every connection opened together reconnects together.
- **Waiting for a quiet moment,** with no session pending, before closing. Rejected: the platform's
  limit does not wait, and a session still negotiating would end anyway.
- **A new close code** telling the SDK to reconnect at once, without backoff. Rejected: `1001`
  already means the server is going away, and the backoff's first delay, under one second, adds
  little.

## Consequences

- A session still negotiating when its connection reaches the limit ends with
  `peer_disconnected` for the peer, as with any reconnect; an established DataChannel is not
  touched.
- With the limit set, each connection reconnects about once per lifetime: one more authentication,
  and one more `jti` claim, per device per lifetime.
