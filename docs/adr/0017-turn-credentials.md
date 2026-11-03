# TURN credentials from a shared secret

**Status:** accepted

Spec §12.3 requires temporary TURN credentials issued by an authenticated server-side mechanism,
and ADR 0009 delivers them in `rtc.ice_config` after each `auth.authenticate` and `auth.refresh`,
leaving how they are minted to Phase 8. The server mints them itself with the shared-secret scheme
of the TURN REST API, which Coturn implements as `use-auth-secret`: no state, no dependency, and no
call to another service on the authentication path.

## Rules

- **Credential:** the username is `<expiry>:<app_id>`, where `<expiry>` is the Unix time in seconds
  at which the credential stops being accepted; the password is
  `base64(HMAC-SHA1(secret, username))`, computed with `node:crypto`. Each `rtc.ice_config` carries
  one `RTCIceServer` with every configured TURN URL and a credential minted for that message.
- **What the username carries:** the application ID only, never `sub`, `device_id`, a namespace, or
  a session (ADR 0012). It is already a metric label (ADR 0015) and lets the operator tie relay
  usage in the TURN server's logs to an application.
- **Scope:** a credential is valid for one application's users until its expiry. It cannot be
  revoked earlier: revocation stops new credentials, and those already issued expire (spec §6.4).
- **HMAC-SHA1 is the scheme's, not a choice of ours.** The REST scheme defines it, Coturn offers no
  other hash for it, and TURN itself authenticates messages with HMAC-SHA1 over an MD5-derived key
  (RFC 8489). Collisions do not weaken HMAC. The defense is a long random secret, a short lifetime,
  and delivery only over `wss://`. A SHA-256 variant is adopted when browsers and the TURN server
  support it, with a new ADR.
- **Configuration, from the environment only:**
  - `BLINDSIGNAL_TURN_URLS`: comma-separated `turn:` and `turns:` URLs; empty turns TURN off.
  - `BLINDSIGNAL_TURN_SECRET`: the secret shared with the TURN server; at least 32 bytes. Never
    logged, and a configuration error names the variable, never its value.
  - `BLINDSIGNAL_TURN_CREDENTIAL_TTL_SECONDS`: default 900.

  The server refuses to start when only one of the URLs and the secret is set, when the secret is
  shorter than 32 bytes, or when the lifetime is below the maximum token lifetime plus the
  clock-skew tolerance (ADR 0009). `BLINDSIGNAL_ICE_SERVERS` stays STUN-only, so no static TURN
  credential can be configured.
- **Forcing the relay:** the SDK accepts `iceTransportPolicy`, `all` (default) or `relay`, the
  `RTCConfiguration` field of that name, applied to every peer connection. It lets tests prove a
  relay path and lets an application hide device addresses from its peers, at the cost of relay
  traffic.
- **Metrics:** the server counts `blindsignal_turn_credentials_issued_total{app_id}`. Relay traffic
  comes from the TURN server's own metrics, aggregated: Coturn's `turn_traffic_*` counters carry a
  `realm` label only.
- **Testing:** a Coturn service in `compose.yaml`, under a `turn` profile, bound to loopback, with a
  test secret that, like the development issuer, is never trusted in production. Two browsers on
  one machine reach it on loopback and relay between two addresses inside its container, so it
  needs no `allow-loopback-peers`; Firefox needs `media.peerconnection.ice.loopback` to reach it.
  The Playwright suite starts it with `BLINDSIGNAL_TEST_TURN=1`, as CI does, and uses it with
  `iceTransportPolicy: 'relay'`. A TURN server reachable from other networks, for the
  cross-network test, is set up only with the operator's explicit approval.
- **Operating TURN** (the deployment guide): `denied-peer-ip` for private, loopback, link-local,
  and cloud metadata ranges, since a relay otherwise reaches the network that hosts it; never
  `allow-loopback-peers`; `turns:` on port 443 for networks that block everything
  else.

## Considered options

- **A managed TURN provider's API on each authentication.** Rejected for now: it adds latency and a
  point of failure to `auth.authenticate` and `auth.refresh`, and the provider's rate limits become
  ours. A provider can be added later behind an interface, when a deployment needs one.
- **Per-application TURN settings in the registry** (TURN off, or an application's own servers).
  Deferred: no application needs it yet, and the environment variables above remain the default
  it would override.
- **Relay traffic per application from Coturn's `prometheus-username-labels`.** Rejected: Coturn
  warns that it leaks memory with ephemeral usernames, which this scheme mints for every
  credential.
- **One realm per application,** to use the `realm` label. Rejected: with `static-auth-secret`
  Coturn serves one realm; several need its database.
- **The SDK reporting its connection type to the server.** Rejected: a client-asserted value, a
  protocol change, and session metadata that ADR 0012 avoids keeping.

## Consequences

- A deployment without TURN is unchanged: `rtc.ice_config` carries only the STUN servers.
- A stolen credential grants relay bandwidth until its expiry, at most the configured lifetime, and
  no access to payloads, which DTLS encrypts end to end (spec §12.3).
- Whether an established relay allocation survives its credential's expiry depends on the TURN
  server. Phase 8 tests it; if the allocation ends, the SDK's ICE restart with the latest
  `rtc.ice_config` recovers the session.
- Relay cost per application is estimated from issued credentials, not measured in bytes.
- Coturn joins the test infrastructure as a container image, not a workspace dependency.
