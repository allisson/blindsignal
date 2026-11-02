# BlindSignal — Technical Specification

**Status:** Draft  
**Architecture:** Application-agnostic, access-controlled P2P connectivity infrastructure  
**Initial target:** Browser / PWA

## 1. Overview

BlindSignal is an independent connectivity infrastructure that allows authorized applications and devices to discover each other and establish peer-to-peer communication sessions.

It is designed to be consumed by multiple applications, including BlindNotes, BlindVault, and BlindChat.

BlindSignal provides application access control, authentication, device identity, authorization, discovery, signaling, and connection lifecycle management.

It must not understand, inspect, or persist application payloads.

BlindSignal is not intended to be an unrestricted public connectivity service. Only explicitly registered and authorized applications may consume its infrastructure.

## 2. Goals

- Provide reusable P2P connectivity for multiple applications.
- Restrict infrastructure access to registered applications.
- Authenticate users and devices through application-issued credentials.
- Enforce independent server-side authorization.
- Keep application payloads outside the signaling server.
- Support browser and PWA environments without embedding application secrets in frontend code.
- Use WebSocket for signaling and WebRTC DataChannels for P2P communication.
- Support direct connections and TURN-relayed connections.
- Provide explicit device identity, pairing, authorization, and revocation.
- Protect the service against unauthorized consumption and resource abuse.
- Support local development without external infrastructure dependencies.
- Be portable across Cloud Run, VPS, and self-hosted Docker deployments.

## 3. Non-goals

BlindSignal is not:

- A messaging application.
- A file synchronization or storage service.
- A general-purpose database for application data.
- An identity provider or user account management service.
- An application-level encryption framework.
- An anonymity or IP-masking service.
- An unrestricted public P2P relay.
- A replacement for application-specific authorization and data validation.

## 4. Core design principles

### 4.1 Application-agnostic

BlindSignal does not understand application payloads. It provides authenticated connectivity between authorized devices.

Applications define:
- Payload formats.
- Application-level protocols.
- End-to-end encryption.
- Data validation and business rules.
- Conflict resolution and synchronization semantics.

### 4.2 Controlled infrastructure access

Every consuming application must be explicitly registered and authorized.

Knowing the BlindSignal server URL or application identifier must not be sufficient to use the service.

The server must validate the application context before accepting authenticated operations.

### 4.3 Zero-trust

Every application, user, device, namespace, and session must be authenticated or authorized according to its role.

A device being connected or discoverable does not automatically grant permission to communicate with another device.

Session IDs and namespace IDs must never act as bearer credentials.

### 4.4 Privacy-first

BlindSignal must minimize metadata collection and retention.

The signaling server may necessarily observe:
- Application identifiers.
- User and device identifiers.
- Connection and disconnection timestamps.
- Presence information.
- Session participants.
- Source IP addresses.
- Network diagnostics and ICE candidate metadata.

BlindSignal must not claim that its architecture provides anonymity.

### 4.5 Portable infrastructure

The application must not depend directly on a specific hosting provider, database vendor, or coordination service.

Infrastructure integrations must be implemented behind explicit interfaces.

### 4.6 No mandatory infrastructure for local development

A developer must be able to run the server and connect multiple local clients without requiring PostgreSQL, Redis, Supabase, Cloud Run, or a dedicated TURN server.

In-memory implementations must be available for local development and automated tests.

## 5. Trust boundaries and access-control model

BlindSignal must distinguish five security concerns:

1. **Application access:** Is this application registered and allowed to use BlindSignal?
2. **User authentication:** Is this user authenticated by the application's trusted identity system?
3. **Device authentication:** Is this device recognized and authorized?
4. **Operation authorization:** Can this device perform this specific operation?
5. **Abuse protection:** Is the application or device consuming resources within configured limits?

These checks are independent. Passing one does not automatically grant the permissions associated with another.

### 5.1 Application registration

BlindSignal maintains a registry of authorized applications.

Each application record should include:

- `app_id`
- Display name and metadata.
- Status: `active`, `suspended`, or `revoked`. Suspension is reversible; revocation is terminal.
- Trusted token issuer (`iss`).
- Trusted JWKS URI or configured public verification keys.
- Allowed signing algorithms.
- Expected token audience.
- Allowed namespaces or namespace policy.
- Resource quotas and rate-limit policies.
- Creation and modification timestamps.
- Optional token and key rotation metadata.

Example:

```text
Application: blindnotes
  app_id: blindnotes
  status: active
  issuer: https://api.blindnotes.example
  audience: blindsignal
  jwks_uri: https://api.blindnotes.example/.well-known/jwks.json

Application: blindvault
  app_id: blindvault
  status: active
  issuer: https://api.blindvault.example
  audience: blindsignal
  jwks_uri: https://api.blindvault.example/.well-known/jwks.json
```

An application identifier is public metadata, not a secret or credential.

### 5.2 No frontend application secrets

Browser and PWA clients are public clients. Any secret embedded in frontend code can be extracted.

Therefore:

- Never embed application secrets in JavaScript bundles.
- Never distribute backend private signing keys to SDK consumers.
- Never treat an API key embedded in a PWA as proof of application identity.
- Do not rely on CORS or `Origin` validation as authentication.
- Do not accept an `app_id` supplied by the client without validating it against a trusted token and application registry.

Application trust is established through server-side configuration and trusted token issuers, not through frontend secrecy.

### 5.3 Application-issued access tokens

The recommended browser authentication flow uses short-lived JWTs issued by the consuming application's backend.

The application backend:
1. Authenticates the user.
2. Checks whether the user is allowed to use BlindSignal.
3. Issues a short-lived token specifically intended for BlindSignal.
4. Signs it with a private key controlled by the backend.

BlindSignal:
1. Identifies the registered application using trusted issuer configuration.
2. Validates the token signature.
3. Validates issuer, audience, expiry, not-before time, and required claims.
4. Confirms that the application is active.
5. Establishes the authenticated user and device context.
6. Applies authorization policies and quotas.

Example JWT payload:

```json
{
  "iss": "https://api.blindnotes.example",
  "aud": "blindsignal",
  "sub": "user_123",
  "app_id": "blindnotes",
  "device_id": "device_456",
  "iat": 1793500000,
  "exp": 1793500600,
  "jti": "unique-token-id"
}
```

The example is illustrative. Final claims and token profiles must be formally specified.

Requirements:
- Short-lived tokens, initially targeting approximately 5–10 minutes.
- Asymmetric signing, such as EdDSA or ES256, subject to library and platform support.
- Explicit algorithm allowlisting.
- Validation of `iss`, `aud`, `exp`, `iat`, and required claims, and of `nbf` when present.
- A configurable maximum token lifetime (`exp` − `iat`), enforced by the server: a token exceeding it is rejected, whatever lifetime the issuer chose. This also bounds `jti` replay tracking.
- A configurable clock-skew tolerance applied to `exp`, `nbf`, and `iat`. A token whose `iat` is in the future beyond that tolerance is rejected.
- Key identification through `kid`.
- Public-key retrieval through trusted JWKS configuration or static key configuration. JWKS URIs use HTTPS only, and fetches have timeouts. Refetching keys on an unknown `kid` is rate-limited per issuer, so unauthenticated clients cannot force repeated JWKS fetches.
- Safe key rotation and cache refresh.
- Rejection of unknown, suspended, or revoked applications.
- No acceptance of tokens issued for unrelated services.
- Each trusted issuer maps to exactly one registered application. The `app_id` claim must match the application registered for the validated issuer; a mismatch is rejected.
- A defined `jti` replay policy (for example, single-use tokens within their validity window), specified in the token profile.
- A token presented through `auth.refresh` must carry the same `app_id`, `sub`, and `device_id` as the connection's current context; a mismatch is rejected. Changing identity requires a new connection.
- A defined behavior when a connection's token reaches `exp` without a successful `auth.refresh` (for example, closing the connection, possibly after a grace period), specified in the token profile. A connection must not remain authenticated indefinitely on an expired token.

The token is a credential for a specific application and service, not a general-purpose authorization grant.

### 5.4 Backend-to-server trust

Application backends are trusted token issuers.

If a future server-to-server API requires direct application authentication, it may use a separate mechanism such as asymmetric client authentication or mTLS.

This must not be confused with browser SDK authentication.

No shared application secret may be exposed to browser clients.

### 5.5 Application suspension and revocation

BlindSignal must support suspending or revoking an application independently of its users and devices.

When an application is suspended or revoked:
- New authentication must fail.
- Existing WebSocket connections must be terminated.
- New sessions must be rejected.
- Active sessions must be terminated within the limits described in §6.4.
- Its devices must no longer discover or communicate through the service.
- Its quotas and credentials must no longer be accepted.

In a single-instance deployment, including the MVP, suspension and revocation take effect immediately: new authentication fails and the application's active WebSocket connections are closed.

The system must define how quickly application status changes propagate across instances.

### 5.6 Control plane

Operators must be able to register, update, suspend, reactivate, and revoke applications, and revoke devices, without code changes. Only a suspended application can be reactivated.

The control-plane mechanism (configuration file, CLI, or authenticated administrative API) must be decided before implementation.

The control plane is separate from the browser signaling protocol. It must never be reachable with application-issued access tokens.

## 6. User and device identity

### 6.1 User identity

BlindSignal does not manage user passwords or user accounts.

The consuming application's backend is responsible for authenticating users and issuing service-specific tokens.

BlindSignal uses the trusted token subject (`sub`) as the user identity within the application's security boundary.

User identifiers must be scoped by application. The same subject string in two different applications must not imply the same identity.

### 6.2 Device identity

A user may own multiple devices.

Each device should have:
- A stable device identifier.
- An application association.
- An owner identity.
- A public key associated with device identity.
- Authorization state.
- Creation and last-seen metadata.
- Revocation status.

The SDK should generate a device key pair using platform cryptographic APIs such as Web Crypto API.

Where supported, private keys should be non-exportable and protected by the platform.

Device-key possession verification should complement JWT authentication. A device identifier alone is never proof of device identity.

The exact device enrollment and proof-of-possession protocol must be designed and reviewed before implementation. Whether the MVP requires proof-of-possession, or relies only on the backend-asserted `device_id` claim, must be decided explicitly at the same time.

### 6.3 Device revocation

Revoked devices must lose the ability to:
- Authenticate new connections.
- Register presence.
- Discover protected devices.
- Create or join sessions.
- Continue using existing authorized sessions.

Revocation must propagate to active connections as soon as practical, within the limits described in §6.4.

### 6.4 Enforcement limits for established P2P sessions

Once a WebRTC DataChannel is established, application data no longer passes through the signaling server. The server cannot forcibly sever a direct peer-to-peer connection.

On application or device revocation, the server can:
- Close the revoked party's WebSocket connections and reject new authentication.
- Notify the remaining peers of affected sessions that the counterpart was revoked.
- Stop issuing TURN credentials. Existing relay allocations may remain usable until their credentials expire, and, depending on the TURN server, up to one allocation lifetime afterwards.

Termination of an established P2P session therefore depends on the remaining authorized peer's SDK closing the connection when notified. A modified or malicious client can keep an established direct connection open. TURN credential and allocation lifetimes bound this window for relayed sessions.

When the SDK loses its signaling connection and reauthentication is rejected because the application is suspended or revoked, or the device is revoked, the SDK must close all of its sessions, including established DataChannels. This covers application suspension, where no remaining peer is left to notify (§11).

Applications that require stronger guarantees must enforce them at the application layer, for example by rotating end-to-end encryption keys on revocation.

## 7. Authorization

BlindSignal owns authorization for its own connectivity resources.

Application authentication does not automatically authorize every device, namespace, or session.

Authorization must be enforced server-side for every protected operation.

### 7.1 Authorization scopes

Authorization must consider:
- Application.
- User.
- Device.
- Namespace.
- Session.
- Requested operation.

### 7.2 Example permissions

| Resource | Permission |
|---|---|
| Device | `device.register` |
| Namespace | `namespace.discover` |
| Namespace | `namespace.join` |
| Session | `session.create` |
| Session | `session.accept` |
| Session | `session.signal` |
| Session | `session.close` |
| Device | `device.revoke` (control plane only, §5.6) |

The permission model must remain explicit and deny by default.

Device revocation is an operator action through the control plane; it is not available to devices through the signaling protocol.

### 7.3 Namespace isolation

Namespaces isolate devices and sessions by application and logical scope.

Examples:
- `blindnotes:<workspace-scope>`
- `blindvault:<vault-scope>`
- `blindchat:<conversation-scope>`

Namespace identifiers are not credentials.

A device must not be able to enumerate arbitrary namespaces or discover unauthorized devices.

The source of namespace authorization must be decided before implementation: claims asserted in the application-issued token (for example, a list of allowed namespaces), policy stored by BlindSignal, or a combination. The MVP needs a mechanism that does not depend on pairing (§7.4).

### 7.4 Pairing

Pairing establishes an explicit trust relationship between devices.

Requirements:
- Pairing must be authenticated.
- Pairing must be scoped to an application and namespace.
- Pairing must require authorization from the application's trusted backend and/or explicit approval from an already authorized device, according to the selected pairing policy.
- Pairing must be revocable.
- Pairing events should be auditable without storing application payloads.

The cryptographic pairing protocol must be specified and reviewed before implementation. Do not invent a custom cryptographic protocol.

## 8. Abuse prevention and resource protection

Authentication alone is not sufficient to protect a deployed service.

BlindSignal must enforce resource limits independently for applications and devices.

### 8.1 Rate limits

Initial rate-limit categories:
- Authentication attempts.
- WebSocket connection attempts.
- Concurrent connections per application.
- Concurrent connections per device.
- Discovery requests.
- Session creation.
- Signaling messages per connection and session.
- Pairing attempts.
- ICE candidate message rates.

Before authentication completes, the server does not yet know the connection's application or device, so application and device limits cannot apply. Connection-attempt and authentication-attempt limits are therefore keyed by source IP address and enforced globally.

Behind a reverse proxy, load balancer, or tunnel (§14.2, §14.3), the TCP peer address is the proxy's, not the client's. The server must derive the client IP from forwarding headers (such as `X-Forwarded-For` or `CF-Connecting-IP`) only when the request comes from an explicitly configured trusted proxy, and must otherwise use the TCP peer address. Forwarding headers from untrusted peers must be ignored, since clients can forge them.

### 8.2 Quotas

Application-level configurable quotas should include:
- Maximum concurrent WebSocket connections.
- Maximum registered or active devices, where applicable.
- Maximum concurrent sessions.
- Maximum session participants.
- Maximum signaling messages per time window.
- Maximum message size.
- Maximum session duration, where required.

Device-level limits should prevent a single device from exhausting an application's allocation.

Initial values must be configurable and validated through load testing rather than treated as universal constants.

### 8.3 Abuse response

The server must support:
- Temporary rate limiting.
- Connection rejection.
- Application suspension.
- Device revocation.
- Session termination.
- Operational alerts for abnormal usage.

Return consistent error codes and avoid leaking sensitive internal details.

Authentication and connection-closure error codes must tell the SDK whether a rejection is retryable (for example, an expired token that a new token from the application backend can replace), terminal (the application is suspended or revoked, or the device is revoked), or superseded (the duplicate-connection policy replaced this connection with a newer one of the same device, §13). The SDK stops reconnecting on a terminal rejection and closes its sessions (§6.4, §15). On a superseded closure it does not reconnect automatically, so two connections of the same device cannot replace each other in a loop.

### 8.4 Resource controls

Implement:
- Maximum WebSocket message size.
- Maximum concurrent connections.
- An authentication deadline: a connection that does not complete `auth.authenticate` within a configured time is closed.
- A cap on concurrent unauthenticated connections, per source IP address and globally.
- Bounded queues and backpressure.
- Session and presence expiration.
- Timeouts for incomplete negotiations.
- Graceful cleanup after disconnect.
- Per-application metrics and usage reporting.

TURN bandwidth and relay costs must be monitored separately when TURN is deployed.

## 9. High-level architecture

```text
             Consuming Application
                      |
                 Application UI
                      |
               Application Backend
                      |
          Authenticates user and authorizes use
                      |
            Issues short-lived JWT
                      |
                      v
              BlindSignal SDK
                      |
              WebSocket Signaling
                      |
              BlindSignal Server
               /       |       \
       Application  Identity  Authorization
          Guard      & Device   & Quotas
               \       |       /
                Session Management
                      |
                  WebRTC ICE
                      |
            DataChannel: P2P or TURN
```

The signaling server coordinates connections. Application payloads travel through WebRTC DataChannels, not through the signaling server.

## 10. Storage and coordination abstractions

### 10.1 StorageAdapter

Responsible for durable metadata:
- Registered applications and trust configuration.
- Device records.
- Namespace metadata.
- Pairing relationships.
- Authorization policies.
- Revocation state.
- Quota configuration.

Suggested interface:

```typescript
interface StorageAdapter {
  applications: ApplicationRepository;
  devices: DeviceRepository;
  namespaces: NamespaceRepository;
  pairings: PairingRepository;
  authorization: AuthorizationRepository;
}
```

Initial implementation:
- `InMemoryStorageAdapter`

Future implementation:
- `PostgreSQLStorageAdapter`

Supabase may be used as a managed PostgreSQL provider. Business logic must not depend on Supabase-specific APIs.

### 10.2 CoordinationAdapter

Responsible for distributed ephemeral state and event propagation:
- Presence leases.
- Instance ownership.
- Signaling event delivery.
- Cross-instance session coordination.
- Application suspension and revocation propagation.
- Rate-limit and quota counters.
- `jti` replay tracking (§5.3).
- TTL-based cleanup.

Initial implementation:
- `InMemoryCoordinationAdapter`

Future implementation:
- `RedisCoordinationAdapter` or another compatible distributed backend.

Redis Pub/Sub alone is not a durable presence store. Presence must use expiring leases or equivalent TTL-based state, with ownership and cleanup semantics.

### 10.3 Single-instance and multi-instance behavior

In-memory adapters are intended for local development, automated tests, and single-instance demonstrations.

They must not be presented as safe distributed coordination across multiple server instances.

Multi-instance deployments must use shared coordination and persistent storage where required.

## 11. Signaling protocol

The signaling protocol must be versioned and use JSON messages over WebSocket.

Every message should include:
- `version`
- `type`
- `requestId` where applicable
- `payload`

The protocol must define validation rules, maximum message sizes, error codes, and authorization requirements.

Naming: message types use dot-separated lowercase segments in snake_case (`rtc.ice_candidate`). Envelope fields and payload keys use camelCase (`requestId`). JWT claims keep their registered snake_case names (`app_id`, `device_id`).

Initial message categories:

| Category | Example messages |
|---|---|
| Authentication | `auth.authenticate`, `auth.refresh`, `auth.result` |
| Device | `device.register`, `device.status` |
| Namespace | `namespace.join`, `namespace.leave` |
| Presence | `presence.update`, `presence.changed` |
| Discovery | `discovery.request`, `discovery.result` |
| Pairing | `pairing.request`, `pairing.approve`, `pairing.reject` |
| Session | `session.create`, `session.request`, `session.accept`, `session.reject`, `session.close`, `session.terminated` |
| WebRTC | `rtc.offer`, `rtc.answer`, `rtc.ice_candidate`, `rtc.ice_restart` |
| Configuration | `rtc.ice_config` |
| Lifecycle | `connection.ping`, `connection.pong`, `error` |

`auth.refresh` renews the connection's credentials with a new application-issued token without reconnecting; the new token must keep the connection's identity (§5.3). `session.create` is sent by the requesting device to the server; `session.request` is sent by the server to the target device, which answers with `session.accept` or `session.reject`; the server forwards that answer to the requesting device. When a participant sends `session.close`, the server notifies the other participants; whether through a relayed `session.close` or through `session.terminated` is decided with the protocol draft. `session.terminated` is sent by the server to the remaining peers when a session ends for a reason outside their control, such as counterpart device revocation, and carries that reason (§6.4). Application suspension needs no such notice: all peers of a session belong to the same application, and their connections are closed (§5.5); each SDK closes its sessions when reauthentication is rejected (§6.4). `rtc.ice_config` is sent by the server and is the only channel for TURN credentials (§12.3). The server sends it after successful authentication, even when no TURN server is configured; whether it is also sent per session or when TURN credentials are renewed is decided together with the ICE configuration. `rtc.ice_restart` is relayed between session participants like `rtc.offer`; whether it remains a separate message type or ICE restart is expressed as a new `rtc.offer` is decided with the protocol draft. Pairing messages are finalized together with the pairing protocol (§7.4).

The protocol defines the direction of every message type: client to server, server to client, or relayed between session participants. The server rejects a message sent in a direction its type does not allow, for example a client-sent `rtc.ice_config`, `session.request`, or `session.terminated`. Server-originated `rtc.ice_config` is not a relayed message and is not subject to the session-membership rule (§13).

Administrative operations (§5.6) are not part of this protocol.

The server must authenticate the connection and authorize each protected message type.

The protocol must not include application payload messages.

## 12. Connectivity: ICE, STUN and TURN

### 12.1 ICE

ICE is responsible for finding a viable network path between peers.

The SDK must gather candidates, exchange them through signaling, handle connection state transitions, support ICE restart, and expose diagnostics.

### 12.2 STUN

STUN helps discover public-facing network addresses and assists ICE in establishing direct connectivity.

STUN is the initial connectivity strategy for the MVP.

Requirements:
- Configurable STUN URLs.
- No hardcoded single provider.
- Support multiple ICE servers.
- Environment-driven server configuration.
- Testing with public or self-hosted STUN services.

STUN cannot guarantee that direct connectivity will succeed.

### 12.3 TURN

TURN relays WebRTC traffic when a direct connection cannot be established.

TURN is not a mandatory infrastructure dependency for the initial MVP, but the SDK and signaling protocol must support it from the beginning.

Requirements:
- Server-side configurable TURN URLs and credential issuance.
- Temporary credentials issued through an authenticated server-side mechanism.
- No permanent credentials embedded in the browser SDK.
- TURN URLs and credentials reach the SDK only through `rtc.ice_config` from the server, never through client-side configuration. STUN URLs may be configured on the client (§20).
- Support for configured UDP and TCP/TLS relay transports.
- Reporting of direct versus relay connectivity.

ICE/WebRTC selects the viable candidate pair.

TURN relays encrypted WebRTC packets and does not need access to application plaintext.

### 12.4 Connection policy

1. Attempt direct connectivity using ICE candidates, including STUN-derived candidates.
2. Use TURN relay candidates when configured and direct connectivity is unavailable.
3. Report failure if no viable candidate pair can be established.

Connection type:
- `direct`
- `relay`
- `unknown`

## 13. Session lifecycle

1. SDK obtains an application-issued token.
2. SDK establishes WebSocket connection.
3. BlindSignal validates application registration and token.
4. Server validates device identity and authorization.
5. Device joins a namespace it is authorized in.
6. Device registers presence.
7. Device discovers authorized peers.
8. A device requests a session.
9. The other device accepts or rejects.
10. SDK instances exchange SDP and ICE information through signaling.
11. WebRTC establishes a direct or relayed connection.
12. Applications exchange data through DataChannels.
13. Session closes or expires.
14. Presence and session state are cleaned up.

The server must handle unexpected disconnects, duplicate connections, expired sessions, revoked applications, revoked devices, stale presence, invalid messages, and reconnection.

The duplicate-connection policy must be decided before implementation: what happens when a device that already has an active connection connects again (for example, the newer connection replaces the older one, or the newer one is rejected). It is decided together with the per-device concurrent connection limit (§8.1, §8.2), since a replace policy implies a limit of one connection per device. The policy must account for several browser tabs or windows sharing one device identity, and must not let them replace each other in a reconnect loop (§8.3).

Session cardinality must be decided before implementation: one-to-one sessions only, or multi-party sessions (and, if so, the topology, such as full mesh). The SDK API in §20 currently assumes one-to-one sessions; the "maximum session participants" quota (§8.2) only applies to multi-party sessions.

Every session is created within one namespace, and both devices must be authorized in it.

In the MVP, session-level authorization (§7.2) is not yet enforced beyond namespace authorization: any device authorized in a namespace may request a session with any other device in it, and the target device accepts or rejects (step 9).

Session membership is enforced from the MVP onward: the server relays `rtc.*` messages only between the participants of a session that the target device has accepted, and rejects them otherwise.

## 14. Deployment profiles

### 14.1 Local development

- BlindSignal server.
- In-memory storage.
- In-memory coordination.
- Browser SDK clients.
- Configurable STUN for cross-network tests.

No external database, Redis, Supabase, or TURN server is required for basic local development.

Development credentials and test issuers must be isolated from production trust configuration.

### 14.2 External device testing

- Local BlindSignal server.
- Cloudflare Quick Tunnel or another HTTPS/WebSocket tunnel.
- Browser SDK clients on separate networks.
- Configurable STUN.

Cloudflare Quick Tunnel is a development ingress mechanism. It is not a signaling protocol, WebRTC DataChannel transport, TURN relay, or production deployment strategy.

### 14.3 Managed deployment

Possible components:
- BlindSignal server on Cloud Run.
- PostgreSQL, optionally Supabase.
- Redis-compatible coordination when multiple instances are required.
- Coturn or managed TURN provider when needed.
- Managed secrets.
- OpenTelemetry-compatible observability.

These are deployment choices, not mandatory code dependencies.

### 14.4 Self-hosted deployment

Support:
- Docker or Docker Compose.
- PostgreSQL when persistence is required.
- Redis-compatible coordination when distributed operation is required.
- Optional Coturn.
- Environment-driven configuration.

The same application image should run in managed and self-hosted environments.

## 15. Persistent WebSocket connections and reconnection

The SDK maintains a persistent WebSocket connection while the application is active.

Requirements:
- Exponential backoff with jitter.
- Heartbeats and dead-connection detection.
- Reauthentication when required.
- Presence re-registration.
- Session state reconciliation.
- ICE restart or session recovery where appropriate.
- Graceful handling of duplicate connections, according to the policy decided in §13.
- Token expiration handling and renewal through the consuming application backend.

The implementation must account for hosting platforms that impose connection/request time limits.

A PWA may be suspended or terminated by the browser or operating system. BlindSignal must not promise background connectivity when the application is inactive or closed.

## 16. Security requirements

- TLS for signaling connections. The SDK refuses `ws://` URLs except for loopback hosts (`localhost`, `127.0.0.1`, `[::1]`) used in local development (§14.1). The server may accept plaintext WebSocket only from a local TLS-terminating proxy or tunnel (§14.2) or a local development container network; it must never be exposed to clients without TLS.
- Access tokens sent only in the authentication message after the WebSocket opens, never in the connection URL or query string.
- Registered applications only.
- Trusted issuer and signing-key configuration.
- Strict JWT validation and algorithm allowlisting.
- No frontend application secrets.
- Explicit user and device authentication.
- Server-side authorization for every protected operation.
- Namespace isolation.
- Device and application revocation.
- Rate limits and quotas.
- Message validation and size limits.
- Protection against replay and impersonation where applicable.
- Temporary TURN credentials.
- No logging of tokens, secrets, or application payloads.
- Strict origin policies as defense in depth, not as authentication. The `Origin` header is checked at the WebSocket upgrade, before the application is known, against a configured server-wide allowlist. A per-application allowlist, if added, can only be checked after authentication.
- Session expiration and cleanup.
- Regular dependency and security reviews.

Application-level E2EE is the responsibility of each consuming application.

## 17. Privacy and metadata

BlindSignal does not store application payloads.

However, signaling and connectivity require some metadata processing, including IP addresses, device identifiers, presence, session participants, timing, and ICE diagnostics.

The system should minimize collection, define retention policies, avoid logging raw credentials, and document operator visibility.

## 18. Observability

Initial metrics:
- Active WebSocket connections.
- Authentication success/failure.
- Rejected unknown or suspended applications.
- Active connections and sessions per application.
- Rate-limit events.
- Quota consumption.
- Presence registration and expiration.
- Session creation and failure.
- WebRTC negotiation success/failure.
- Direct versus relay connection counts.
- ICE connection duration.
- Reconnection frequency.
- Signaling message counts and errors.

Never include application payloads, tokens, or credentials in telemetry.

OpenTelemetry is the preferred instrumentation standard.

## 19. Suggested repository structure

```text
blindsignal/
├── apps/
│   └── server/
├── packages/
│   ├── sdk/
│   ├── protocol/
│   └── core/
├── adapters/
│   ├── storage/
│   │   ├── in-memory/
│   │   └── postgresql/
│   └── coordination/
│       ├── in-memory/
│       └── redis/
├── docs/
│   ├── spec.md
│   ├── roadmap.md
│   ├── adr/
│   ├── protocol.md
│   └── threat-model.md
├── examples/
├── tests/
├── Dockerfile
└── docker-compose.yml
```

`packages/protocol` is the wire contract shared by server and SDK. `packages/core` holds server-side domain types and the adapter interfaces (§10); the SDK never imports it. Dependency rules are in `docs/adr/0002-package-boundaries.md`.

Adapt to existing repository conventions rather than imposing this structure blindly.

## 20. Initial SDK API (illustrative)

```typescript
const client = new BlindSignalClient({
  serverUrl: "wss://signal.example.com",
  accessTokenProvider: async () => {
    // Obtain a short-lived token from the application backend.
    return applicationBackend.getBlindSignalToken();
  },
  deviceIdentity,
  iceServers: [
    { urls: ["stun:stun.example.com:3478"] }
  ]
});

await client.connect();

const devices = await client.discover({
  namespace: "blindnotes:workspace"
});

const session = await client.createSession({
  namespace: "blindnotes:workspace",
  deviceId: devices[0].id
});

session.on("data", (data) => {
  // Application-defined payload handling.
});

session.on("connectionType", (type) => {
  // "direct", "relay", or "unknown"
});
```

`iceServers` accepts STUN URLs only. TURN servers are merged in from `rtc.ice_config` (§12.3).

The SDK must not accept or require a permanent application secret.

The final API must define token refresh, authentication errors, device enrollment, and lifecycle behavior.

## 21. Testing requirements

### Unit tests
- Application registry and status.
- JWT validation and issuer mapping.
- Key rotation and JWKS behavior, including rate-limited refetch on an unknown `kid`.
- Maximum token lifetime and clock-skew tolerance.
- Authentication and authorization.
- Namespace isolation.
- Device lifecycle and revocation.
- Pairing.
- Quotas and rate limits.
- Message validation.
- Storage and coordination adapters.
- SDK refusal of `ws://` URLs except for loopback hosts, and no access token in the connection URL (§16).

### Integration tests
- Unknown application rejection.
- Suspended application rejection.
- Revoked application rejection.
- Expired and invalid token rejection.
- Rejection of tokens exceeding the maximum lifetime, or with `iat` in the future beyond the clock-skew tolerance.
- Rejection of protected messages sent before `auth.authenticate` completes.
- Wrong issuer and audience rejection.
- `app_id` claim and issuer mismatch rejection.
- Replayed `jti` rejection.
- Valid application-issued token acceptance.
- Credential renewal with `auth.refresh` without reconnecting.
- `auth.refresh` rejection when the new token's `app_id`, `sub`, or `device_id` differs from the connection's.
- Token expiry on an open connection without `auth.refresh`, according to the token profile.
- Duplicate connection handling according to the selected policy, including two tabs sharing one device identity without a reconnect loop.
- Two clients connecting to one local server.
- Device discovery.
- The same `sub` in two applications sharing no identity, devices, or namespaces (§6.1).
- Session creation and acceptance.
- `session.create` rejection when the target device is not authorized in the session's namespace.
- SDP and ICE signaling.
- `rtc.*` message rejection outside an accepted session or between non-participants.
- `rtc.ice_config` delivery after authentication, with and without TURN configured.
- DataChannel communication.
- Disconnect and reconnect.
- Expired presence cleanup.
- Application suspension and revocation during active connections, with the SDK closing its sessions when reauthentication is rejected.
- Device revocation closing the revoked device's connections and notifying remaining peers with `session.terminated`.
- Control-plane operations rejecting application-issued access tokens (§5.6).
- Reactivation refused for a revoked application.

### Connectivity tests
- Same-network direct connection.
- Different-network connection using STUN.
- TURN relay when configured.
- TURN unavailable.
- ICE failure and recovery.
- Network interruption and reconnection.

### Abuse tests
- Excessive connection attempts.
- WebSocket upgrades with a disallowed `Origin` rejected.
- Tokens with unknown `kid` values not triggering unbounded JWKS fetches.
- Client IP derived from forwarding headers only for trusted proxies; forged headers from untrusted peers ignored.
- Connections that never authenticate are closed at the authentication deadline.
- Unauthenticated connection cap enforcement.
- Rate-limit enforcement.
- Quota enforcement.
- Oversized signaling messages.
- Messages sent in a direction their type does not allow, such as a client-sent `rtc.ice_config` or `session.request`.
- Excessive session creation.
- Unauthorized namespace enumeration attempts.

## 22. Definition of done

This list is the canonical MVP definition. `docs/roadmap.md` maps each item to the phase that delivers it.

The MVP is complete when:

- A local server runs without external infrastructure dependencies.
- Only registered applications with valid trusted tokens are accepted.
- Browser clients obtain tokens through their application backend.
- No application secret is embedded in frontend code.
- Invalid, expired, unknown, suspended, or revoked application credentials are rejected, and suspending or revoking an application closes its active WebSocket connections.
- Basic application and device quotas and rate limits are enforced.
- Authorized devices can discover each other.
- WebRTC DataChannels exchange application-defined payloads.
- STUN-based direct connectivity works in supported network conditions.
- The SDK supports TURN configuration without requiring a deployed TURN service.
- The SDK reports direct versus relay connection type when available.
- Reconnection and session cleanup are tested.
- Namespace authorization and device revocation are enforced, and remaining peers are notified on revocation, within the limits of §6.4.
- Device identity follows the enrollment decision required by §6.2 and recorded in a decision record (`docs/adr/`).
- No application payload is stored or processed by the signaling server.
- The server can be containerized and configured through environment variables, with a Docker Compose development workflow.
- Cross-network connectivity has been validated through a development tunnel.
