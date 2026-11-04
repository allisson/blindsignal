# BlindSignal signaling protocol

**Status:** Draft, protocol version 1  
**Reference:** `docs/spec.md` §11, §13; `docs/adr/0003-one-to-one-sessions.md`;
`docs/adr/0004-sessions-bound-to-connections.md`; `docs/adr/0006-token-profile-and-device-identity.md`; `docs/adr/0007-namespace-authorization.md`; `docs/adr/0008-duplicate-connections.md`; `docs/adr/0009-ice-configuration.md`; `docs/adr/0011-quotas-and-rate-limits.md`; `docs/adr/0013-bounded-queues-and-backpressure.md`; `docs/adr/0014-maximum-session-duration.md`; `docs/adr/0041-proof-of-possession.md`; `docs/adr/0042-pairing.md`

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
- Within a major version, the allowed changes are adding an **optional** payload field and adding a
  server-to-client message type that a client may ignore (ADR 0041). Receivers ignore payload
  fields they do not know, and clients ignore server message types they do not know.
- Any other new message type, a new required field, a removed field, or a change in meaning
  requires the next major version.
- The version of a connection is the `version` of its `auth.authenticate`. A server that does not
  support it answers `error` `unsupported_version` and closes the connection (terminal). Any later
  message with a different `version` is rejected the same way.
- There is no WebSocket subprotocol negotiation and no minor version.
- The SDK and the server have semantic versions of their own; each of their major versions states
  the protocol majors it speaks, and adding one is a minor version, dropping one a major
  (ADR 0043).

## 3. Request correlation and replies

Every client-sent message is a request and gets exactly one reply, echoing its `requestId`, except
relayed messages (§6), which get a reply only on failure.

| Request | Success reply |
|---|---|
| `auth.authenticate`, `auth.refresh` | `auth.result` |
| `discovery.request` | `discovery.result` |
| `session.create` | `session.created` |
| `pairing.create` | `pairing.created` |
| `connection.ping` | `connection.pong` |
| `namespace.join`, `namespace.leave`, `session.accept`, `session.reject`, `session.close`, `pairing.approve`, `pairing.reject` | `ack` |
| `rtc.offer`, `rtc.answer`, `rtc.ice_candidate` | none |

Any request may instead get `error`.

## 4. Message catalog

Direction: **C→S** client to server, **S→C** server to client, **Relay** client to server and
rebuilt by the server for the other session participant.

| Type | Direction | Payload | Permission (server-side) |
|---|---|---|---|
| `auth.challenge` | S→C | `{ nonce }` | — |
| `auth.authenticate` | C→S | `{ token, proof? }` | — |
| `auth.refresh` | C→S | `{ token, proof? }` | — |
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
| `pairing.create` | C→S | `{ namespace }` | the `pairing` claim |
| `pairing.created` | S→C | `{ pairingId }` | — |
| `pairing.request` | S→C | `{ pairingId, namespace, userId, deviceId, jkt }` | — |
| `pairing.approve` | C→S | `{ pairingId, approval }` | `pairing.approve` |
| `pairing.reject` | C→S | `{ pairingId }` | — |
| `pairing.approved` | S→C | `{ pairingId, approval }` | — |
| `pairing.rejected` | S→C | `{ pairingId }` | — |
| `pairing.ended` | S→C | `{ pairingId, reason }` | — |
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
empty when the server configures no ICE server. A TURN entry carries a credential minted for that
message, valid until the expiry in its `username` (ADR 0017).
`expiresInMs` is the time left until the token's `exp`, so the SDK can refresh before the server
closes the connection without reading the token. `pairingId` is a UUID; pairing is §7a.

The server rejects a message whose type it does not know or whose direction does not allow the
sender, such as a client-sent `session.request` or `rtc.ice_config`.

## 5. Authorization

- Before `auth.authenticate` succeeds, the only accepted message is `auth.authenticate`. Any other
  message gets `error` `not_authenticated` and the connection closes (terminal). This includes
  `connection.ping`.
- The server sends `auth.challenge` first on every connection, before reading any message. Its
  `nonce`, 32 random bytes in base64url, is the connection's for its whole life (ADR 0041).
- A token whose `cnf.jkt` binds it to a device key needs a `proof` in the same `auth.authenticate`
  or `auth.refresh`: a JWT with header `typ` `blindsignal-pop+jwt`, `alg` `ES256` or `EdDSA`, and
  `jwk`, the device's public key; and claims `nonce`, the connection's, and `ath`, the base64url
  SHA-256 of the token. The server checks the signature with `jwk`, that the thumbprint of `jwk`
  (RFC 7638, SHA-256) is `cnf.jkt`, `nonce`, and `ath`; any failure is `invalid_token`. An
  application may require bound tokens; otherwise a `proof` with an unbound token is ignored.
  A client that holds no device key ignores `auth.challenge`. The SDK's client, given one, waits
  for the challenge up to its heartbeat timeout, then reconnects.
- A connection authenticates once. A later `auth.authenticate` gets `error` `invalid_message`
  and the connection stays open; `auth.refresh` renews the credential.
- The server checks the permission in §4 on every protected message, deny by default. Permissions
  are server-side checkpoints and never appear on the wire.
- A connection is authorized exactly in the namespaces of its current token's `namespaces` claim,
  each of the form `<app_id>:<scope>` (ADR 0007), and holds every namespace permission there. It
  holds `session.create` and `session.accept` there too, unless the token's `permissions` claim
  lists the namespace with fewer (ADR 0040; §7).
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

- A requester without `session.create` in the namespace gets `not_authorized`, and no request
  reaches the target. A target without `session.accept` there never receives `session.request`:
  its connection answers the requester with `session.rejected`, as a rejection by the user would.
  A target whose `session.accept` an `auth.refresh` withdrew after the request gets
  `not_authorized` on `session.accept`, and the session stays `pending` (ADR 0040).
- A target that does not exist, is not authorized in the namespace, has not joined it, is the
  requester itself, or has no free session slot gets the same `peer_unavailable`, so devices and
  their load cannot be enumerated. A session holds its quota slots from creation (ADR 0011).
- A `pending` session expires after a configurable negotiation timeout; both sides get
  `session.terminated` with reason `timeout`. An answer that races the timeout may end the
  target's side first: the target's `session.reject` is acknowledged, or its `session.accept`
  is followed by `session.terminated`, while the requester gets `timeout` (ADR 0023).
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

## 7a. Pairing

A new device asks the user's other devices to approve it, and takes the approval to its backend,
which issues tokens with the namespace (ADR 0042). The server grants nothing and stores nothing.

1. The new device N, whose token lists the namespace in its `pairing` claim and is bound to a key
   with `cnf.jkt`, sends `pairing.create { namespace }`. The server replies
   `pairing.created { pairingId }`.
2. Every other device of the same `userId` present in the namespace whose token is bound to a key
   and grants `pairing.approve` there gets `pairing.request { pairingId, namespace, userId,
   deviceId, jkt }` naming N, with `jkt` its `cnf.jkt`.
3. One of them, A, sends `pairing.approve { pairingId, approval }` or `pairing.reject
   { pairingId }`, and gets `ack`. N gets `pairing.approved { pairingId, approval }` or
   `pairing.rejected { pairingId }`; the other asked devices get `pairing.ended` reason
   `answered`.

- `approval` is a JWT signed by A's device key: header `typ` `blindsignal-pairing+jwt`, `alg`
  `ES256` or `EdDSA`, and `jwk`; claims `pairing_id`, `namespace`, `sub` and `device_id` of N,
  `jkt`, N's `cnf.jkt`, and `exp`. The server checks the signature with `jwk`, that its thumbprint
  is A's `cnf.jkt`, and every claim; a failure gets `invalid_message` and leaves the request open.
- `pairing.create` without the namespace in the `pairing` claim, or from an unbound token, gets
  `not_authorized`; with no other device of the user present, `peer_unavailable`. It counts
  toward the application's `pairing` rate limit.
- `pairing.approve` from a device whose refresh withdrew `pairing.approve` gets `not_authorized`.
  An answer to a pairing already answered, ended, or unknown gets `pairing_unavailable`.
- A request lasts the negotiation timeout of §7: N and each asked device get `pairing.ended`
  reason `timeout`. When N's connection closes, the asked devices get `pairing.ended` reason
  `requester_gone`.

`pairing.ended` reasons:

| Reason | Cause |
|---|---|
| `answered` | Another asked device answered first. |
| `timeout` | No answer within the negotiation timeout. |
| `requester_gone` | The new device's connection closed. |

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

Five closures carry no `error`:

- **Shutdown.** A server shutting down fails its readiness check, refuses new upgrades with HTTP
  `503`, and, after a configured delay, closes every connection with `1001` (Going Away)
  (ADR 0031). The SDK reconnects with backoff, reaching another instance or the restarted one.
- **Maximum lifetime.** A server configured with a maximum connection lifetime closes each
  connection with `1001` before it ends, at a random point in its last tenth (ADR 0029). The SDK
  reconnects with backoff, as on shutdown.
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
| `invalid_message` | retryable | no | Schema failure, unknown type, or wrong direction, or a pairing approval that fails its checks (§7a). Counts toward the rate limit. |
| `malformed_frame` | terminal | yes | Binary frame or invalid JSON. |
| `message_too_large` | terminal | yes | Message above the configured maximum size. |
| `unsupported_version` | terminal | yes | `version` not supported, or different from the connection's. |
| `not_authenticated` | terminal | yes | Any message other than `auth.authenticate` before authentication. |
| `not_authorized` | retryable | no | Namespace not authorized or nonexistent, or a permission the token withholds (ADR 0040), including `pairing.create` outside the `pairing` claim or from an unbound token (ADR 0042). |
| `not_joined` | retryable | no | `discovery.request` for a namespace not joined. |
| `peer_unavailable` | retryable | no | `session.create` target not reachable (§7), or no device to ask for `pairing.create` (§7a). |
| `session_unavailable` | retryable | no | Unknown session, wrong state, or sender not a participant. |
| `pairing_unavailable` | retryable | no | Answer to a pairing request already answered, ended, or unknown (§7a). |
| `rate_limited` | retryable | no | Rate limit exceeded; carries `retryAfterMs`. |
| `quota_exceeded` | retryable | on `auth.authenticate` | Application connection or device-count quota on authentication; application or device session quota on `session.create`; joined-namespace quota on `namespace.join` (ADR 0011). |
| `invalid_token` | retryable | on `auth.authenticate` | Bad signature, header, or claims (including a namespace without the application's prefix); lifetime above the maximum; future `iat`; `iat` before the server started (ADR 0006); replayed `jti`; unknown issuer or application; a `cnf` without a valid `proof`, or no `cnf` where the application requires one (ADR 0041). |
| `token_expired` | retryable | except on `auth.refresh` | Token past `exp` plus the clock-skew tolerance, at authentication or on an open connection. |
| `identity_mismatch` | retryable | no | `auth.refresh` token with a different `app_id`, `sub`, `device_id`, or `cnf.jkt`, or one that adds or drops `cnf`. |
| `application_unavailable` | terminal | yes | Application suspended, revoked, or, on an open connection, removed from the registry. |
| `device_revoked` | terminal | yes | Device revoked. |
| `superseded` | superseded | yes | The same device authenticated a newer connection (ADR 0008). |
| `server_error` | retryable | yes | The server could not handle the message, such as when its storage is unreachable (ADR 0021). The SDK reconnects with backoff. |

Connection attempts above the rate limit or the unauthenticated connection cap are refused with
HTTP `429` before the WebSocket upgrade, so they get no `error` message (ADR 0011). An instance at
its connection cap refuses the upgrade with HTTP `503` (ADR 0030); the SDK sees a failed open
either way and reconnects with backoff.

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
  target only answers. A connection not connected 30 s after an offer/answer exchange counts as
  failed (ADR 0018). Without signaling for the session, or past that limit, the connection
  closes and the session ends.
- **Hosting time limits.** A connection the platform or the server closes for exceeding a hosting
  time limit reconnects like any other abnormal or retryable closure.
