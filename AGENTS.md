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
(ADR 0016). Phase 8 (TURN support), decided in ADR 0017, is in progress: the server issues TURN
credentials; see the roadmap's "After the MVP". The workspace uses the toolchain in
`docs/adr/0001-typescript-node-toolchain.md` (TypeScript on Node.js LTS, pnpm workspaces, Zod 4,
`jose`, `ws`, Vitest, Playwright). Do not add a tool outside that ADR without a
new ADR.

TypeScript stays on 6.0.x until `typescript-eslint` supports 7: type-aware linting is required.

## Commands

Node.js 26 (`.nvmrc`) and pnpm through corepack (`packageManager` in `package.json`).

```sh
pnpm install          # install the workspace
pnpm lint             # ESLint, type-aware, with the ADR 0002 import rules
pnpm typecheck        # tsc --noEmit in every package
pnpm test             # Vitest across all packages
pnpm test:coverage    # Vitest with V8 coverage and the floors below
pnpm test:browser     # Playwright, Chromium and Firefox, against examples/browser-demo
pnpm format:check     # Prettier (pnpm format to fix)
pnpm build            # tsc in every package
```

CI (`.github/workflows/ci.yml`) runs format check, lint, typecheck, and tests with coverage on
every pull request, and the browser tests in a job of their own.

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
- Pairing protocol (§7.4, post-MVP). Never invent custom cryptography.

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
