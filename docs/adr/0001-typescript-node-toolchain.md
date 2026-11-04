# TypeScript on Node.js toolchain

**Status:** accepted

The server and the browser SDK must consume the same protocol schemas from one shared package
(spec §11), and the SDK must run in the browser. We write everything in strict TypeScript, run the
server on the active Node.js LTS line, and define every protocol message with Zod 4. These two
choices are the hard-to-reverse ones: a non-JS server would need a neutral schema source plus
codegen on both sides, and every message schema is written against the validation library.

## Toolchain

- **Language:** TypeScript, `strict`, with `erasableSyntaxOnly` (no `enum`, no parameter
  properties) so development runs `.ts` directly through Node's native type stripping.
- **Runtime:** Node.js, active LTS line, pinned at scaffolding. Bun and Deno were rejected: less
  mature for long-lived WebSocket servers and container deployment.
- **Repository:** one monorepo with the spec §19 layout, one package per directory, so the rule
  that business logic never imports a provider is enforced by declared dependencies.
- **Package manager:** pnpm workspaces, version pinned through `packageManager` and corepack. No
  Turborepo or Nx; `pnpm -r` is enough for this package graph. npm workspaces were rejected because
  loose hoisting lets a package import an undeclared dependency.
- **Schema validation:** Zod 4 (`zod/mini` if SDK bundle size becomes a problem). Its JSON Schema
  export can feed `docs/protocol.md`.
- **JWT / JWKS:** `jose`. Its remote JWKS set provides fetch timeouts and a refetch cooldown, which
  implement the rate-limited unknown-`kid` refetch (spec §5.3). HTTPS-only JWKS URIs, maximum token
  lifetime, future `iat`, issuer-to-application mapping, and `jti` replay stay in our code.
- **WebSocket / HTTP:** `ws` on `node:http`, no web framework. `maxPayload` bounds message size;
  the `Origin` check runs in the manual `upgrade` handler; `node:http` serves health and readiness.
- **Modules and build:** ESM-only packages, built with `tsc` alone. The SDK ships ESM plus `.d.ts`
  and leaves bundling to the consuming application.
- **Tests:** Vitest for unit and integration tests against in-memory adapters; Playwright Test for
  browser-to-browser DataChannel tests.
- **Browsers:** Chromium and Firefox are required in CI from the MVP; WebKit is best-effort until
  the Phase 12 compatibility tests, since headless WebKit WebRTC is limited in CI. Amended by
  ADR 0047: WebKit runs in CI too, and the supported versions are named there.
- **Lint and format:** ESLint with type-checked `typescript-eslint`, plus Prettier. Type-aware
  `no-floating-promises` and `no-misused-promises` matter in an async message handler, where a
  forgotten promise can silently skip an authorization check. Biome was rejected for weaker
  type-aware rules.
- **Persistence and coordination:** `pg` with hand-written SQL migrations, and the `redis` client
  tested against Valkey, each inside its adapter package (ADR 0019).
