# @blindsignal/sdk

The browser client for BlindSignal: it authenticates with a token from the application backend,
joins namespaces, discovers devices, and opens one WebRTC DataChannel per session. Application
payloads travel only over the DataChannel, never through the signaling server.

The package ships ESM and leaves bundling to the application (ADR 0001). It imports only
`@blindsignal/protocol` and web-standard globals (ADR 0002). `examples/browser-demo` runs it in a
page, and its Playwright tests cover Chromium and Firefox.

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

await client.connect();
await client.join("notes:workspace");
const [device] = await client.discover("notes:workspace");
const session = await client.createSession({ namespace: "notes:workspace", ...device });
session.on("open", () => session.send("hello"));
```

## BlindSignalClient

| Option | Default | Meaning |
|---|---|---|
| `serverUrl` | required | `wss://`, or `ws://` on `localhost`, `127.0.0.1`, or `[::1]`. |
| `accessTokenProvider` | required | Returns a new token from the application backend. |
| `iceServers` | `[]` | STUN servers only; TURN comes from the server's `rtc.ice_config`. |
| `refreshMarginMs` | `60000` | How long before expiry `auth.refresh` is sent. |
| `backoff` | `{ baseMs: 1000, maxMs: 30000 }` | Reconnect and refresh retry delays, with full jitter. |
| `backoffResetMs` | `30000` | Time connected after which the reconnect count resets. |
| `heartbeat` | `{ intervalMs: 25000, timeoutMs: 10000 }` | `connection.ping` interval and pong timeout. |
| `maxIceRestarts` | `3` | ICE restarts in a row before a failed connection closes. |
| `connectTimeoutMs` | `30000` | Time to connect after each offer/answer exchange before the connection counts as failed (ADR 0018). |
| `createSocket`, `createPeerConnection` | browser globals | Replaced in tests. |

| Member | Meaning |
|---|---|
| `connect()` | Connects, retrying with backoff; resolves to `{ userId, deviceId }` once authenticated, rejects with a `BlindSignalError` when the client stops. |
| `join(namespace)`, `leave(namespace)` | Presence in a namespace; joined namespaces are joined again after a reconnect. |
| `discover(namespace)` | The other devices present in a joined namespace. |
| `createSession({ namespace, userId, deviceId })` | A requester's `Session`, `pending` until the target accepts. |
| `close()` | Closes the connection and stops reconnecting; open DataChannels stay until their sessions close. |
| `state` | `disconnected`, `connecting`, or `connected`. |

| Event | Payload |
|---|---|
| `state` | `{ state, error? }`; `error` is the code that stopped the client. |
| `presence` | `{ namespace, userId, deviceId, present }` |
| `rejoinFailed` | `{ namespace, error }`: a namespace not joined again after a reconnect. |
| `sessionRequest` | A `SessionRequest`: the peer, `sessionId`, `accept()`, and `reject()`. |

`on(event, listener)` returns the function that removes the listener.

## Session

| Member | Meaning |
|---|---|
| `id`, `peer`, `role` | The session ID, the peer's `{ namespace, userId, deviceId }`, and `requester` or `target`. |
| `state` | `pending`, `active`, or `ended`: the server-side session. |
| `connectionType` | `direct`, `relay`, or `unknown`, from the selected ICE candidate pair. |
| `send(data)` | A string, `ArrayBuffer`, or typed array; throws `InvalidStateError` until `open`. |
| `close()` | Ends the session and closes its DataChannel. |

| Event | Payload |
|---|---|
| `accepted` | The target accepted (requester only). |
| `open` | The DataChannel opened. |
| `data` | A string or an `ArrayBuffer`. |
| `connectionType` | The type, read each time the connection connects. |
| `ended` | `{ reason }`: signaling for the session ended. |
| `close` | The DataChannel closed, or the connection failed for good. |

A session that ends only because a signaling path dropped (`peer_disconnected`, or this client's
own reconnect) keeps a DataChannel that is already open; every other end closes it. The full
behavior is in `docs/protocol.md` §10.

## Errors

Requests reject with `BlindSignalError`. Its `code` is a protocol error code (`docs/protocol.md`
§9, exported as `errorClasses` with its class), `connection_closed`, or `protocol_error`;
`retryAfterMs` is set for `rate_limited`. Retryable failures reconnect on their own. A terminal
error stops the client and closes every DataChannel; a superseded one (another connection took the
device) stops it until the application calls `connect()` again.

## Testing

`@blindsignal/sdk/testing` exports `FakePeerConnection` and `FakeDataChannel`, driven by the
test, to pass as `createPeerConnection` where no WebRTC stack exists, as in Node.
