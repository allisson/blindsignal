# Application onboarding

How an application team goes from nothing to two of its users' devices exchanging data over a
DataChannel, and what to check before production. Each step names the document with the details
and the file of `examples/backend-issuer` or `examples/minimal-app` that does it in code; those
examples run in CI, so they stay correct when this guide is read in isolation. The operator's side
of registration is in `docs/application-lifecycle.md#onboarding`.

## What BlindSignal does and does not do

BlindSignal authenticates your devices with tokens your backend issues, tells each device which of
its peers are present in a namespace, and relays the WebRTC offer, answer, and candidates between
two of them. Payloads travel only over the DataChannel the two browsers open: the server never
sees them (spec §4.1). It keeps no users, no passwords, and no application state: who a user is,
which devices they have, and which namespaces they may use are your backend's decisions, carried
in each token.

## 1. Register with the operator

Agree on the registry entry with the operator of the BlindSignal server
(`docs/token-issuance.md#registration`):

- **Give them:** the `appId`; the `issuer`, the exact `iss` of your tokens; the `audience`; a
  `jwksUri` over HTTPS, or the public keys; the algorithms; the web origins your pages are served
  from; and the expected number of devices and concurrent connections, against the defaults of
  10,000 each per application (`apps/server/README.md`).
- **Get back:** the server's `wss://` URL, and whether it relays through TURN.

The private key never leaves your backend. Locally, `examples/backend-issuer/src/keygen.ts` makes
a key and `src/registry.ts` the entry that trusts it, for a server you run yourself
(`examples/minimal-app/README.md#running`).

## 2. Issue tokens from your backend

Add to your backend (`docs/token-issuance.md`; in code, `examples/backend-issuer/src/backend.ts`):

1. **Device enrollment.** Under the user's session, record each device's `deviceId` and its key's
   thumbprint, keeping the first thumbprint of a device (`docs/token-issuance.md#proof-of-possession`).
2. **A token endpoint.** Behind the user's session, protected from cross-site requests and
   rate-limited per user, it signs a new token on every call: `sub` the user, `device_id` the
   device, `namespaces` what it may join, `cnf.jkt` the enrolled thumbprint, a new `jti`, and a
   5-minute lifetime.
3. **Namespaces.** Choose the scopes, `<appId>:<scope>`, that group the devices allowed to reach
   each other, such as one per user or per shared workspace. Narrow sessions with `permissions`
   where a device should only accept them (`docs/token-issuance.md#session-permissions`).

`sub` and `device_id` reach other devices in protocol messages: use opaque IDs, never personal
data.

## 3. Connect from the browser

In the page (`packages/sdk/README.md`; in code, `examples/minimal-app/public/app.ts`):

1. **Load the device key** with `DeviceKey.load()`, and enroll its `thumbprint` with your backend.
2. **Pick a stable device ID,** kept in the browser, and send it to your token endpoint.
3. **Create the client** with `serverUrl`, `deviceKey`, and an `accessTokenProvider` that calls
   your token endpoint on every call.
4. **Connect, join, discover:** `connect()`, `join(namespace)`, `discover(namespace)`, and the
   `presence` event for devices that come and go.
5. **Open a session:** `createSession()` on one device; on the other, answer `sessionRequest` with
   `accept()` or `reject()`. Send with `session.send()` once `open`, and receive on `data`.
6. **Handle the client's end.** Retryable failures reconnect on their own. A terminal error, such
   as `application_unavailable` or `device_revoked`, stops the client and closes every
   DataChannel; a superseded one stops it until you call `connect()` again
   (`packages/sdk/README.md#errors`).

The SDK is not on npm until its first release, `0.1.0` (ADR 0043): until then a package in this
workspace depends on it (`packages/sdk/README.md#installation`).

## 4. Add a user's second device

A device the user adds gets a token with the namespace in `pairing`, not in `namespaces`. It calls
`client.requestPairing(namespace)`; one of the user's devices already in the namespace answers the
`pairingRequest` event with `approve()`; the new device sends the approval to your backend, which
checks it, records the pairing, and from then on issues its tokens with the namespace. The new
device calls `client.refresh()` to get such a token without reconnecting, then joins
(`docs/token-issuance.md#pairing`, `packages/sdk/README.md#pairing`; in code, the `/pairings` route
of `examples/backend-issuer/src/backend.ts`).

Skip this step if your backend can decide on its own that a device belongs in a namespace.

## 5. Decide on end-to-end encryption

DTLS encrypts every DataChannel, but it trusts the signaling server, which relays each peer's
certificate fingerprint. If payloads must stay private from the BlindSignal server and its
operator, encrypt them yourself before `session.send()`, with keys authenticated outside
BlindSignal (`docs/application-e2ee.md`).

## Before production

- [ ] The pages are served over HTTPS from the origins the operator listed: `DeviceKey` needs a
      secure context, and the SDK refuses `ws://` except on loopback.
- [ ] Tokens last 5 minutes, carry a new `jti`, and are never cached or logged; the backend clock
      is synchronized (`docs/token-issuance.md#lifetime-and-clocks`).
- [ ] Every token is bound with `cnf.jkt`, and then the operator sets `requireProofOfPossession`
      (`docs/application-lifecycle.md#onboarding`).
- [ ] The signing key is rotated as `docs/token-issuance.md#key-rotation` describes, and you know
      who to tell when it leaks (`docs/secrets-and-keys.md`).
- [ ] A lost device is cut off: your backend stops issuing its tokens, and the operator revokes it
      to close its open connections (`docs/application-lifecycle.md#revoking-a-device`).
- [ ] Every payload a peer sends is validated as untrusted input.
- [ ] The page handles a terminal error, such as a suspended application, with a message to the
      user, not a reconnect loop.
- [ ] The browsers your users run are supported: Chrome and Edge 119, Firefox 121, Safari 17.4, and
      later (`packages/sdk/README.md#browser-support`).
- [ ] The expected devices, connections, and sessions fit the application's quotas, agreed with
      the operator (step 1).

## When a connection is rejected

The server answers every rejected token with one code and never says which check failed.
`docs/token-issuance.md#rejections` maps each code to its causes on the backend; the operator sees
the application's authentications on `/metrics`.
