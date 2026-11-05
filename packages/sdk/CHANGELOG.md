# Changelog

`@blindsignal/sdk` and `@blindsignal/protocol`, which share its version, follow semantic
versioning (`docs/adr/0043-semantic-versioning.md`). Each release is tagged `sdk-v<x.y.z>`.

## 0.1.1

No change to the API or its behavior: the first version published from CI, with a provenance
attestation (ADR 0050).

## 0.1.0

The first publication. It speaks protocol major `1` (`docs/protocol.md`).

- **Connection:** `BlindSignalClient` authenticates over `wss://` with a token from the
  application backend, refreshes it before expiry and on `refresh()`, sends heartbeats, and
  reconnects with backoff, rejoining its namespaces (ADR 0046).
- **Discovery:** namespaces the token grants, presence events, and the devices of a namespace
  (ADR 0007).
- **Sessions:** one WebRTC DataChannel per session, requested, accepted, or rejected per device;
  a session that never connects is closed (ADR 0018), and one past the server's maximum duration
  ends (ADR 0014). TURN servers come only from the server (ADR 0009, ADR 0017).
- **Device key:** a non-extractable ECDSA P-256 `DeviceKey`, kept in IndexedDB, signs the
  proof-of-possession of a bound token (ADR 0041) and the approvals of `requestPairing()`
  (ADR 0042).
- **Errors:** `BlindSignalError` with a code and its class; codes and end reasons a later server
  adds are accepted (ADR 0045).
- **Testing:** `@blindsignal/sdk/testing` exports `FakePeerConnection` and `FakeDataChannel`.
- **Browsers:** Chrome and Edge 119, Firefox 121, and Safari 17.4, and later (ADR 0047).
