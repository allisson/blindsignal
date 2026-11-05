# AGENTS.md

Guidance for AI coding agents working in this repository.

## Project

BlindSignal is an application-agnostic, access-controlled P2P connectivity infrastructure. Registered
applications use it to authenticate devices, discover authorized peers, and signal WebRTC sessions
over WebSocket. Application payloads travel only through WebRTC DataChannels, never through the
server. Initial target: browser / PWA.

## Sources of truth

- `docs/spec.md`: technical specification. §22 is the canonical MVP definition.
- `docs/roadmap.md`: phased plan; maps every MVP item to the phase that delivers it.
- `docs/adr/`: architecture decision records.
- `GLOSSARY.md`: canonical domain terms; use them in code, docs, and messages.
- `docs/README.md`: an index of every document, by audience.
- `CONTRIBUTING.md`: setup, commands, checks, and the commit and pull request conventions.
- `docs/protocol.md`, `docs/threat-model.md`: Phase 0 deliverables.
- `docs/onboarding.md`: an application team's path from registration to production.
- `docs/token-issuance.md`: what an application backend must do to issue accepted tokens.
- `docs/external-testing.md`: the Compose workflow and the cross-network test setup (Phase 7).
- `docs/turn-operations.md`: running Coturn for BlindSignal (Phase 8).
- `docs/deployment.md`: choosing a topology, what every production deployment needs, and upgrading.
- `docs/supabase.md`: Supabase as the PostgreSQL provider (Phase 9).
- `docs/self-hosted.md`: one-host deployment with Compose and Caddy (Phase 10).
- `docs/application-lifecycle.md`: registering, suspending, and revoking applications and devices.
- `docs/secrets-and-keys.md`: every secret, its rotation, and what to do after a compromise.
- `docs/backup-and-recovery.md`: what to back up, and restoring PostgreSQL.
- `docs/vps.md`: one VPS behind a firewall, with Coturn on the same host.
- `docs/cloud-run.md`: Cloud Run, with the registry in Secret Manager (untested on Cloud Run).
- `docs/tailscale.md`: a laptop and devices on one tailnet, pairing in `examples/minimal-app`.
- `docs/application-e2ee.md`: what BlindSignal protects in a payload, and what E2EE leaves to applications.
- `docs/integration-feedback.md`: what the Phase 11 examples taught, fixed, documented, and open.
- `docs/security-review.md`: each security review's findings and their state; `SECURITY.md`, how to report one.
- `docs/load-report.md`: each load test run against the server defaults (ADR 0049).
- `packages/sdk/CHANGELOG.md`, `apps/server/CHANGELOG.md`: each release of the SDK and the server.

Read the relevant spec sections before changing behavior. When code and spec disagree, stop and
raise it; do not silently diverge. A change that alters a documented contract updates the spec,
the roadmap, or an ADR in the same change.

## Current status

Every phase of `docs/roadmap.md` is complete: the MVP of spec §22 (Phases 0 to 7), TURN support,
persistence and distributed coordination, production readiness, the reference integrations, the
stable release, with `0.1.0` of the SDK, the protocol, and the server published (ADR 0050), and the
documentation (Phase 13). The roadmap lists each phase's tasks and the ADR behind each decision;
`docs/README.md` indexes the documents.

The workspace uses the toolchain in `docs/adr/0001-typescript-node-toolchain.md`
(TypeScript on Node.js LTS, pnpm workspaces, Zod 4, `jose`, `ws`, Vitest, Playwright), extended
for Phase 9 by `docs/adr/0019-persistence-dependencies.md` (`pg`, `redis`, Valkey) and for Phase 10
by `docs/adr/0038-opentelemetry-metrics.md` (the OpenTelemetry metrics SDK and its exporters). Do
not add a tool outside those ADRs without a new ADR.

TypeScript stays on 6.0.x until `typescript-eslint` supports 7: type-aware linting is required.

## Decisions that block implementation

The spec requires these to be decided, and recorded in `docs/adr/`, before the code that depends
on them is written. Never assume an answer:

- Control-plane mechanism: config file, CLI, or admin API (§5.6). Decided:
  `docs/adr/0005-control-plane.md`.
- Device enrollment, and whether the MVP requires device-key proof-of-possession (§6.2). Decided:
  `docs/adr/0006-token-profile-and-device-identity.md`.
- Namespace authorization source: token claims, stored policy, or both (§7.3). Decided:
  `docs/adr/0007-namespace-authorization.md`.
- Duplicate-connection policy, together with the per-device connection limit (§13, §8.1),
  accounting for several browser tabs sharing one device identity. Decided:
  `docs/adr/0008-duplicate-connections.md`.
- `jti` replay policy and the full token profile (§5.3), including the maximum token lifetime,
  clock-skew tolerance, and what happens when a connection's token expires without `auth.refresh`.
  Decided: `docs/adr/0006-token-profile-and-device-identity.md`.
- When `rtc.ice_config` is sent beyond post-authentication (§11). Decided:
  `docs/adr/0009-ice-configuration.md`.
- Pairing protocol (§7.4, post-MVP). Never invent custom cryptography. Decided:
  `docs/adr/0042-pairing.md`.

## Non-negotiable invariants

Treat a violation of any of these as a bug, regardless of the task:

- The server never inspects, persists, or relays application payloads. The protocol has no payload
  messages.
- No application secret, private signing key, or permanent TURN credential in browser/SDK code.
- `app_id`, namespace IDs, session IDs, and device IDs are identifiers, never credentials.
- A client-supplied `app_id` is trusted only after validating the token against the registry. Each
  trusted issuer maps to exactly one application; `app_id` claim mismatch is rejected.
- JWT validation: explicit algorithm allowlist, asymmetric keys, `kid`, and checks of `iss`, `aud`,
  `exp`, `iat`, required claims, and `nbf` when present. Enforce a maximum token lifetime and
  rate-limit JWKS refetch on unknown `kid`. Reject unknown, suspended, or revoked apps.
- `auth.refresh` keeps the connection's `app_id`, `sub`, and `device_id`; a mismatch is rejected.
- Authorization is server-side, per protected message, and deny by default.
- `rtc.*` messages are relayed only between participants of a session the target accepted.
- TURN URLs and credentials reach the SDK only through `rtc.ice_config`. The SDK's `iceServers`
  accepts STUN only.
- Access tokens go only in the auth message after the socket opens, never in the URL.
- The SDK refuses `ws://` except for loopback hosts.
- CORS and `Origin` checks are defense in depth, never authentication.
- Forwarding headers (`X-Forwarded-For`, `CF-Connecting-IP`) are honored only from configured
  trusted proxies.
- Never log or emit in telemetry: tokens, secrets, credentials, or application payloads.
- Error responses use consistent codes and leak no internal details.

## Architecture conventions

- Storage and coordination live behind `StorageAdapter` and `CoordinationAdapter` (§10). Business
  logic never imports a provider (PostgreSQL, Redis, Supabase, Cloud Run) directly.
- In-memory adapters must always exist and work: local development and tests run with no external
  infrastructure. Never present them as safe for multi-instance use.
- Configuration is environment-driven. Development issuers and test keys stay isolated from
  production trust configuration.
- Resource limits (message size, rates, quotas, timeouts) are configurable, never hardcoded
  constants.
- Repository layout follows spec §19 (`apps/server`, `packages/{sdk,protocol,core,dev-issuer}`,
  `adapters/{storage,coordination}/*`) unless an ADR changes it.
- Package dependencies follow `docs/adr/0002-package-boundaries.md`: the SDK imports only
  `protocol`; adapters import only `core`; nothing imports `apps/server`. In `apps/server/src`, only
  `main.ts` imports adapters, and nothing imports `dev-issuer` (tests may import both).

## Protocol naming

- Message types: dot-separated, lowercase, snake_case segments (`rtc.ice_candidate`).
- Envelope fields and payload keys: camelCase (`requestId`).
- JWT claims keep registered snake_case names (`app_id`, `device_id`).
- Every message carries `version`, `type`, `payload`, and `requestId` where applicable. Server and
  SDK consume the same schemas from the shared protocol package.

## Setup, commands, tests, and conventions

[`CONTRIBUTING.md`](CONTRIBUTING.md) has the setup, every command, the checks CI runs on a pull
request, the testing rules and coverage floors, and the language, commit, and pull request
conventions. Follow it; it applies to agents as it does to people.
