# BlindSignal signaling protocol

**Status:** Draft, protocol version 1  
**Reference:** `docs/spec.md` §11, §13; `docs/adr/0003-one-to-one-sessions.md`;
`docs/adr/0004-sessions-bound-to-connections.md`; `docs/adr/0006-token-profile-and-device-identity.md`

JSON text messages over one WebSocket per connection. The protocol carries no application
payload: application data travels only through WebRTC DataChannels. Administrative operations
(spec §5.6) are not part of it. Items marked **TBD** depend on a Phase 0 decision not taken yet;
each names the roadmap task that settles it.

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
| `rtc.ice_config` | S→C | **TBD** (roadmap: ICE configuration) | — |
| `connection.ping` | C→S | `{}` | — |
| `connection.pong` | S→C | `{}` | — |
| `ack` | S→C | `{}` | — |
| `error` | S→C | `{ code, retryAfterMs? }` | — |

`userId` is the issuer's `sub`, meaningful only within the application (spec §6.1). A device is
identified by `userId` and `deviceId` together, never by `deviceId` alone (ADR 0006).
`expiresInMs` is the time left until the token's `exp`, so the SDK can refresh before the server
closes the connection without reading the token. Pairing
messages are defined with the pairing protocol (spec §7.4, post-MVP).

The server rejects a message whose type it does not know or whose direction does not allow the
sender, such as a client-sent `session.request` or `rtc.ice_config`.

## 5. Authorization

- Before `auth.authenticate` succeeds, the only accepted message is `auth.authenticate`. Any other
  message gets `error` `not_authenticated` and the connection closes (terminal). This includes
  `connection.ping`.
- The server checks the permission in §4 on every protected message, deny by default. Permissions
  are server-side checkpoints and never appear on the wire.
- In the MVP, a device authorized in a namespace holds every namespace and session permission in
  it. The source of namespace authorization is **TBD** (roadmap: namespace authorization source).

## 6. Presence and discovery

- `namespace.join` registers the device's presence in the namespace and subscribes the connection
  to that namespace's `presence.changed` events. `namespace.leave` undoes both. Closing the
  connection leaves every joined namespace.
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

States: `pending` → `active` on accept; `pending` → `ended` on reject or timeout; `active` →
`ended` on close, disconnect, or revocation. `rtc.*` is accepted only in `active`.

- A target that does not exist, is not authorized in the namespace, has not joined it, or is the
  requester itself gets the same `peer_unavailable`, so devices cannot be enumerated.
- A `pending` session expires after a configurable negotiation timeout; both sides get
  `session.terminated` with reason `timeout`.
- `session.close` is only client to server. The other participant gets `session.terminated`.
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
| `timeout` | The session stayed `pending` past the negotiation timeout. |

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
  automatically.
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
| `invalid_token` | retryable | on `auth.authenticate` | Bad signature, header, or claims; lifetime above the maximum; future `iat`; replayed `jti`; unknown issuer or application. |
| `token_expired` | retryable | except on `auth.refresh` | Token past `exp` plus the clock-skew tolerance, at authentication or on an open connection. |
| `identity_mismatch` | retryable | no | `auth.refresh` token with a different `app_id`, `sub`, or `device_id`. |
| `application_unavailable` | terminal | yes | Application suspended or revoked. |
| `device_revoked` | terminal | yes | Device revoked. |

A failed `auth.refresh` with a retryable code leaves the connection on its current token until
that token expires. An unknown application gets the same `invalid_token` as a bad signature, so
the registry cannot be probed; only a validly signed token learns that its application is
unavailable.

The superseded-connection code is **TBD**, defined with the duplicate-connection policy.
