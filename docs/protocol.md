# BlindSignal signaling protocol

**Status:** Draft, protocol version 1  
**Reference:** `docs/spec.md` §11, §13; `docs/adr/0003-one-to-one-sessions.md`;
`docs/adr/0004-sessions-bound-to-connections.md`; `docs/adr/0006-token-profile-and-device-identity.md`; `docs/adr/0007-namespace-authorization.md`; `docs/adr/0008-duplicate-connections.md`; `docs/adr/0009-ice-configuration.md`; `docs/adr/0011-quotas-and-rate-limits.md`; `docs/adr/0013-bounded-queues-and-backpressure.md`; `docs/adr/0014-maximum-session-duration.md`

JSON text messages over one WebSocket per connection. The protocol carries no application
payload: application data travels only through WebRTC DataChannels. Administrative operations
(spec §5.6) are not part of it.

## 1. Envelope

```json
{ "version": 1, "type": "session.create", "requestId": "r-42", "payload": { } }
```

| Field | Type | Rule |
|---|---|---|
| `version` | integer | Protocol major version. Required on every message. |
| `type` | string | Message type: dot-separated lowercase segments in snake_case. |
| `requestId` | string, 1–64 chars | Required on every client-sent message; echoed by the server's reply; absent on server events and relayed messages. Opaque; the server does not enforce uniqueness. |
| `payload` | object | Required; `{}` when the type has no fields. Keys are camelCase. |

The SDK never sends the access token anywhere but the `auth.authenticate` and `auth.refresh`
payloads (spec §16).

Receivers drop unknown keys from the envelope and the payload. A message is at most the
configured maximum size in UTF-8 bytes; that setting cannot exceed 64 KiB, which is also its
default.

Identifier formats:

| Identifier | Format |
|---|---|
| `app_id` | `^[a-z0-9][a-z0-9_-]{0,63}$` |
| Namespace | `<app_id>:<scope>`; the scope is 1–128 visible ASCII characters (`0x21`–`0x7E`), no spaces. |
| `userId`, `deviceId` | Opaque string, 1–256 characters. |
| `sessionId` | UUID. |
| `requestId` | Opaque string, 1–64 characters. |

The `protocol` package (`packages/protocol`) implements these schemas, the message catalog in §4,
and the error catalog in §9; server and SDK parse frames with it.

## 2. Versioning

- `version` is a single integer major version. This document defines version `1`.
- Within a major version, the only allowed change is adding an **optional** payload field.
  Receivers ignore payload fields they do not know.
- A new message type, a new required field, a removed field, or a change in meaning requires the
  next major version.
- The version of a connection is the `version` of its `auth.authenticate`. A server that does not
  support it answers `error` `unsupported_version` and closes the connection (terminal). Any later
  message with a different `version` is rejected the same way.
- There is no WebSocket subprotocol negotiation and no minor version.

## 3. Request correlation and replies

Every client-sent message is a request and gets exactly one reply, echoing its `requestId`, except
relayed messages (§6), which get a reply only on failure.

| Request | Success reply |
|---|---|
| `auth.authenticate`, `auth.refresh` | `auth.result` |
| `discovery.request` | `discovery.result` |
| `session.create` | `session.created` |
| `connection.ping` | `connection.pong` |
| `namespace.join`, `namespace.leave`, `session.accept`, `session.reject`, `session.close` | `ack` |
| `rtc.offer`, `rtc.answer`, `rtc.ice_candidate` | none |

Any request may instead get `error`.

## 4. Message catalog

Direction: **C→S** client to server, **S→C** server to client, **Relay** client to server and
rebuilt by the server for the other session participant.

| Type | Direction | Payload | Permission (server-side) |
|---|---|---|---|
| `auth.authenticate` | C→S | `{ token }` | — |
| `auth.refresh` | C→S | `{ token }` | — |
| `auth.result` | S→C | `{ userId, deviceId, expiresInMs }` | — |
| `namespace.join` | C→S | `{ namespace }` | `namespace.join` |
| `namespace.leave` | C→S | `{ namespace }` | — |
| `presence.changed` | S→C | `{ namespace, userId, deviceId, present }` | — |
| `discovery.request` | C→S | `{ namespace }` | `namespace.discover` |
| `discovery.result` | S→C | `{ namespace, devices: [{ deviceId, userId }] }` | — |
| `session.create` | C→S | `{ namespace, userId, deviceId }` | `session.create` |
| `session.created` | S→C | `{ sessionId }` | — |
| `session.request` | S→C | `{ sessionId, namespace, userId, deviceId }` | — |
| `session.accept` | C→S | `{ sessionId }` | `session.accept` |
| `session.reject` | C→S | `{ sessionId }` | `session.accept` |
| `session.accepted` | S→C | `{ sessionId }` | — |
| `session.rejected` | S→C | `{ sessionId }` | — |
| `session.close` | C→S | `{ sessionId }` | `session.close` |
| `session.terminated` | S→C | `{ sessionId, reason }` | — |
| `rtc.offer` | Relay | `{ sessionId, sdp }` | `session.signal` |
| `rtc.answer` | Relay | `{ sessionId, sdp }` | `session.signal` |
| `rtc.ice_candidate` | Relay | `{ sessionId, candidate }` | `session.signal` |
| `rtc.ice_config` | S→C | `{ iceServers: [{ urls, username?, credential? }] }` | — |
| `connection.ping` | C→S | `{}` | — |
| `connection.pong` | S→C | `{}` | — |
| `ack` | S→C | `{}` | — |
| `error` | S→C | `{ code, retryAfterMs? }` | — |

`userId` is the issuer's `sub`, meaningful only within the application (spec §6.1). A device is
identified by `userId` and `deviceId` together, never by `deviceId` alone (ADR 0006).
`rtc.ice_config` follows every successful `auth.result`, and only then (ADR 0009); `iceServers` is
empty when the server configures no ICE server.
`expiresInMs` is the time left until the token's `exp`, so the SDK can refresh before the server
closes the connection without reading the token. Pairing
messages are defined with the pairing protocol (spec §7.4, post-MVP).

The server rejects a message whose type it does not know or whose direction does not allow the
sender, such as a client-sent `session.request` or `rtc.ice_config`.

## 5. Authorization

- Before `auth.authenticate` succeeds, the only accepted message is `auth.authenticate`. Any other
  message gets `error` `not_authenticated` and the connection closes (terminal). This includes
  `connection.ping`.
- A connection authenticates once. A later `auth.authenticate` gets `error` `invalid_message`
  and the connection stays open; `auth.refresh` renews the credential.
- The server checks the permission in §4 on every protected message, deny by default. Permissions
  are server-side checkpoints and never appear on the wire.
- In the MVP, a device authorized in a namespace holds every namespace and session permission in
  it. A connection is authorized exactly in the namespaces of its current token's `namespaces`
  claim, each of the form `<app_id>:<scope>` (ADR 0007).
- `auth.refresh` replaces that set. For each namespace no longer listed, the server removes the
  device from it and ends the connection's sessions there with `session.terminated` reason
  `namespace_unauthorized`, sent to both participants. New namespaces are not joined
  automatically.

## 6. Presence and discovery

- `namespace.join` registers the device's presence in the namespace and subscribes the connection
  to that namespace's `presence.changed` events. `namespace.leave` undoes both. Closing the
  connection leaves every joined namespace. Joining a namespace already joined and leaving one not
  joined are acknowledged without effect.
- Neither `presence.changed` nor `discovery.result` includes the receiving device itself.
- `discovery.request` is accepted only for a namespace the connection has joined (`not_joined`
  otherwise) and returns the devices present in it.
- An unauthorized namespace and a nonexistent one get the same `not_authorized`, so namespaces
  cannot be enumerated (spec §7.3).

## 7. Sessions

Sessions are one-to-one (ADR 0003) and bound to the two connections that created and accepted
them (ADR 0004).

1. A sends `session.create { namespace, userId, deviceId }` naming B. The server checks authorization, generates
   the `sessionId` (`crypto.randomUUID()`), and replies `session.created { sessionId }`.
2. The server sends B `session.request { sessionId, namespace, userId, deviceId }` naming A.
3. B replies `session.accept` or `session.reject`. The server sends A `session.accepted` or
   `session.rejected`.

States: `pending` → `active` on accept; `pending` → `ended` on reject, timeout, close, or
disconnect; `active` → `ended` on close, disconnect, revocation, or the maximum session duration. `rtc.*` is accepted only in
`active`. Only the target accepts or rejects, and only a `pending` session; any other
`session.accept`, `session.reject`, or `session.close` gets `session_unavailable`.

- A target that does not exist, is not authorized in the namespace, has not joined it, is the
  requester itself, or has no free session slot gets the same `peer_unavailable`, so devices and
  their load cannot be enumerated. A session holds its quota slots from creation (ADR 0011).
- A `pending` session expires after a configurable negotiation timeout; both sides get
  `session.terminated` with reason `timeout`.
- An `active` session ends once it has been active for the application's maximum session
  duration, when one is set; both sides get `session.terminated` with reason `timeout` (ADR 0014).
- `session.close` is only client to server, from either participant, in `pending` or `active`.
  The other participant gets `session.terminated` with reason `closed_by_peer`.
- When a participant's connection closes, the server ends the session and the other participant
  gets `session.terminated` with reason `peer_disconnected`. An established DataChannel is not
  affected (spec §6.4); after reconnecting, the SDK treats every server-side session as ended.
- Several concurrent sessions between the same two devices are allowed, within the per-device
  concurrent session limit (spec §8.2).

`session.terminated` reasons:

| Reason | Cause |
|---|---|
| `closed_by_peer` | The other participant sent `session.close`. |
| `peer_disconnected` | The other participant's connection closed. |
| `peer_revoked` | The other participant's device was revoked (spec §6.4). |
| `timeout` | The session stayed `pending` past the negotiation timeout, or `active` past the maximum session duration (ADR 0014). |
| `namespace_unauthorized` | A participant's `auth.refresh` removed the session's namespace (sent to both). |

Application suspension and revocation send no `session.terminated`: every connection of the
application is closed (spec §5.5).

### Relayed messages

- The client sends `rtc.offer`, `rtc.answer`, or `rtc.ice_candidate` with the `sessionId`. The
  server checks that the session is `active` and the sender is a participant, then **rebuilds**
  the message for the other participant from the validated payload: same `type`, same payload
  fields, no `requestId`, no sender field. Raw bytes are never forwarded.
- Success gets no reply. Failure gets `error` `session_unavailable` with the `requestId`.
- `sdp` and `candidate` are opaque strings, bounded by the message size limit. The server does not
  parse or rewrite them.
- ICE restart is a new `rtc.offer` within the same session; there is no `rtc.ice_restart` type.

## 8. Heartbeat

- The server detects dead connections with WebSocket ping frames, which browsers answer
  automatically. It pings every connection at the configured heartbeat interval and terminates one
  that did not answer the previous ping. Each answer renews the connection's presence leases,
  which outlive a few missed heartbeats; a connection lost without a close leaves presence only
  until its leases expire.
- The SDK detects a dead server by sending `connection.ping`; the server replies
  `connection.pong`. `connection.ping` counts toward the signaling rate limit.

## 9. Errors and connection closure

`error` carries a `code` from the catalog and, for rate limits only, `retryAfterMs`. It carries no
free-text message. Each code has a class in the `protocol` package catalog; the class is not sent
on the wire.

When the server closes a connection, it first sends `error` with the code, then closes the
WebSocket with the close code of the code's class:

| Class | Close code | SDK behavior |
|---|---|---|
| retryable | `4001` | Reconnect with backoff; get a new token first if the token expired. |
| terminal | `4002` | Stop reconnecting and close every session (spec §6.4). |
| superseded | `4003` | Do not reconnect automatically (spec §8.3). |

Four closures carry no `error`:

- **Shutdown.** A server shutting down fails its readiness check, refuses new upgrades with HTTP
  `503`, and closes every connection with `1001` (Going Away). The SDK reconnects with backoff,
  reaching another instance or the restarted one.
- **Oversized frame.** A frame above twice the maximum message size is cut by the WebSocket layer
  with `1009` (Message Too Big) before it is read; a smaller oversized message gets
  `message_too_large`. The SDK treats `1009` like a terminal close.
- **Authentication deadline.** A connection that has not completed `auth.authenticate` within the
  configured time is closed with `1008` (Policy Violation) (spec §8.4). The SDK reconnects with
  backoff, like after an abnormal closure.
- **Backpressure.** A connection whose queue of messages waiting to be handled, or whose send
  buffer, is full is closed with `1013` (Try Again Later) (ADR 0013). The SDK reconnects with
  backoff, like after an abnormal closure.

Initial catalog:

| Code | Class | Closes connection | When |
|---|---|---|---|
| `invalid_message` | retryable | no | Schema failure, unknown type, or wrong direction. Counts toward the rate limit. |
| `malformed_frame` | terminal | yes | Binary frame or invalid JSON. |
| `message_too_large` | terminal | yes | Message above the configured maximum size. |
| `unsupported_version` | terminal | yes | `version` not supported, or different from the connection's. |
| `not_authenticated` | terminal | yes | Any message other than `auth.authenticate` before authentication. |
| `not_authorized` | retryable | no | Namespace not authorized or nonexistent. |
| `not_joined` | retryable | no | `discovery.request` for a namespace not joined. |
| `peer_unavailable` | retryable | no | `session.create` target not reachable (§7). |
| `session_unavailable` | retryable | no | Unknown session, wrong state, or sender not a participant. |
| `rate_limited` | retryable | no | Rate limit exceeded; carries `retryAfterMs`. |
| `quota_exceeded` | retryable | on `auth.authenticate` | Application connection or device-count quota on authentication; application or device session quota on `session.create`; joined-namespace quota on `namespace.join` (ADR 0011). |
| `invalid_token` | retryable | on `auth.authenticate` | Bad signature, header, or claims (including a namespace without the application's prefix); lifetime above the maximum; future `iat`; `iat` before the server started (ADR 0006); replayed `jti`; unknown issuer or application. |
| `token_expired` | retryable | except on `auth.refresh` | Token past `exp` plus the clock-skew tolerance, at authentication or on an open connection. |
| `identity_mismatch` | retryable | no | `auth.refresh` token with a different `app_id`, `sub`, or `device_id`. |
| `application_unavailable` | terminal | yes | Application suspended, revoked, or, on an open connection, removed from the registry. |
| `device_revoked` | terminal | yes | Device revoked. |
| `superseded` | superseded | yes | The same device authenticated a newer connection (ADR 0008). |

Connection attempts above the rate limit or the unauthenticated connection cap are refused with
HTTP `429` before the WebSocket upgrade, so they get no `error` message (ADR 0011).

A failed `auth.refresh` with a retryable code leaves the connection on its current token until
that token expires. An unknown application gets the same `invalid_token` as a bad signature, so
the registry cannot be probed; only a validly signed token learns that its application is
unavailable.

## 10. SDK connection behavior

How the SDK keeps a connection alive and authenticated (spec §15). Every duration below is a
configurable default.

- **New token every time.** The SDK calls `accessTokenProvider` for each `auth.authenticate` and
  each `auth.refresh`, since tokens are single-use (ADR 0006). A provider failure is handled like a
  failed connection attempt.
- **Backoff.** Reconnect attempts wait an exponential delay with full jitter: a random time between
  0 and `min(30 s, 1 s × 2^attempt)`. The attempt count resets once a connection has stayed
  authenticated for 30 s. A failed WebSocket open, an HTTP `429` at the upgrade (which a browser
  reports only as a failed open), an abnormal closure, a missed `connection.pong`, and a
  retryable close (`4001`) all reconnect with backoff.
- **Refresh.** The SDK sends `auth.refresh` when `expiresInMs` minus 60 s has elapsed since
  `auth.result`, or at once when `expiresInMs` is shorter than that. A refresh that fails, through
  the provider or with a retryable `error`, is retried with backoff until the token's expiry; if
  none succeeds, the server closes the connection with `token_expired` and the SDK reconnects with
  a new token.
- **Heartbeat.** The SDK sends `connection.ping` every 25 s and treats the connection as dead when
  no reply arrives within 10 s: it closes the socket and reconnects with backoff. Any reply,
  `error` included, shows the server is alive. Requests pending on a connection that drops are
  rejected.
- **Rate limits.** After `rate_limited`, the SDK waits at least `retryAfterMs` before sending that
  kind of request again.
- **Terminal and superseded.** A terminal close (`4002`) stops reconnecting and closes every
  session, established DataChannels included (spec §6.4). A superseded close (`4003`) stops
  reconnecting until the application asks for a new connection (ADR 0008).
- **After reconnecting.** The SDK joins again every namespace the application had joined and has
  not left, reporting to the application each join that fails (for example, `not_authorized`
  after the backend removed it from the token). Every server-side session is treated as ended
  (ADR 0004); established DataChannels are not touched, and the application creates new sessions
  as it needs them.
- **Session end and DataChannels.** A session ended by `closed_by_peer`, `peer_revoked`,
  `namespace_unauthorized`, `timeout`, rejection, or the application closes its DataChannel. One
  ended only because a signaling path dropped (`peer_disconnected`, or this client's own
  reconnect) keeps a DataChannel that is already open, and closes one still negotiating.
- **ICE restart.** When a session's WebRTC connection fails, the requester applies the latest
  `rtc.ice_config` and sends a new `rtc.offer` with ICE restarted, up to 3 times in a row; the
  target only answers. Without signaling for the session, or past that limit, the connection
  closes and the session ends.
- **Hosting time limits.** A connection the platform or the server closes for exceeding a hosting
  time limit reconnects like any other abnormal or retryable closure.
