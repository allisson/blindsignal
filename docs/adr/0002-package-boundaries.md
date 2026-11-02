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

## Dependency rules

```text
packages/protocol   → zod
packages/core       → protocol
packages/sdk        → protocol
adapters/*/*        → core
apps/server         → protocol, core, adapters/*, jose, ws
```

Nothing imports `apps/server`. The SDK never imports `core`, `adapters/*`, or `jose`. `core`
imports no provider. Declared dependencies under strict pnpm (ADR 0001) and an ESLint
restricted-import rule enforce this.
