# BlindSignal

BlindSignal lets the devices of a registered application find each other and open a WebRTC
DataChannel between them. The signaling server authenticates each device with a token that the
application's own backend issues, checks what that device may do, and relays the WebRTC offer,
answer, and ICE candidates. Application payloads then travel over the DataChannel, peer to peer or
through a TURN relay, and never through the server.

It is self-hosted infrastructure, not a public service: a server accepts only the applications its
operator registers.

## What it does

- **Admits registered applications only.** Each application is registered with its token issuer
  and keys; knowing the server URL or an application ID grants nothing.
- **Authenticates devices** with short-lived JWTs that the application backend signs, optionally
  bound to a non-extractable device key held in the browser (proof-of-possession).
- **Authorizes on the server,** per message and deny by default: which namespaces a device may join,
  and whom it may open a session with.
- **Discovers devices** present in a namespace, and **pairs** a new device with a user's existing
  devices, which approve it.
- **Signals one-to-one WebRTC sessions** and relays `rtc.*` messages only between the two devices of
  an accepted session.
- **Issues short-lived TURN credentials** for Coturn, so a session connects across restrictive
  networks.
- **Limits abuse** with per-application quotas, rate limits, and alerts.
- **Revokes** applications and devices, and runs on one instance in memory or on several with
  PostgreSQL and Redis or Valkey.

## What it never does

- Read, store, or relay application payloads: the protocol has no message for them.
- Hold an application secret or a permanent TURN credential in browser code.
- Encrypt payloads end to end beyond what WebRTC's DTLS gives: that is the application's job
  ([`docs/application-e2ee.md`](docs/application-e2ee.md)).
- Manage users or accounts: the application backend decides who a user is and what they may do.
- Hide IP addresses: the server, the peers, and the TURN server see them.

## Who it is for

- Teams building a browser or PWA application, with their own backend, whose devices exchange data
  directly: syncing a user's devices, or a channel between two users.
- Operators who want to run that signaling themselves, from one host to several instances.

## Who it is not for

- Applications without a backend: someone must sign the tokens.
- Native mobile or desktop clients: the SDK targets browsers (Chrome and Edge 119, Firefox 121,
  Safari 17.4, and later).
- Group sessions: a session has two devices, so a group opens one per pair.
- Audio and video calls, messaging, file storage, or anonymity: BlindSignal opens a DataChannel and
  stops there.
- Anyone looking for a hosted service: there is none.

## Release state

`0.1.x`, before `1.0.0`: the API and the operator surface can still change in a minor release, and
only the latest release gets fixes ([`SECURITY.md`](SECURITY.md)).

- SDK: [`@blindsignal/sdk`](packages/sdk/README.md) `0.1.1` on npm, with
  `@blindsignal/protocol` `0.1.1`.
- Server: the image `allisson/blindsignal` `0.1.0` on Docker Hub, for `amd64` and `arm64`.

Changes are in [`packages/sdk/CHANGELOG.md`](packages/sdk/CHANGELOG.md) and
[`apps/server/CHANGELOG.md`](apps/server/CHANGELOG.md).

## Where to start

- **Evaluating it:** [`docs/spec.md`](docs/spec.md) for the design,
  [`docs/threat-model.md`](docs/threat-model.md) for what it protects and the risks it accepts, and
  [`examples/browser-demo`](examples/browser-demo/README.md) to see two tabs open a DataChannel.
- **Integrating an application:** [`docs/onboarding.md`](docs/onboarding.md), then
  [`examples/minimal-app`](examples/minimal-app/README.md), a page and the backend that issues its
  tokens.
- **Operating the server:** [`docs/deployment.md`](docs/deployment.md) to choose a topology, and
  [`apps/server/README.md`](apps/server/README.md) for every setting and metric.
- **Contributing:** [`CONTRIBUTING.md`](CONTRIBUTING.md).

Every document, by audience: [`docs/README.md`](docs/README.md).

## License

[MIT](LICENSE).
