# Token profile and device identity

**Status:** accepted

The spec leaves the token profile and device enrollment open (spec §5.3, §6.2). For the MVP a
device is whatever the application backend asserts in the token, with no device-key
proof-of-possession: designing and reviewing that protocol would hold up the MVP, while short
token lifetimes, single-use `jti`, and TLS bound the window a stolen token can be used in. Because
the backend asserts `device_id` freely, a device is identified by `(app_id, sub, device_id)`, never
by `device_id` alone: otherwise one user could obtain a token naming another user's `device_id`
and take over its presence and connection.

## Token profile

- **Header:** `alg` is `EdDSA` (Ed25519) or `ES256`, within the allowlist configured per
  application; `kid` is required.
- **Required claims:** `iss`, `aud`, `sub`, `app_id`, `device_id`, `iat`, `exp`, `jti`, and
  `namespaces` (an array of strings, possibly empty, with a configurable maximum length). `nbf` is
  optional and validated when present. Unknown claims are ignored. What `namespaces` authorizes is
  settled with the namespace authorization source (spec §7.3).
- **Audience (amended with the token validation fixes):** `aud` is the application's audience, as
  a string or an array holding only it. A token whose `aud` also names another service is
  rejected: any service it names could use it here once.
- **Lifetime:** `exp − iat` at most 10 minutes by default; clock-skew tolerance 60 seconds by
  default, applied to `exp`, `nbf`, and `iat`. Both are configurable.
- **Replay:** every token is single-use. Each `auth.authenticate` and each `auth.refresh` needs a
  token whose `(iss, jti)` the server has not accepted before; the pair is tracked until
  `exp` + skew. The SDK therefore asks the access-token provider for a new token on every
  connection and every refresh, and two tabs never share one.
- **Replay across restarts:** while `jti` tracking lives in memory, a restart forgets every
  accepted pair, so the server rejects tokens whose `iat` is earlier than its own start time,
  without skew tolerance. A token issued before the restart may already have been used, and no
  record says otherwise. After a restart every client needs a new token, which it asks for on
  reconnect anyway; an issuer whose clock lags is rejected for at most its lag after boot. A
  coordination adapter that persists `jti` tracking (roadmap Phase 9) lifts this rule.
- **Expiry on an open connection:** at `exp` + skew without a successful `auth.refresh`, the
  server closes the connection with `token_expired` (retryable). There is no grace period; the SDK
  refreshes before expiry, using the `expiresInMs` that `auth.result` reports, since it treats the
  token as opaque (ADR 0002).

## Device identity

- **Enrollment is the first successful authentication.** The server creates the device record
  then; there is no separate registration step, so `device.register` and its permission leave the
  MVP protocol.
- **Device-count quota is in the MVP.** Any user can mint new `device_id`s through its backend, so
  a per-application maximum bounds the records the server keeps.
- **Revocation** targets the same triple, through the registry file (ADR 0005), and is checked on
  `auth.authenticate` and `auth.refresh`.
- **Proof-of-possession** stays post-MVP (roadmap Phase 5), designed and reviewed before it is
  implemented; a token bound to a device key (as DPoP's `cnf.jkt` does) is the starting point.

## Consequences

- The protocol addresses another device by `userId` and `deviceId` together (`docs/protocol.md`).
- A token stolen from a device works until its `exp`, from anywhere, for one connection: an
  accepted MVP risk to record in the threat model.
