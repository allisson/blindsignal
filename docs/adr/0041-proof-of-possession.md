# Device proof-of-possession

**Status:** accepted

Spec §6.2 asks for device-key possession to complement JWT authentication, and ADR 0006 left it
post-MVP, with a token bound to a device key, as DPoP's `cnf.jkt` does, as the starting point.
Until then a stolen token works until its `exp`, from anywhere, for one connection (threat model,
accepted risk 1). This ADR binds a token to a key the device holds and the token thief does not.

## Rules

- **The SDK holds a P-256 key pair, generated with Web Crypto as non-extractable,** kept in
  IndexedDB, one per origin. It exposes the public key's JWK thumbprint (RFC 7638, SHA-256,
  base64url) for the application to send its backend. ES256 is the one algorithm every target
  browser supports for a non-extractable key.
- **The backend binds the token to that key with `cnf.jkt`** (RFC 7800, RFC 9449 §6.1): the
  thumbprint of the device's key. Which thumbprint belongs to which device is the backend's
  record, as the device itself is (ADR 0006); the server stores no key.
- **The server challenges every connection.** Right after the upgrade it sends
  `auth.challenge { nonce }`: 32 random bytes, base64url, one per connection, kept in the
  connection's memory, never in an adapter.
- **`auth.authenticate` and `auth.refresh` carry an optional `proof`:** a JWT signed with the
  device key, in the shape of a DPoP proof (RFC 9449 §4.2) without the HTTP claims. Header: `typ`
  `blindsignal-pop+jwt`, `alg` `ES256` or `EdDSA`, and `jwk`, the public key with no private
  parameter. Claims: `nonce`, the connection's, and `ath`, the base64url SHA-256 of the access
  token it accompanies. The nonce ties the proof to the connection and `ath` to one single-use
  token, so a proof is good once.
- **A token with `cnf.jkt` needs a valid proof:** signature by the `jwk`, `jwk` thumbprint equal to
  `cnf.jkt`, the connection's `nonce`, and the token's `ath`. Anything else gets `invalid_token`,
  checked before the `jti` is claimed, so a rejected proof never burns the token.
- **`requireProofOfPossession: true` in an application's registry entry rejects its tokens without
  `cnf.jkt`,** with `invalid_token`. Without it a token without `cnf` works as before, and a `proof`
  that comes with it is ignored. An application moves over in two steps: its backend adds `cnf`,
  then the operator sets the flag.
- **The key belongs to the connection:** an `auth.refresh` whose token has a different `cnf.jkt`,
  or adds or drops it, gets `identity_mismatch`, as a different device would (ADR 0006).
- **Protocol version 1 admits the new message (amends `docs/protocol.md` §2):** a new
  server-to-client message type that a receiver can ignore is allowed within a major version, and
  receivers ignore server message types they do not know. A client without a device key ignores
  `auth.challenge` and authenticates as before.

## Considered options

- **No nonce:** the proof carries only `iat` and `jti`. Rejected: a script injected in the page can
  sign proofs with the non-extractable key and send them, with tokens, to another machine; the
  nonce makes them good only on the connection that asked.
- **The server keeps each device's key from its first authentication,** with no backend change.
  Rejected: a token stolen before the device's first connection enrolls the thief's key.
- **The key thumbprint in the device record,** besides `cnf.jkt`. Rejected: a migration, and a
  device that loses its key (cleared site data) would be locked out until its record expires,
  while the backend already decides which key a device holds.
- **Protocol version 2 for `auth.challenge`.** Rejected: the server and the SDK would keep two
  versions for one message that the current SDK already ignores.
- **A fresh nonce after every proof.** Not needed: `ath` makes each proof single-use already.

## Consequences

- With proof-of-possession, a stolen token is useless without the device key, which no script can
  export. A script injected in the page can still use the key there, while it runs (threat model,
  accepted risk 1).
- The client waits for `auth.challenge` before authenticating with a key: half a round trip, the
  challenge being sent with the upgrade's answer.
- A device that loses its key (cleared site data, another browser profile) needs its backend to
  bind the new one; the server notices nothing.
- The SDK side, key storage and signing, lands apart from the server side, which accepts proofs
  from any client.
