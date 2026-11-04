# Application-level end-to-end encryption

What BlindSignal protects in a payload, what it leaves to the application, and what an application
that needs end-to-end encryption (E2EE) must do. BlindSignal is not an encryption framework
(spec §3): E2EE is each application's responsibility (spec §4.1, §16). This guide sets no protocol
of its own.

## What BlindSignal protects

- **The server never receives payloads.** The protocol has no payload messages; application data
  travels only over the WebRTC DataChannel (spec §4.1).
- **DTLS encrypts every DataChannel,** direct or relayed. A TURN server relays encrypted packets
  and cannot read them (spec §12.3), and neither can an attacker on the network between the peers.
- **Only authorized devices reach each other.** The server relays `rtc.*` only within a session the
  target accepted, between devices its tokens authorize (`docs/protocol.md` §7).

## What it does not protect

- **DTLS trusts the signaling server.** Each peer's certificate fingerprint travels inside the
  `sdp` of `rtc.offer` and `rtc.answer`, which the server relays as an opaque string. A server, or
  an operator, that rewrites those fingerprints can place itself between the peers and read every
  payload. The threat model accepts this risk and leaves a compromised server out of scope
  (`docs/threat-model.md` §5, §6).
- **The peer's identity is the one the server asserts.** `session.peer` comes from the server, and
  the DataChannel ends at whoever completed DTLS with the fingerprint the server relayed.
- **Revocation does not close an open DataChannel.** A modified client can keep a direct
  connection open after its device or application is revoked (spec §6.4).
- **Metadata stays visible.** The server sees identifiers, addresses, timing, and session
  participants (spec §17); a TURN server sees the size and timing of relayed packets.

An application that trusts the operator of its BlindSignal server, and needs no more than these
guarantees, can rely on DTLS alone.

## What the application must do

An application that must keep payloads private from the BlindSignal server, or from its operator:

1. **Encrypts payloads before `session.send()`,** with keys that never pass through BlindSignal in
   the clear.
2. **Authenticates each peer's key outside BlindSignal.** Fetch it from the application's own
   backend over HTTPS, or let users compare a code on both devices. A key exchanged only over the
   DataChannel, or vouched for only by `session.peer`, is as trustworthy as the server.
3. **Uses an established protocol and a reviewed library,** such as MLS (RFC 9420) for groups.
   Never design its own cryptography.
4. **Rotates keys on revocation,** so a revoked device that keeps a DataChannel open cannot read
   what is sent after it (spec §6.4).
5. **Keeps its encryption keys apart from the SDK's `DeviceKey`.** The `DeviceKey` is a
   non-extractable P-256 signing key that signs only the SDK's proof of possession and pairing
   approvals (ADR 0041, ADR 0042); the SDK exposes no other use of it.
6. **Validates every decrypted payload** as untrusted input: an authorized peer may still be
   malicious (`docs/threat-model.md` §2).

Pairing (ADR 0042) decides which devices the backend admits to a namespace. It does not distribute
encryption keys: a device admitted by pairing still needs the application's keys, delivered by the
application.
