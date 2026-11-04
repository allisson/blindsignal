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
- `docs/protocol.md`, `docs/threat-model.md`: Phase 0 deliverables.
- `docs/token-issuance.md`: what an application backend must do to issue accepted tokens.
- `docs/external-testing.md`: the Compose workflow and the cross-network test setup (Phase 7).
- `docs/turn-operations.md`: running Coturn for BlindSignal (Phase 8).
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

Read the relevant spec sections before changing behavior. When code and spec disagree, stop and
raise it; do not silently diverge. A change that alters a documented contract updates the spec,
the roadmap, or an ADR in the same change.

## Current status

Phase 4 (browser SDK and local WebRTC) is complete: `packages/sdk` authenticates, reconnects,
discovers devices, and opens a DataChannel per session, and `examples/browser-demo` runs it in
Chromium and Firefox under Playwright, against the Phase 3 signaling server in `apps/server`. The
MVP subsets of Phases 5 and 6 are complete too: namespace authorization from token claims
(ADR 0007), device revocation, and the quotas and rate limits of ADR 0011. Phase 7 is complete:
browsers on separate networks connect through Cloudflare Quick Tunnels (`docs/external-testing.md`,
`docs/connectivity-report.md`), which completes the MVP. The post-MVP tasks of Phase 6 are done:
bounded queues and backpressure (ADR 0013), the maximum session duration (ADR 0014),
per-application usage metrics (ADR 0015), and abuse alerts with operator-driven suspension
(ADR 0016). Phase 8 (TURN support) is complete: the server issues TURN credentials (ADR 0017),
browsers relay through a test Coturn, the SDK closes a session that never connects (ADR 0018), and
`docs/turn-operations.md` documents operating Coturn; see the roadmap's "After the MVP". Phase 9
has started: with `BLINDSIGNAL_DATABASE_URL` set, the server keeps device records and the last
accepted registry in PostgreSQL (`adapters/storage/postgresql`, ADR 0020, ADR 0021), and
with `BLINDSIGNAL_REDIS_URL` set too, instances share coordination through Redis or Valkey
(`adapters/coordination/redis`, ADR 0022, ADR 0023), and a registry reload reaches every
instance (ADR 0024); a session whose peer's instance fails ends once the peer reconnects
(ADR 0026). PostgreSQL works behind a transaction-mode pooler, such as Supabase's, and its tables
hide from every role but their owner (ADR 0027). Phase 10 has started: `/metrics` reports
whether PostgreSQL and Redis answer, while readiness stays independent of them (ADR 0028); a
maximum connection lifetime keeps connections under a hosting platform's request timeout
(ADR 0029), a cap bounds the connections of each instance (ADR 0030), and a shutdown fails
readiness before closing connections and ends within a deadline (ADR 0031); `examples/self-hosted/`
runs it on one host behind Caddy (ADR 0032), and CI runs the production image read-only
before every merge (ADR 0033); `docs/secrets-and-keys.md` and `docs/application-lifecycle.md` are the
operator's procedures (ADR 0034), and `docs/backup-and-recovery.md` the backups (ADR 0035); `docs/vps.md` adds a firewall and
Coturn on the same host (ADR 0036); logs take a level, crashes are logged as JSON, and `/metrics`
reports the process (ADR 0037); metrics go through OpenTelemetry, pushed over OTLP when an endpoint
is set (ADR 0038); `docs/cloud-run.md` configures Cloud Run, not yet tested there (ADR 0039). Of Phase 5's post-MVP
tasks, session authorization is done: the token's `permissions` claim narrows `session.create` and
`session.accept` per namespace (ADR 0040), and proof-of-possession is done: a token bound to a
device key with `cnf.jkt` needs a proof that the SDK's non-extractable `DeviceKey` signs
(ADR 0041); pairing is done: a new device asks its user's present devices with the SDK's
`requestPairing()`, and one approves with a JWT its `DeviceKey` signs, for the backend to grant the
namespace (ADR 0042). Phase 11 has started: `examples/backend-issuer` is an application backend
that issues tokens with its own key and grants pairings, and `examples/minimal-app` is a page on
it whose devices sign in, pair, and open a DataChannel; two applications on shared instances are
isolated from each other, and the browser demo's `notes` and `chat` exchange their own payload
formats; `docs/application-e2ee.md` states what applications must do for end-to-end encryption, and `docs/integration-feedback.md`
what the examples taught about integrating. Phase 12 has started: the SDK and the server follow
semantic versioning, joined by the protocol major (ADR 0043), and a server keeps the previous
protocol major while old SDKs can still run (ADR 0044); clients accept error codes and end
reasons that a later release adds (ADR 0045), and the SDK's public API is reviewed, with
`refresh()` on demand (ADR 0046); the SDK names its supported browsers, and CI runs WebKit too
(ADR 0047); the security review left no blocking finding open, and repeats before every minor
and major release, with Dependabot, pinned actions, and `pnpm audit --prod` in CI (ADR 0048), and
the abuse review left none open either; load tests validate the quota and rate-limit defaults
before every minor and major release (ADR 0049). The workspace uses
the toolchain in `docs/adr/0001-typescript-node-toolchain.md`
(TypeScript on Node.js LTS, pnpm workspaces, Zod 4, `jose`, `ws`, Vitest, Playwright), extended
for Phase 9 by `docs/adr/0019-persistence-dependencies.md` (`pg`, `redis`, Valkey) and for Phase 10
by `docs/adr/0038-opentelemetry-metrics.md` (the OpenTelemetry metrics SDK and its exporters). Do
not add a tool outside those ADRs without a new ADR.

TypeScript stays on 6.0.x until `typescript-eslint` supports 7: type-aware linting is required.

## Commands

Node.js 26 (`.nvmrc`) and pnpm through corepack (`packageManager` in `package.json`).

```sh
pnpm install          # install the workspace
pnpm lint             # ESLint, type-aware, with the ADR 0002 import rules
pnpm typecheck        # tsc --noEmit in every package
pnpm test             # Vitest across all packages
pnpm test:coverage    # Vitest with V8 coverage and the floors below
pnpm test:browser     # Playwright, Chromium, Firefox, and WebKit, against examples/browser-demo and examples/minimal-app
BLINDSIGNAL_TEST_TURN=1 pnpm test:browser  # also the relay tests, with the compose.yaml Coturn (Docker)
BLINDSIGNAL_TEST_POSTGRES_URL=<url> pnpm test  # also the PostgreSQL adapter, with the compose.yaml PostgreSQL (port 6432: through its PgBouncer)
BLINDSIGNAL_TEST_REDIS_URL=<url> pnpm test     # also the Redis adapter and two server instances, with the compose.yaml Valkey
BLINDSIGNAL_DATABASE_URL=<url> pnpm --filter @blindsignal/storage-postgresql migrate  # apply migrations
pnpm format:check     # Prettier (pnpm format to fix)
pnpm build            # tsc in every package
node tests/load/load.ts --smoke  # the load test, small; without --smoke, 10,000 devices (ADR 0049)
```

CI (`.github/workflows/ci.yml`) runs format check, lint, typecheck, and tests with coverage on
every pull request, and the browser tests and the adapters against their services in jobs of
their own.

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

## Testing

- Spec §21 lists the required unit, integration, connectivity, and abuse tests; add the tests for
  the behavior you implement.
- Security paths need negative tests: every rejection case (bad signature, issuer, audience,
  expiry, replayed `jti`, unknown/suspended app, unauthorized namespace, `rtc.*` outside a session).
- Tests run against in-memory adapters and need no network services.
- Coverage floors, enforced in CI by `vitest.config.ts`: 90% of lines and 85% of branches in
  `packages/protocol`, `packages/core`, the server's `domain` and `handlers` layers, where
  authorization lives, and the SDK's signaling layer (`packages/sdk/src/*.ts`). Transport code and
  the SDK's WebRTC layer (`packages/sdk/src/webrtc/`) have no floor: integration and Playwright
  tests cover them. Never lower a floor to make a change pass; add the missing tests.

## Language

- All code, identifiers, comments, docs, and commit messages are in **English**.

## Commits

Follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/):

```text
<type>(<optional scope>): <imperative summary>

<optional body: what and why>

<optional footer: BREAKING CHANGE: ..., Refs: ...>
```

- Types: `feat`, `fix`, `docs`, `refactor`, `test`, `perf`, `build`, `ci`, `chore`, `style`,
  `revert`.
- Scopes, once the packages exist: `server`, `sdk`, `protocol`, `core`, `storage`,
  `coordination`, `adr`, `spec`, `roadmap`.
- Summary in the imperative mood, lowercase, no trailing period, at most 72 characters.
- Breaking protocol or SDK changes use `!` after the type/scope and a `BREAKING CHANGE:` footer.
- One logical change per commit.

Examples:

```text
docs(adr): record namespace authorization source
feat(protocol): add versioned auth message schemas
fix(server): reject auth.refresh with a different device_id
feat(protocol)!: rename rtc.ice to rtc.ice_candidate
```

## Pull requests

- Every change, code or docs, reaches `main` through a pull request. Never push directly to `main`.
- Work on a branch cut from the latest `main`; one logical change per pull request.
