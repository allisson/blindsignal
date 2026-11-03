# ICE configuration delivered with each authentication

**Status:** accepted

TURN credentials reach the SDK only through `rtc.ice_config` (spec §12.3), and they must be
temporary. The server sends `rtc.ice_config` after every successful `auth.authenticate` and
`auth.refresh`, and at no other time. Renewing TURN credentials together with the token gives
one renewal cadence and no extra timer: the SDK already refreshes before the token expires
(ADR 0006). Sending it per session was rejected: it adds a message to every session setup and
gives a credential lifetime unrelated to the connection's.

## Rules

- **Payload:** `{ iceServers }`, an array of `{ urls, username?, credential? }`, the shape of the
  WebRTC `RTCIceServer`. It holds only server-configured servers, TURN with temporary credentials
  among them, and is empty when none are configured. The SDK merges it with its own STUN-only
  `iceServers` (spec §20).
- **Credential lifetime:** the server's configuration must give TURN credentials a lifetime of
  at least the maximum token lifetime plus the clock-skew tolerance, so each set stays valid
  until the next `auth.refresh` brings a new one. The server refuses to start otherwise.
- **Applying a new set:** the SDK uses the latest `rtc.ice_config` for every new
  `RTCPeerConnection` and applies it to existing ones with `setConfiguration` before an ICE
  restart. Established relay allocations are not touched.
- **Connection type:** the SDK reads the selected candidate pair from `getStats()`: `relay` when
  either candidate is of type `relay`, `direct` otherwise, and `unknown` while no pair is
  selected.

## Consequences

- A revoked device or a closed connection stops receiving credentials; the ones already issued
  stay usable until they expire (spec §6.4).
- The server mints TURN credentials with the shared-secret scheme Coturn supports
  (`docs/adr/0017-turn-credentials.md`).
