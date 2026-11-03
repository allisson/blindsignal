# BlindSignal threat model

**Status:** MVP scope, reviewed after the Phase 5 and 6 MVP subsets, before external testing (Phase 7)  
**Reference:** `docs/spec.md` §4, §5, §6, §8, §16, §17; `docs/protocol.md`; `docs/adr/`

What BlindSignal protects in the MVP, against whom, and which risks it accepts. Each mitigation
points to the document that defines it; this file adds no rule of its own.

## 1. Assets

| Asset | Why it matters |
|---|---|
| Access to the service | Only registered, active applications may consume it (spec §4.2). |
| Trust configuration (registry file) | Decides which issuers, keys, and applications are trusted (ADR 0005). |
| Access tokens | Bearer credentials for one connection of one device (ADR 0006). |
| TURN credentials | Grant relay bandwidth (ADR 0009). |
| Device identity and presence | Who is reachable, and as whom (ADR 0006, spec §7.3). |
| Session membership | Who may signal whom (ADR 0003, ADR 0004). |
| Metadata | Identifiers, IP addresses, timing, session participants (spec §4.4, §17). |
| Availability | Shared capacity across applications (spec §8). |

Application payloads are not an asset of the server: they never reach it (spec §4.1).

## 2. Actors

| Actor | Trust |
|---|---|
| Operator | Trusted. Edits the registry file and runs the host. |
| Application backend (issuer) | Trusted for its own application only. |
| Device of an application | Authenticated by its token; may be malicious within its own authorization. |
| Unauthenticated client | Anyone who can reach the WebSocket endpoint. |
| Network attacker | Can observe or alter traffic between the SDK, the server, and peers. |
| Remote peer | The other participant of a session; may be malicious after acceptance. |

## 3. Trust boundaries

1. **SDK ↔ server:** the WebSocket, crossed by every protocol message.
2. **Issuer ↔ server:** signed tokens and the JWKS fetch.
3. **Operator ↔ server:** the registry file and the process environment.
4. **Device ↔ device:** the WebRTC DataChannel, direct or through TURN.
5. **Server ↔ adapters:** storage and coordination state (ADR 0010).

## 4. Threats and mitigations

### 4.1 SDK ↔ server

| Threat | Mitigation | Reference |
|---|---|---|
| An unregistered or unknown application uses the service | Token validated against the registry; unknown issuer or application gets `invalid_token`, indistinguishable from a bad signature | spec §5.3, protocol §9 |
| Forged or altered token | Asymmetric signature, algorithm allowlist, required `kid`, checks of `iss`, `aud`, `exp`, `iat`, `nbf` | ADR 0006 |
| Replayed token | Single-use `(iss, jti)`, tracked until `exp` + skew; tokens issued before a restart rejected while tracking is in memory | ADR 0006 |
| Token leaked through URLs or logs | Token only in the `auth.*` payload after the socket opens; never logged | spec §16 |
| A user takes over another user's device | Device identified by `(app_id, sub, device_id)`; `auth.refresh` cannot change identity | ADR 0006 |
| Access to another application's namespaces | Namespace IDs carry the `<app_id>:` prefix; a foreign prefix rejects the token | ADR 0007 |
| Enumeration of namespaces, devices, or their load | Uniform `not_authorized` and `peer_unavailable` | protocol §6, §7, ADR 0011 |
| Unsolicited signaling to a device | `rtc.*` relayed only within a session the target accepted | protocol §7 |
| Spoofed sender or injected fields in relayed messages | The server rebuilds each relayed message from its validated payload | protocol §7 |
| Connection kept alive on an expired token | Closed at `exp` + skew with `token_expired` | ADR 0006 |
| Two tabs replacing each other in a loop | No automatic reconnect after `superseded` | ADR 0008 |
| Plaintext signaling | SDK refuses `ws://` except on loopback; TLS everywhere else | spec §16 |
| Cross-site WebSocket use from a hostile page | Token required on every connection; `Origin` allowlist as defense in depth | spec §16 |
| Pre-authentication flooding | Per-IP connection and authentication limits, unauthenticated connection cap, authentication deadline, HTTP `429` at the upgrade | spec §8.4, ADR 0011 |
| Post-authentication flooding or resource exhaustion | Token buckets per connection and session, application and device quotas, maximum message size, bounded per-connection queues and send buffers | ADR 0011, ADR 0013 |
| Forged forwarding headers to evade IP limits | Headers honored only from configured trusted proxies | ADR 0011 |
| Behind a tunnel or proxy (Phase 7), every client shares one address and its pre-authentication limits | The tunnel's connector listed as a trusted proxy, with its forwarding header (`cf-connecting-ip` for Cloudflare) | ADR 0011 |
| Metrics reached by clients | The admin port binds to loopback by default and serves only aggregates | ADR 0012 |
| Internal details leaked through errors | Fixed error codes with no free text | protocol §9 |

### 4.2 Issuer ↔ server

| Threat | Mitigation | Reference |
|---|---|---|
| A compromised issuer mints tokens for other applications | Each issuer maps to one application; `app_id` and namespace prefixes must match it | spec §5.3, ADR 0007 |
| Unknown `kid` values force repeated JWKS fetches | Per-issuer refetch cooldown | spec §5.3 |
| JWKS fetched over an insecure or slow channel | HTTPS-only `jwks_uri`, fetch timeout | spec §5.3 |
| Tokens issued for another service accepted | Audience check | ADR 0006 |

### 4.3 Operator ↔ server

| Threat | Mitigation | Reference |
|---|---|---|
| An invalid registry edit breaks trust configuration | Reload is all or nothing; the previous registry stays | ADR 0005 |
| A revoked application is brought back | Reactivation of a revoked application is rejected | ADR 0005 |
| Control plane reached with an application token | The control plane has no network surface | ADR 0005 |
| Development issuers trusted in production | Development issuers and test keys isolated from production configuration | spec §14.1 |
| A suspended or revoked application, or a revoked device, keeps its open connections | A registry reload closes the affected connections and ends their sessions | ADR 0005, spec §6.4 |
| Metadata kept beyond its use, or identifiers written to logs | State held only while the protocol needs it; logs with fixed fields and no user, device, or token; IP logs kept at most 14 days | ADR 0012 |

### 4.4 Device ↔ device

| Threat | Mitigation | Reference |
|---|---|---|
| Payload read by the server or a TURN relay | Payload only over DTLS-encrypted DataChannels; application E2EE on top | spec §4.1, §12.3 |
| TURN credentials stolen or reused | Temporary credentials scoped to one application, delivered only through `rtc.ice_config`; a long random shared secret | ADR 0009, ADR 0017 |
| A relay used to reach the network that hosts the TURN server | `denied-peer-ip` for private, loopback, link-local, and metadata ranges; no loopback peers outside tests | ADR 0017 |
| A revoked device keeps talking to its peers | Peers notified with `session.terminated`; the SDK closes the session | spec §6.4 |

### 4.5 Server ↔ adapters

| Threat | Mitigation | Reference |
|---|---|---|
| Races exceed quotas or accept a `jti` twice | Atomic adapter operations | ADR 0010 |
| In-memory state assumed safe across instances | In-memory adapters documented as single-instance only | spec §10.3 |

## 5. Accepted risks

1. **A stolen token works until its `exp`,** from anywhere, for one connection. Short lifetimes,
   single use, and TLS bound it; proof-of-possession is post-MVP (ADR 0006). Script injection in
   the application exposes `accessTokenProvider` and is equivalent to this.
2. **Device identity is backend-asserted.** A user can claim any `device_id` under its own `sub`,
   but never another user's device (ADR 0006).
3. **Established P2P sessions outlive revocation.** A modified client can keep a DataChannel
   open; relayed sessions last until TURN credentials and allocations expire (spec §6.4).
4. **Namespace removal is not immediate.** It takes effect at the next `auth.refresh` or
   reconnect, within the maximum token lifetime; device revocation is the fast path (ADR 0007).
5. **The server sees metadata** (spec §4.4): identifiers, IP addresses, timing, presence, and
   session participants. BlindSignal provides no anonymity, and operators can see this metadata
   while the server holds it, and client IPs in logs for up to 14 days (ADR 0012).
6. **Peers see each other's network addresses** through ICE candidates, inherent to WebRTC.
7. **In-memory adapters are single-instance** and lose device records, presence, and `jti`
   history on restart. Tokens issued before the restart are rejected, so the lost `jti` history
   allows no replay (ADR 0006); revocations survive in the registry file.
8. **A flooding connection is answered, not closed** (ADR 0011), until its queue fills and it is
   closed with `1013` (ADR 0013). Repeated violations raise an abuse alert, and suspending the
   application is the operator's decision (ADR 0016).
9. **The unauthenticated-connection caps are per instance** (`apps/server/README.md`): each
   instance behind a load balancer admits its own share.
10. **A device record past its TTL may stay in memory** until its application's next new device
    or a restart; it no longer counts toward any quota (ADR 0012).
11. **A TURN credential cannot be revoked before it expires.** A stolen one grants relay bandwidth
    for at most the configured lifetime, never payload access (ADR 0017).

## 6. Out of scope

- Application payload formats, E2EE, and business rules (spec §4.1).
- How the issuer authenticates its users.
- A compromised server host, operator, or issuer signing key; their protection is the deployer's.
- Cross-instance propagation of status changes, handled with distributed adapters (roadmap
  Phase 9).
- Pairing and proof-of-possession, threat-modeled when designed (spec §7.4, roadmap Phase 5).
