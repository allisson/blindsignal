# Package boundaries

**Status:** accepted

The only thing the server and the browser SDK share is the wire contract, so it gets its own
package. Spec §19 also listed `packages/shared`, but the other thing that must sit outside
`apps/server` is server-only: the adapter interfaces and domain types that `adapters/*` implement.
An adapter must not import an app, and the SDK must not see storage contracts. So `shared` is
replaced by `packages/core`, a server-side package that the SDK never imports.

## Packages

- **`packages/protocol`**: Zod schemas and inferred types for every message, the protocol version
  and its compatibility rule, the direction of each message type (client to server, server to
  client, relayed between participants), and the error-code catalog with each code's class
  (retryable, terminal, superseded; spec §8.3). No I/O. Resource limits stay out: they are
  configurable, so at most the protocol exports the absolute ceiling a schema accepts.
- **`packages/core`**: server-side domain types (application, device, namespace records) and the
  `StorageAdapter` and `CoordinationAdapter` interfaces (spec §10). Contracts only, no logic and no
  provider.
- **`packages/sdk`**: the browser SDK. It validates every inbound server message against the
  `protocol` schemas; an invalid message is a protocol error and is not processed.
- **`adapters/*/*`**: one package per provider, implementing the `core` interfaces.
- **`apps/server`**: transport (`ws`, `node:http`), token validation (`jose`), and all business
  logic (authentication, authorization, sessions, presence), layered internally as transport,
  handlers, and domain so the logic is testable without opening a socket. Logic moves to its own
  package only when a second consumer, such as a control-plane CLI, needs it.
- **`packages/dev-issuer`**: the development token issuer and its test keys (roadmap Phase 2), used
  by tests, `examples/`, and the Docker Compose development workflow.

All packages use the `@blindsignal/*` scope and stay `"private": true` until Phase 12 defines
semantic versioning and publication. ADR 0043 defined it (amended): the SDK, with `protocol`, and
the server are versioned; `core`, `adapters/*`, `dev-issuer`, and `examples/*` stay private.

## Dependency rules

```text
packages/protocol   → zod
packages/core       → protocol
packages/sdk        → protocol
packages/dev-issuer → jose
adapters/*/*        → core
apps/server         → protocol, core, adapters/*, jose, ws
```

Nothing imports `apps/server`. The SDK never imports `core`, `adapters/*`, or `jose`. `core`
imports no provider. Declared dependencies under strict pnpm (ADR 0001) and an ESLint
restricted-import rule enforce this.

- **`protocol` is isomorphic**: no `node:*` import. JWT claim schemas are not protocol: the SDK
  treats the access token as opaque, and only `apps/server` validates claims.
- **Only the composition root imports adapters.** `apps/server` exports a side-effect-free
  `createServer(config, adapters)`; `src/main.ts` reads the environment, builds the adapters, and
  calls it. The ESLint rule forbids importing `adapters/*` anywhere else in `apps/server/src`, since
  the server must declare the adapters to wire them and declared dependencies alone cannot stop the
  domain layer from importing one. Tests may import the in-memory adapters to pass them to
  `createServer`.
- **Server source never imports `dev-issuer`.** The server trusts the development issuer only
  through configuration, as a registry entry with its static public key, which keeps development
  credentials out of production trust configuration (spec §14.1). Only `apps/server` tests import
  it, as a devDependency.
- **The SDK uses only web-standard globals** (`WebSocket`, `crypto.subtle`, `RTCPeerConnection`)
  and never depends on `ws`. Node.js LTS provides the first two globally, so the SDK's signaling
  layer runs unmodified under Vitest; WebRTC runs only under Playwright.
- **Applications depend only on `sdk`.** It re-exports the protocol values it surfaces (error codes
  and their classes, connection types, event types), so an application never pins `protocol`.

## Tests

- Each package holds its own unit and integration tests (Vitest).
- Server integration tests start `createServer` in-process on an ephemeral port with in-memory
  adapters and drive it with the real SDK and `dev-issuer` tokens (both devDependencies of
  `apps/server`).
- The root `tests/` directory holds only Playwright browser-to-browser tests, which need the
  server, the SDK, and a page together.
