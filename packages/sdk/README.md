# @blindsignal/sdk

The browser client for BlindSignal: it authenticates with a token from the application backend,
joins namespaces, discovers devices, and opens one WebRTC DataChannel per session. Application
payloads travel only over the DataChannel, never through the signaling server.

The package ships ESM and leaves bundling to the application (ADR 0001). It imports only
`@blindsignal/protocol` and web-standard globals (ADR 0002). `examples/browser-demo` runs it in a
page, and its Playwright tests cover Chromium, Firefox, and WebKit. `examples/minimal-app` is the shortest
complete use: a page whose backend issues bound tokens and grants pairings.

## Installation

The SDK is not on npm yet: its first release is `0.1.0` (`docs/adr/0043-semantic-versioning.md`).
Until then, a package in this workspace depends on it as the examples do:

```json
{ "dependencies": { "@blindsignal/sdk": "workspace:*" } }
```

Its `exports` point at the TypeScript sources, which the examples serve to the browser as they
are; `pnpm build` writes the JavaScript and the types to `dist/`.

## Browser support

Chrome and Edge 119, Firefox 121, and Safari 17.4, and later, on desktop and iOS
(`docs/adr/0047-supported-browsers.md`). The SDK needs WebRTC DataChannels, WebCrypto ECDSA P-256,
and `Promise.withResolvers`; `DeviceKey.load()` needs IndexedDB and a secure context. CI runs
Chromium, Firefox, and WebKit; in WebKit only through a TURN relay, so direct connections in Safari
and every iOS browser are untested.

## Usage

```typescript
import { BlindSignalClient, BlindSignalError } from "@blindsignal/sdk";

const client = new BlindSignalClient({
  serverUrl: "wss://signal.example.com",
  // Called for every authentication and refresh: tokens are single-use.
  accessTokenProvider: () => fetch("/blindsignal-token").then((response) => response.text()),
  iceServers: [{ urls: ["stun:stun.example.com:3478"] }],
});

client.on("state", ({ state, error }) => console.log(state, error));
client.on("presence", ({ userId, deviceId, present }) => console.log(userId, deviceId, present));
client.on("sessionRequest", (request) => {
  // The application decides; an unanswered request times out.
  void request.accept().then((session) => session.on("data", console.log));
});

try {
  await client.connect();
} catch (error) {
  // The client stopped: a terminal error, or close() before it connected.
  if (error instanceof BlindSignalError) console.log(error.code);
  throw error;
}
await client.join("notes:workspace");
const [device] = await client.discover("notes:workspace");
if (device) {
  const session = await client.createSession({ namespace: "notes:workspace", ...device });
  session.on("open", () => session.send("hello"));
}
```

## BlindSignalClient

`new BlindSignalClient(options)` takes `BlindSignalClientOptions`:

| Option | Default | Meaning |
|---|---|---|
| `serverUrl` | required | `wss://`, or `ws://` on `localhost`, `127.0.0.1`, or `[::1]`; no userinfo, query, or fragment. |
| `accessTokenProvider` | required | Returns a new token from the application backend. |
| `deviceKey` | none | A `DeviceKey`: proves possession on every authentication, for tokens bound with `cnf.jkt` (ADR 0041). |
| `iceServers` | `[]` | STUN servers only, without `username` or `credential`; TURN comes from the server's `rtc.ice_config`. Copied when the client is built. |
| `iceTransportPolicy` | `all` | `relay` uses TURN candidates only, hiding this device's addresses from its peers. |
| `refreshMarginMs` | `60000` | How long before expiry `auth.refresh` is sent. |
| `backoff` | `{ baseMs: 1000, maxMs: 30000 }` | `BackoffOptions`: reconnect and refresh retry delays, with full jitter. |
| `backoffResetMs` | `30000` | Time connected after which the reconnect count resets. |
| `heartbeat` | `{ intervalMs: 25000, timeoutMs: 10000 }` | `HeartbeatOptions`: `connection.ping` interval and pong timeout. |
| `maxIceRestarts` | `3` | ICE restarts in a row before a failed connection closes. |
| `connectTimeoutMs` | `30000` | Time to connect after each offer/answer exchange before the connection counts as failed (ADR 0018). |
| `createSocket`, `createPeerConnection` | browser globals | Replaced in tests; see [Testing](#testing). |

| Member | Meaning |
|---|---|
| `connect()` | Connects, retrying with backoff; resolves to an `Identity`, `{ userId, deviceId }`, once authenticated, and rejects with a `BlindSignalError` when the client stops. |
| `join(namespace)`, `leave(namespace)` | Presence in a namespace; joined namespaces are joined again after a reconnect. |
| `discover(namespace)` | The other devices present in a joined namespace: each a `Device`, `{ userId, deviceId }`. A namespace too large for one message lists only the devices that fit; `presence` events report every change. |
| `createSession({ namespace, userId, deviceId })` | A requester's `Session`, `pending` until the target accepts. |
| `requestPairing(namespace)` | Asks this user's devices in `namespace` to approve this one; see [Pairing](#pairing). |
| `refresh()` | Sends `auth.refresh` now with a new token, for when the backend changed what the token grants; rejects with a `BlindSignalError` and keeps the current token. Refreshes before expiry need no call. |
| `close()` | Closes the connection and stops reconnecting; open DataChannels stay until their sessions close. |
| `state` | A `ConnectionState`: `disconnected`, `connecting`, or `connected`. |

`ClientEvents` maps each event to its payload:

| Event | Payload |
|---|---|
| `state` | `{ state, error? }`; `error` is the code that stopped the client. |
| `presence` | A `Presence`: `{ namespace, userId, deviceId, present }`. |
| `rejoinFailed` | `{ namespace, error }`: a namespace not joined again after a reconnect. |
| `sessionRequest` | A `SessionRequest`: the peer's `namespace`, `userId`, and `deviceId`, `sessionId`, `accept()`, which resolves to the target's `Session`, and `reject()`. |
| `pairingRequest` | A `PairingRequest`: `pairingId`, the new device's `namespace`, `userId`, `deviceId`, and `jkt`, `approve()`, and `reject()`. |
| `pairingEnded` | `{ pairingId, reason }`: a pairing request ended without this device's answer: `answered`, `timeout`, `requester_gone`, `namespace_unauthorized`, or a reason a later server adds. |

`on(event, listener)` returns the function that removes the listener.

## DeviceKey

A token bound to a device key with `cnf.jkt` works only for the device holding that key
(`docs/token-issuance.md#proof-of-possession`). `DeviceKey.load()` returns this origin's P-256
key, generated non-extractable on first use and kept in IndexedDB; a reload, or another tab, gets
the same one.

```typescript
import { BlindSignalClient, DeviceKey } from "@blindsignal/sdk";

const deviceKey = await DeviceKey.load();
// The backend records the thumbprint for this device and puts it in each token's cnf.jkt.
const client = new BlindSignalClient({
  serverUrl: "wss://signal.example.com",
  accessTokenProvider: () =>
    fetch(`/blindsignal-token?jkt=${deviceKey.thumbprint}`).then((response) => response.text()),
  deviceKey,
});
```

With `deviceKey`, the client waits for the server's `auth.challenge`, up to `heartbeat.timeoutMs`,
and signs a proof for each token. Clearing the site's data loses the key: the backend then binds
the new one. `DeviceKey.from(keyPair)` wraps a non-extractable P-256 ECDSA pair kept elsewhere,
and throws a `TypeError` for any other.

| Member | Meaning |
|---|---|
| `thumbprint` | The key's JWK thumbprint (RFC 7638), base64url: the value of `cnf.jkt`. |
| `approval(device)` | Signs a pairing approval for an `ApprovedDevice`, `{ pairingId, namespace, userId, deviceId, jkt }`; `PairingRequest.approve()` calls it. |

## Pairing

A device the user adds asks the user's devices already in a namespace to approve it, then takes
the approval to the backend, which issues it tokens with the namespace (`docs/adr/0042-pairing.md`,
`docs/token-issuance.md#pairing`). Both sides need a `deviceKey` and tokens bound to it; the new
device's token lists the namespace in `pairing`.

```typescript
// The new device; requestPairing() without a deviceKey rejects with a TypeError.
const result = await client.requestPairing("notes:workspace");
if (result.status === "approved") {
  await fetch("/pairings", { method: "POST", body: result.approval });
  // The next token lists the namespace.
  await client.refresh();
  await client.join("notes:workspace");
}

// A device already in the namespace, joined there.
client.on("pairingRequest", (request) => {
  // The application asks its user; approve() signs the approval with the device key.
  void request.approve();
});
```

`requestPairing` resolves to a `PairingResult`: `{ status: "approved", approval }`,
`{ status: "rejected" }`, or `{ status: "timeout" }`. It rejects with a `BlindSignalError`:
`peer_unavailable` when no device can be asked, `not_authorized`, also when a refresh drops the
namespace from the token's `pairing` claim before an answer, `rate_limited`, or
`connection_closed` when the connection drops before an answer. The approval is a JWT valid for 5
minutes.

## Session

| Member | Meaning |
|---|---|
| `id`, `peer`, `role` | The session ID, the peer, a `Peer`: `{ namespace, userId, deviceId }`, and `requester` or `target`. |
| `state` | A `SessionState`: `pending`, `active`, or `ended`: the server-side session. |
| `connectionType` | A `ConnectionType`: `direct`, `relay`, or `unknown`, from the selected ICE candidate pair. |
| `send(data)` | `ChannelData`: a string, `ArrayBuffer`, or typed array; throws `InvalidStateError` until `open`. |
| `close()` | Ends the session and closes its DataChannel. |

`SessionEvents` maps each event to its payload:

| Event | Payload |
|---|---|
| `accepted` | The target accepted (requester only). |
| `open` | The DataChannel opened. |
| `data` | A string or an `ArrayBuffer`. |
| `connectionType` | The type, read each time the connection connects. |
| `ended` | `{ reason }`: signaling for the session ended. |
| `close` | The DataChannel closed, or the connection failed for good. |

The `ended` reason is a `SessionEndReason`:

- a `TerminationReason` the server sent, listed in `terminationReasons`: `closed_by_peer`,
  `peer_disconnected`, `peer_revoked`, `timeout`, `namespace_unauthorized`, or a reason a later
  server adds;
- `rejected`: the target rejected the request;
- `closed`: this side called `close()`;
- `disconnected`: this client's own connection dropped.

A session that ends only because a signaling path dropped (`peer_disconnected`, or `disconnected`)
keeps a DataChannel that is already open; every other end closes it. The full behavior is in
`docs/protocol.md` §10.

## Errors

Requests reject with `BlindSignalError`. Its `code` is an `ErrorCode` (`docs/protocol.md` §9),
`connection_closed`, or `protocol_error`; `retryAfterMs` is set for `rate_limited`.
`errorClasses` maps each `ErrorCode` to its `ErrorClass`: `retryable`, `terminal`, or
`superseded`. A code missing from `errorClasses` comes from a later server and counts as retryable
(ADR 0045). Retryable failures reconnect on their own. A terminal error stops the client and
closes every DataChannel; a superseded one (another connection took the device) stops it until
the application calls `connect()` again.

## Testing

`@blindsignal/sdk/testing` exports `FakePeerConnection` and `FakeDataChannel`, driven by the
test, to return from `createPeerConnection`, a `PeerConnectionFactory`, where no WebRTC stack
exists, as in Node:

```typescript
import { BlindSignalClient } from "@blindsignal/sdk";
import { FakePeerConnection } from "@blindsignal/sdk/testing";

const peers: FakePeerConnection[] = [];
const client = new BlindSignalClient({
  serverUrl: "ws://localhost:8080",
  accessTokenProvider: () => fetch("http://localhost:3000/token").then((response) => response.text()),
  createPeerConnection: (configuration) => {
    const peer = new FakePeerConnection(configuration);
    peers.push(peer);
    return peer as unknown as RTCPeerConnection;
  },
});
```

| `FakePeerConnection` member | Meaning |
|---|---|
| `channels`, `candidates` | The DataChannels created or received, and the remote candidates added. |
| `gather(candidate)` | Gathers a local candidate, which the client relays; `null` ends gathering. |
| `remoteChannel()` | The peer's DataChannel arrives, as on the target. |
| `state(state)` | Sets `connectionState` and fires `connectionstatechange`. |
| `fail` | Makes the next `setRemoteDescription` or `addIceCandidate` reject. |
| `stats` | What `getStats()` resolves to, where `connectionType` reads the selected pair; `undefined` makes it reject. |

| `FakeDataChannel` member | Meaning |
|---|---|
| `open()` | Opens the channel. |
| `receive(data)` | The peer sends `data`. |
| `sent` | What the client sent. |

## API stability

The public API is what `@blindsignal/sdk` and `@blindsignal/sdk/testing` export, versioned as ADR
0043 defines. Members tagged `@internal`, which the client calls on its own objects, are left out of
the published types and of that contract (`docs/adr/0046-sdk-public-api.md`). This README names
every export, and a test fails when one is missing (`apps/server/src/sdk-readme.test.ts`).
