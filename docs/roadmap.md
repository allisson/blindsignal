# BlindSignal — Development Roadmap

**Status:** Draft  
**Reference:** `docs/spec.md`

This roadmap prioritizes a secure, working local P2P system before introducing managed infrastructure or distributed deployment complexity.

## Guiding principles

1. Register and authorize applications before allowing infrastructure access.
2. Never distribute application secrets to browser or PWA clients.
3. Separate application access, user authentication, device identity, and operation authorization.
4. Build a functional local system before deploying cloud infrastructure.
5. Keep storage and coordination behind adapters.
6. Do not require PostgreSQL, Redis, Supabase, or TURN for the first local MVP.
7. Implement ICE/STUN connectivity first and support TURN configuration.
8. Validate connectivity across different networks before investing in production relay infrastructure.
9. Keep the server portable and provider-independent.
10. Treat security and abuse prevention as core features.

---

## Phase 0 — Architecture and technical planning

**Goal:** Validate the architecture and define implementation contracts before coding.

### Tasks

- [x] Inspect repository conventions and existing code (repository contains only docs, AGENTS.md, README, LICENSE, and a Node.js `.gitignore` template; the spec's illustrative interfaces use TypeScript).
- [x] Choose language, runtime, package and monorepo tooling, schema-validation library, and test frameworks, including browser automation for DataChannel tests (`docs/adr/0001-typescript-node-toolchain.md`).
- [x] Define server, SDK, and shared protocol boundaries (`docs/adr/0002-package-boundaries.md`).
- [x] Define signaling protocol and versioning (`docs/protocol.md`).
- [x] Define application registration and trust model (spec §5.1, `docs/adr/0005-control-plane.md`, `docs/adr/0006-token-profile-and-device-identity.md`).
- [x] Define application issuer and JWKS configuration, including HTTPS-only JWKS URIs, fetch timeouts, and rate-limited refetch on an unknown `kid` (spec §5.3).
- [x] Define JWT claims and validation requirements (`docs/adr/0006-token-profile-and-device-identity.md`).
- [x] Define the issuer-to-application mapping, the `app_id` claim rule, the `jti` replay policy, the maximum token lifetime, and the clock-skew tolerance (`docs/adr/0006-token-profile-and-device-identity.md`).
- [x] Define application suspension and revocation behavior (spec §5.5, `docs/adr/0005-control-plane.md`, `docs/protocol.md`; cross-instance propagation in Phase 9).
- [x] Define revocation enforcement limits for established P2P sessions (spec §6.4, `docs/threat-model.md`).
- [x] Define the control-plane mechanism for application registration, suspension, revocation, and device revocation (spec §5.6) (`docs/adr/0005-control-plane.md`).
- [x] Define user and device identity (`docs/adr/0006-token-profile-and-device-identity.md`).
- [x] Decide whether MVP enrollment includes device-key proof-of-possession or relies only on the backend-asserted `device_id` claim (spec §6.2), and whether device records are created on first sight, which places the per-application device-count quota in the MVP (Phase 6) (backend-asserted, created on first authentication: `docs/adr/0006-token-profile-and-device-identity.md`).
- [x] Design and review the device enrollment protocol (enrollment is the first successful authentication, `docs/adr/0006-token-profile-and-device-identity.md`). *(Proof-of-possession design is post-MVP and must be done before Phase 5 implements it.)*
- [x] Define namespace and authorization semantics (`docs/adr/0007-namespace-authorization.md`).
- [x] Decide the namespace authorization source for the MVP: token claims, stored policy, or both (spec §7.3) (token claims, `docs/adr/0007-namespace-authorization.md`).
- [x] Decide session cardinality: one-to-one only or multi-party (spec §13) (`docs/adr/0003-one-to-one-sessions.md`).
- [x] Decide the duplicate-connection policy for a device that connects again while already connected, together with the per-device concurrent connection limit, accounting for several browser tabs sharing one device identity (spec §13, §8.1, §8.3) (the newer replaces the older, `docs/adr/0008-duplicate-connections.md`).
- [ ] Define pairing policy. *(Post-MVP: required before Phase 5 implements pairing; does not block the MVP.)*
- [x] Define `StorageAdapter` (`docs/adr/0010-adapter-interfaces.md`).
- [x] Define `CoordinationAdapter` (`docs/adr/0010-adapter-interfaces.md`).
- [x] Define application and device quotas (`docs/adr/0011-quotas-and-rate-limits.md`).
- [x] Define rate-limit categories and error responses, including pre-authentication limits keyed by source IP and client IP derivation from trusted proxies (spec §8.1) (`docs/adr/0011-quotas-and-rate-limits.md`).
- [x] Define ICE configuration and direct/relay reporting: STUN from client configuration, TURN only through `rtc.ice_config`, and when the server sends `rtc.ice_config` beyond the post-authentication message (spec §11, §12.3) (`docs/adr/0009-ice-configuration.md`).
- [x] Decide whether `rtc.ice_restart` remains a separate message type or ICE restart is a new `rtc.offer` (spec §11) (a new `rtc.offer`, `docs/protocol.md`).
- [x] Define WebSocket reconnect and token renewal behavior (`docs/protocol.md`, "SDK connection behavior").
- [x] Decide what happens when a connection's token reaches `exp` without a successful `auth.refresh` (spec §5.3) (closed with `token_expired`, `docs/adr/0006-token-profile-and-device-identity.md`).
- [x] Define security and threat-model assumptions (`docs/threat-model.md`).

### Deliverables

- Architecture decision records in `docs/adr/`.
- Protocol draft (`docs/protocol.md`).
- Application registration model.
- Token profile.
- Initial data model.
- Adapter interfaces.
- Threat model (`docs/threat-model.md`).
- Abuse-prevention strategy.
- Test strategy.

### Acceptance criteria

The design and decision records specify that:

- Application access and user authentication are separate.
- Browser clients require no permanent application secret.
- Unknown, suspended, and revoked applications are rejected.
- Authorization is server-side and deny-by-default.
- No cloud provider or infrastructure service is mandatory for local development.

Every decision the spec requires before implementation (listed in `AGENTS.md`, "Decisions that block implementation") is recorded in an ADR, except the tasks marked post-MVP.

---

## Phase 1 — Shared foundation and protocol

**Goal:** Establish the contracts shared by server and SDK.

### Tasks

- [x] Create the `protocol` package and the server-side `core` package (domain types and adapter interfaces).
- [x] Implement versioned signaling message schemas (`packages/protocol`).
- [x] Define message validation (`docs/protocol.md` §1).
- [x] Define standard error codes, marking each authentication and connection-closure error as retryable, terminal, or superseded (spec §8.3, `docs/protocol.md` §9).
- [x] Define request correlation (`docs/protocol.md` §3).
- [x] Define the allowed direction of every message type and reject messages sent in the wrong direction (spec §11, `docs/protocol.md` §4).
- [x] Define message size limits (`docs/protocol.md` §1).
- [x] Define protocol compatibility rules (`docs/protocol.md` §2).
- [x] Define authentication handshake (`docs/protocol.md` §5, §9).
- [x] Define application and device context representation (`packages/core`).
- [x] Add unit tests for schemas and validation.
- [x] Define test coverage floors and enforce them in CI (`AGENTS.md`, "Testing").

### Deliverables

- Shared protocol package.
- Message schemas.
- Protocol documentation.
- Validation tests.

### Acceptance criteria

- Server and SDK consume the same protocol definitions.
- Invalid messages are rejected.
- Protocol version incompatibility is handled explicitly.
- Authentication errors do not reveal sensitive internal details.

---

## Phase 2 — Application access control and authentication foundation

**Goal:** Ensure only registered applications with valid credentials can consume BlindSignal.

### Tasks

- [x] Implement application registry, backed by the in-memory application repository.
- [x] Implement the in-memory coordination adapter with the state this phase needs (`jti` replay tracking); Phase 3 extends it.
- [x] Define application status: active, suspended, revoked.
- [x] Implement trusted issuer configuration.
- [x] Implement trusted JWKS or public-key configuration.
- [x] Implement JWT signature verification.
- [x] Enforce algorithm allowlisting.
- [x] Validate `iss`, `aud`, `exp`, `iat`, `sub`, `app_id`, `device_id`, `jti`, and `namespaces`, and `nbf` when present.
- [x] Enforce the maximum token lifetime and the clock-skew tolerance (spec §5.3).
- [x] Validate `kid` and support signing-key rotation, with HTTPS-only JWKS fetches, timeouts, and rate-limited refetch on an unknown `kid` (spec §5.3).
- [x] Reject unknown, suspended, and revoked applications.
- [x] Implement in-memory `jti` replay protection per the token profile (spec §5.3).
- [x] Reject expired tokens at authentication; enforcement on open connections lands in Phase 3.
- [x] Implement application-scoped authentication context.
- [x] Document backend token issuance requirements (`docs/token-issuance.md`).
- [x] Implement a development token issuer for tests and examples, with test keys isolated from production trust configuration.
- [ ] Ensure no application secret is required or embedded in browser code.
- [x] Add tests for invalid, expired, unknown, suspended, and revoked credentials, wrong issuer or audience, `app_id` claim and issuer mismatch, replayed `jti`, excessive token lifetime, future `iat`, and unknown-`kid` refetch limits.

### Deliverables

- Application registry.
- Token verification module.
- Development token issuer.
- Trust configuration.
- Authentication documentation.
- Security-focused test suite.

### Acceptance criteria

- Unknown applications cannot authenticate.
- Suspended and revoked applications cannot establish new connections.
- Tokens with invalid signatures, issuers, audiences, or expiration are rejected.
- Tokens whose `app_id` claim does not match the application registered for the issuer are rejected.
- Replayed `jti` values are rejected according to the token profile.
- The server trusts only explicitly configured issuers and keys.
- A public `app_id` alone never grants access.

---

## Phase 3 — Local signaling server MVP

**Goal:** Implement signaling and lifecycle management with no external infrastructure dependency.

### Tasks

- [x] Implement WebSocket server.
- [x] Check `Origin` at the WebSocket upgrade against a configured allowlist, as defense in depth (spec §16).
- [x] Integrate application authentication, rejecting protected messages sent before authentication completes.
- [x] Create device records on first successful authentication, keyed by `(app_id, sub, device_id)`, and expire them after a configurable inactivity period (`docs/adr/0006-token-profile-and-device-identity.md`, `docs/adr/0010-adapter-interfaces.md`).
- [x] Implement in-memory device repository.
- [x] Authorize namespaces from the token's `namespaces` claim, and apply namespace removals on `auth.refresh` (`docs/adr/0007-namespace-authorization.md`).
- [x] Implement `namespace.join` and `namespace.leave`, admitting a device only to namespaces it is authorized in (spec §7.3, §13).
- [x] Implement in-memory presence management.
- [x] Extend the Phase 2 in-memory coordination adapter with presence leases, signaling event delivery, and TTL-based cleanup.
- [x] Implement device discovery.
- [x] Implement session creation and lifecycle, with each session scoped to one namespace in which both devices are authorized (spec §13).
- [x] Implement SDP offer/answer signaling, including ICE restart as a new `rtc.offer`.
- [x] Implement ICE candidate exchange.
- [x] Relay `rtc.*` messages only between participants of an accepted session (spec §13).
- [x] Send `rtc.ice_config` after every successful authentication and `auth.refresh`, even when no TURN server is configured (spec §11, `docs/adr/0009-ice-configuration.md`).
- [x] Implement heartbeat and disconnect detection.
- [x] Implement stale presence cleanup.
- [x] Implement application suspension and revocation handling: reject new authentication and close the application's active WebSocket connections (spec §5.5).
- [x] Implement the duplicate-connection policy: an authenticated newer connection replaces the device's older one, closed with `superseded` (`docs/adr/0008-duplicate-connections.md`).
- [x] Implement the control plane for application registration, update, suspension, reactivation, and revocation, using the mechanism chosen in Phase 0 (spec §5.6).
- [x] Add health and readiness endpoints.
- [x] Add structured logs and basic metrics.
- [x] Implement `auth.refresh` handling for credential renewal without reconnecting, rejecting tokens whose `app_id`, `sub`, or `device_id` differs from the connection's (spec §5.3).
- [x] Enforce token expiry on open connections: a connection whose token reaches `exp` without a successful `auth.refresh` is handled per the Phase 0 decision (spec §5.3).
- [x] Implement environment-driven configuration.
- [x] Implement client IP derivation from configured trusted proxies, ignoring forwarding headers from untrusted peers (spec §8.1).
- [x] Add Dockerfile and Docker Compose development workflow.

### Deliverables

- Runnable local signaling server.
- Docker Compose development setup.
- In-memory storage and coordination adapters.
- WebSocket protocol implementation.
- Integration tests with multiple clients.

### Acceptance criteria

- Valid application tokens are required.
- Two or more authorized clients can connect.
- Authorized devices can discover each other.
- Session signaling works, and `rtc.*` messages outside an accepted session are rejected.
- Disconnects update presence.
- Suspended and revoked applications lose their active WebSocket connections.
- No application payload is accepted or persisted by the server.
- The server runs without PostgreSQL or Redis.

---

## Phase 4 — Browser SDK and local WebRTC

**Goal:** Establish a working P2P DataChannel between browser clients.

### Tasks

- [x] Implement SDK WebSocket client, refusing `ws://` URLs except for loopback hosts and never placing the access token in the connection URL (spec §16).
- [x] Implement access-token provider interface.
- [x] Implement token refresh through the access-token provider and `auth.refresh`.
- [x] Implement authentication flow.
- [x] Implement namespace join and presence.
- [x] Implement discovery API.
- [x] Implement session API.
- [x] Implement RTCPeerConnection lifecycle.
- [x] Implement SDP negotiation.
- [x] Implement ICE candidate exchange.
- [x] Add a configurable STUN server list, and merge TURN servers and temporary credentials received through `rtc.ice_config`, without requiring a deployed TURN service (spec §12.3).
- [x] Implement ICE restart on connection failure (spec §12.1).
- [x] Implement DataChannel creation and lifecycle.
- [x] Expose connection state.
- [x] Expose direct/relay/unknown connection type.
- [x] Implement heartbeats and dead-connection detection with `connection.ping` and `connection.pong` (spec §15).
- [x] Implement reconnect with exponential backoff and jitter, stopping on terminal authentication errors and not reconnecting automatically when superseded (spec §8.3).
- [x] After reconnecting, rejoin namespaces and treat every server-side session as ended (spec §15, `docs/adr/0004-sessions-bound-to-connections.md`).
- [x] Implement session cleanup and error handling, closing all sessions when reauthentication is rejected because the application is suspended or revoked or the device is revoked (spec §6.4).
- [x] Add browser integration tests.

### Deliverables

- Browser SDK.
- Local browser-to-browser P2P demonstration.
- DataChannel integration tests.

### Acceptance criteria

- Browser clients obtain tokens from their own application backend.
- The SDK contains no permanent application secret.
- Two browser clients can establish a DataChannel.
- Applications can exchange arbitrary application-defined payloads.
- The signaling server does not receive DataChannel payloads.
- Connection state and diagnostics are exposed.

---

## Phase 5 — Authorization, pairing, and security hardening

**Goal:** Establish trustworthy device identity and resource authorization.

**MVP subset:** the tasks marked *(MVP)*: namespace authorization, device revocation (including the control-plane operation), propagating device revocation to the revoked device's active connections and sessions, and notifying remaining peers on revocation (spec §6.4). Pairing, session authorization, and the remaining tasks are post-MVP. Application suspension and revocation are handled in Phase 3 and propagated across instances in Phase 9. Until session authorization lands, any device authorized in a namespace may request a session with any other device in that namespace; the target device still accepts or rejects (spec §13).

### Tasks

- [ ] Design, review, and implement device proof-of-possession (`docs/adr/0006-token-profile-and-device-identity.md`).
- [x] Finalize namespace authorization. *(MVP)*
- [ ] Implement session authorization.
- [ ] Design and review pairing protocol.
- [ ] Implement pairing approval policy.
- [x] Implement device revocation, including the control-plane operation (spec §5.6). *(MVP)*
- [x] Propagate device revocation to the revoked device's active connections and sessions. *(MVP)*
- [x] Notify remaining peers on revocation with `session.terminated` so the SDK closes established sessions (spec §6.4). *(MVP)*
- [ ] Implement pairing attempt rate limits (spec §8.1).
- [x] Add signaling message validation and abuse protection.
- [x] Review token and credential handling.
- [x] Define metadata retention.
- [x] Perform threat-model review.
- [x] Add security-focused tests.

### Deliverables

- Documented identity and pairing model.
- Authorization implementation.
- Revocation implementation.
- Security test suite.

### Acceptance criteria

- Unauthorized devices cannot discover or join protected sessions.
- Revoked devices lose signaling access (and TURN credentials, once Phase 8 issues them), and remaining peers are notified to close established sessions (spec §6.4).
- Namespace boundaries are enforced server-side.
- Pairing does not rely on custom, unreviewed cryptography.

---

## Phase 6 — Abuse prevention and resource protection

**Goal:** Prevent individual applications or devices from exhausting shared infrastructure resources.

**MVP subset:** the tasks marked *(MVP)*: basic per-application and per-device connection and concurrent-session limits, pre-authentication limits (authentication deadline and unauthenticated connection cap), connection-attempt, authentication, discovery, session-creation and signaling rate limits, maximum message size, and negotiation timeouts. Usage metrics, bounded queues, abuse alerts, and the session-duration quota are post-MVP. The device-count quota is part of the MVP, since device records are created on first authentication.

### Tasks

- [x] Define configurable application quotas. *(MVP)*
- [x] Implement concurrent connection limits per application. *(MVP)*
- [x] Implement WebSocket connection attempt rate limits, keyed by source IP (spec §8.1). *(MVP)*
- [x] Implement the authentication deadline for connections that do not authenticate (spec §8.4). *(MVP)*
- [x] Implement the unauthenticated connection cap, per source IP and global (spec §8.4). *(MVP)*
- [x] Implement session creation limits. *(MVP)*
- [x] Implement signaling message rate limits. *(MVP)*
- [x] Implement discovery rate limits. *(MVP)*
- [x] Implement authentication attempt limits. *(MVP)*
- [x] Implement maximum WebSocket message sizes. *(MVP)*
- [x] Implement session and negotiation timeouts. *(MVP)*
- [x] Implement maximum concurrent sessions per application and per device (spec §8.2). *(MVP)*
- [x] Implement maximum registered devices per application (spec §8.2). *(MVP)*
- [x] Implement maximum joined namespaces per device (`docs/adr/0011-quotas-and-rate-limits.md`). *(MVP)*
- [x] Implement maximum session duration, where configured (spec §8.2) (`docs/adr/0014-maximum-session-duration.md`).
- [x] Implement bounded queues and backpressure (`docs/adr/0013-bounded-queues-and-backpressure.md`).
- [x] Implement abuse alerts (spec §8.3), with suspension left to the operator through the Phase 3 suspension handling (`docs/adr/0016-abuse-alerts.md`).
- [x] Implement per-application usage metrics (`docs/adr/0015-application-usage-metrics.md`).
- [x] Add abuse and quota enforcement tests. *(MVP, for the MVP limits)*

### Deliverables

- Configurable quota system.
- Rate-limiting middleware.
- Usage metrics.
- Abuse-prevention documentation.

### Acceptance criteria

- One application cannot exceed its configured resource allocation.
- One device cannot exhaust its application's quota.
- Excessive signaling and session creation are rejected.
- Limits are configurable without code changes.
- Rate-limit responses are consistent and documented.

---

## Phase 7 — External network testing

**Goal:** Validate the architecture across separate networks before adding production infrastructure.

### Tasks

- [x] Document local Docker Compose workflow.
- [x] Expose the local signaling server using Cloudflare Quick Tunnel.
- [x] Test WebSocket connections through the tunnel.
- [x] Verify that pre-authentication limits see each client's IP through the tunnel, with the tunnel configured as a trusted proxy (spec §8.1).
- [x] Connect authorized browser clients from separate networks.
- [x] Validate STUN-based ICE negotiation.
- [x] Test same-network and different-network scenarios.
- [x] Test reconnect after WebSocket interruption.
- [x] Test reconnect after network changes.
- [x] Capture ICE diagnostics.
- [x] Verify direct and unknown connection-type reporting (relay reporting is verified in Phase 8).
- [x] Document known connectivity limitations.

### Deliverables

- External testing guide.
- Reproducible cross-network test scenario.
- Connectivity test report.

### Acceptance criteria

- Clients on separate networks can connect to the local signaling server through the tunnel.
- Only clients with valid application-issued tokens can authenticate.
- WebRTC DataChannel can establish a direct connection in supported network conditions.
- The team can identify whether a connection is direct.

Cloudflare Quick Tunnel is a development ingress mechanism, not a WebRTC transport or TURN relay.

---

## Phase 8 — TURN support and connectivity reliability

**Goal:** Support restrictive networks without making TURN mandatory for every deployment.

### Tasks

- [ ] Finalize ICE configuration API.
- [ ] Validate the Phase 4 `rtc.ice_config` TURN handling against a real TURN service.
- [ ] Implement authenticated temporary TURN credential issuance.
- [ ] Ensure credentials are short-lived and scoped appropriately.
- [ ] Never embed permanent TURN credentials in client code.
- [ ] Deploy a test Coturn instance or use a managed TURN provider.
- [ ] Test TURN relay connectivity.
- [ ] Test configured UDP and TCP/TLS transports.
- [ ] Test direct-to-relay fallback behavior.
- [ ] Test TURN unavailable and credential expiration.
- [ ] Add relay usage metrics.
- [ ] Document TURN operational requirements.

### Deliverables

- TURN-compatible SDK and signaling configuration.
- Temporary credential mechanism.
- Relay connectivity test suite.
- TURN deployment guide.

### Acceptance criteria

- SDK establishes a relay connection when direct connectivity fails and TURN is configured.
- SDK reports relay connectivity.
- TURN credentials are not permanent or embedded in client code.
- Deployments without TURN continue to work where direct connectivity is possible.

Operating TURN is not required to complete the initial local MVP.

---

## Phase 9 — Persistence and distributed coordination

**Goal:** Support multi-instance deployments and durable application/device metadata.

### Tasks

- [ ] Finalize `StorageAdapter`.
- [ ] Implement PostgreSQL adapter.
- [ ] Validate migrations and schema.
- [ ] Evaluate Supabase as an optional managed PostgreSQL provider.
- [ ] Finalize `CoordinationAdapter`.
- [ ] Implement Redis-compatible coordination.
- [ ] Implement TTL-based presence leases.
- [ ] Implement ownership and lease renewal.
- [ ] Implement cross-instance signaling event propagation.
- [ ] Implement cross-instance application suspension and revocation propagation, building on the Phase 3 single-instance handling.
- [ ] Implement shared rate-limit, quota, and `jti` replay state across instances.
- [ ] Handle instance failure and stale leases.
- [ ] Test multiple server instances.
- [ ] Test reconnect and session recovery across instances.

### Deliverables

- PostgreSQL adapter.
- Redis-compatible coordination adapter.
- Multi-instance integration tests.
- Database migration strategy.

### Acceptance criteria

- Business logic does not depend on Supabase-specific APIs.
- Application registry and revocation state are durable.
- Multiple server instances coordinate presence and signaling.
- Rate limits, quotas, and `jti` replay protection hold across instances.
- Presence expires correctly after instance failure.
- In-memory adapters remain available for development and tests.

---

## Phase 10 — Production readiness and deployment

**Goal:** Make BlindSignal deployable in managed and self-hosted environments.

### Tasks

- [ ] Finalize production Docker image.
- [ ] Extend the Phase 3 Docker Compose setup for self-hosted deployment.
- [ ] Implement production health and readiness checks.
- [ ] Configure graceful shutdown.
- [ ] Define WebSocket connection limits.
- [ ] Define reconnect behavior for hosting request timeouts.
- [ ] Add OpenTelemetry instrumentation.
- [ ] Extend the Phase 3 structured logs and metrics for production use.
- [ ] Define secret and signing-key management.
- [ ] Document application registration and onboarding.
- [ ] Document key rotation and application revocation.
- [ ] Document Cloud Run deployment.
- [ ] Document VPS deployment.
- [ ] Document self-hosted deployment.
- [ ] Document optional TURN deployment.
- [ ] Define backup and recovery for durable metadata.

### Deliverables

- Production Docker image.
- Deployment documentation.
- Application onboarding documentation.
- Observability baseline.
- Operational runbook.

### Acceptance criteria

- Same application image runs in managed and self-hosted environments.
- Application trust configuration is externalized and protected.
- WebSocket reconnect handles hosting limits.
- Health and readiness checks are meaningful.
- Provider-specific code is isolated from core business logic.

---

## Phase 11 — Reference integrations

**Goal:** Validate BlindSignal through real consuming applications.

### Tasks

- [ ] Build a minimal SDK example.
- [ ] Integrate with BlindNotes.
- [ ] Integrate with BlindVault.
- [ ] Evaluate integration with BlindChat.
- [ ] Implement backend token issuance examples, building on the Phase 2 development issuer.
- [ ] Document trusted issuer and JWKS setup.
- [ ] Document application-level E2EE responsibilities.
- [ ] Validate namespace isolation between applications.
- [ ] Validate independent application protocols.
- [ ] Gather integration feedback.

### Deliverables

- Reference application.
- Backend token issuance examples.
- Integration guides.
- SDK documentation.
- Compatibility tests.

### Acceptance criteria

- Multiple registered applications can use the same BlindSignal infrastructure.
- Applications are isolated by identity and namespace authorization.
- Browser applications do not require embedded secrets.
- BlindSignal does not need application-specific payload logic.

---

## Phase 12 — Stable release

**Goal:** Prepare a stable, documented release.

### Tasks

- [ ] Review public API stability.
- [ ] Review protocol compatibility.
- [ ] Complete security review.
- [ ] Complete abuse-resistance review.
- [ ] Complete performance and load tests.
- [ ] Complete browser compatibility tests.
- [ ] Publish SDK documentation.
- [ ] Publish application onboarding documentation.
- [ ] Publish deployment documentation.
- [ ] Define semantic versioning.
- [ ] Define support and upgrade policy.

### Deliverables

- Stable server release.
- Stable browser SDK.
- Protocol documentation.
- Application onboarding guide.
- Deployment and operations guides.

### Acceptance criteria

- Security and abuse-resistance reviews have no open blocking findings.
- Load tests validate the configured quota and rate-limit defaults.
- Protocol and SDK versions follow the defined semantic versioning and compatibility rules.
- Supported browsers are documented and covered by compatibility tests.

---

## MVP definition

The canonical MVP criteria are in `docs/spec.md` §22. The capabilities below deliver them:

| # | Capability | Phase |
|---|---|---|
| 1 | Local signaling server | 3 |
| 2 | Application registry with trusted issuer configuration | 2 |
| 3 | Short-lived application-issued JWT authentication and development issuer | 2 |
| 4 | In-memory storage and coordination | 2–3 |
| 5 | Browser SDK with an access-token provider | 4 |
| 6 | Device records created on authentication | 3 |
| 7 | Namespace-scoped discovery and authorization | 3, 5 |
| 8 | Session creation and signaling | 3 |
| 9 | WebRTC DataChannel | 4 |
| 10 | Configurable STUN and TURN servers (no TURN deployment required) | 4 |
| 11 | Automatic WebSocket reconnection | 4 |
| 12 | Basic direct/relay/unknown connection diagnostics | 4 |
| 13 | Basic per-application and per-device quotas and rate limits | 6 (MVP subset) |
| 14 | Device revocation and peer notification, within spec §6.4 limits | 5 (MVP subset) |
| 15 | Docker Compose development workflow | 3 |
| 16 | External network testing through Cloudflare Quick Tunnel | 7 |
| 17 | Application suspension and revocation closing active connections (single instance) | 3 |

Phases 1–4 and 7 are fully part of the MVP. Phase 0 is part of the MVP except the tasks marked post-MVP (pairing policy and proof-of-possession design). Phases 5 and 6 contribute only their MVP subset.

The MVP does not require:
- Supabase.
- PostgreSQL.
- Redis.
- A production TURN deployment.
- Cloud Run.
- Multi-instance operation.
- A public user account system managed by BlindSignal.

These are later capabilities, not prerequisites for validating the core architecture.

## Priority summary

| Priority | Capability |
|---|---|
| P0 | Application registration, trusted JWT validation, development issuer |
| P0 | Protocol, local server, in-memory adapters |
| P0 | Browser SDK and WebRTC DataChannel |
| P0 | ICE/STUN and local connectivity |
| P0 | Basic application/device authorization and device revocation |
| P0 | Basic quotas, rate limits, and resource bounds |
| P0 | Reconnection and external network testing |
| P1 | Pairing and revocation propagation hardening |
| P1 | TURN support and temporary credentials |
| P1 | Full application quotas and usage metrics |
| P2 | PostgreSQL and Redis-compatible adapters |
| P2 | Multi-instance deployment |
| P2 | Production observability and operations |
| P3 | Reference application integrations |
| P3 | Stable release |

## After the MVP

The MVP is complete: every capability in the MVP definition is delivered. The post-MVP tasks of
Phase 6 are done too: bounded queues and backpressure (ADR 0013), the maximum session duration
(ADR 0014), per-application usage metrics (ADR 0015), and abuse alerts with operator-driven
suspension (ADR 0016). Next is Phase 8. The post-MVP tasks
of Phase 5 (proof-of-possession, session authorization, and pairing) each start with an ADR and
are not scheduled yet.
