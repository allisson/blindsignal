# Contributing

Before changing behavior, read the sections of [`docs/spec.md`](docs/spec.md) it touches, and the
ADRs in [`docs/adr/`](docs/adr). When the code and the spec disagree, raise it in an issue or the
pull request; do not silently diverge. A change to a documented contract updates the spec, the
roadmap, or an ADR in the same pull request. Report a vulnerability privately, as
[`SECURITY.md`](SECURITY.md) says, never in an issue.

## Setup

Node.js 26 (`.nvmrc`) and pnpm, through corepack, at the version `packageManager` in `package.json`
names:

```sh
corepack enable
pnpm install
```

The unit tests need nothing else: they run against the in-memory adapters. The browser tests need
the Playwright browsers:

```sh
pnpm --filter @blindsignal/browser-demo exec playwright install chromium firefox webkit
```

The relay, PostgreSQL, and Valkey tests need Docker, for the services in `compose.yaml`.

## Commands

```sh
pnpm lint             # ESLint, type-aware, with the ADR 0002 import rules
pnpm typecheck        # tsc --noEmit in every package
pnpm test             # Vitest across all packages
pnpm test:coverage    # Vitest with V8 coverage and the floors below
pnpm test:browser     # Playwright, Chromium, Firefox, and WebKit, against examples/browser-demo and examples/minimal-app
pnpm format:check     # Prettier (pnpm format to fix)
pnpm build            # tsc in every package
node tests/load/load.ts --smoke  # the load test, small; without --smoke, 10,000 devices (ADR 0049)
```

With the services of `compose.yaml`:

```sh
# The relay tests: Playwright starts the Coturn of compose.yaml itself.
BLINDSIGNAL_TEST_TURN=1 pnpm test:browser

# The PostgreSQL and Redis adapters, and two server instances sharing them:
docker compose --profile postgres --profile valkey up --wait postgres pgbouncer valkey
export BLINDSIGNAL_DATABASE_URL=postgres://blindsignal:blindsignal-test-password-never-in-production@127.0.0.1:5432/blindsignal
pnpm --filter @blindsignal/storage-postgresql migrate
BLINDSIGNAL_TEST_POSTGRES_URL=$BLINDSIGNAL_DATABASE_URL \
  BLINDSIGNAL_TEST_REDIS_URL=redis://127.0.0.1:6379 pnpm test
```

Port `6432` instead of `5432` runs the PostgreSQL tests through PgBouncer in transaction mode, as
behind a managed provider's pooler (ADR 0027).

## Checks

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs on every pull request, and each job
must pass:

- `check`: `pnpm audit --prod`, format, lint, typecheck, tests with coverage, and the load test's
  smoke run.
- `browser`: the Playwright suites in Chromium, Firefox, and WebKit, with the relay tests against
  Coturn. A failed test is retried once, and the traces of failed attempts are kept as the
  `playwright-traces` artifact for 7 days (ADR 0047).
- `adapters`: the PostgreSQL and Redis adapters against their services, directly and through
  PgBouncer.
- `image`: the production image, run read-only by `.github/scripts/image-smoke.sh`, and the
  self-hosted Compose file.

Run format, lint, typecheck, and `test:coverage` before pushing; run `test:browser` too when a change
touches the SDK, the server's signaling, or an example.

### Tests

- [`docs/spec.md`](docs/spec.md) §21 lists the required unit, integration, connectivity, and abuse
  tests; add the tests for the behavior you implement.
- Security paths need negative tests: every rejection case (bad signature, issuer, audience,
  expiry, replayed `jti`, unknown or suspended application, unauthorized namespace, `rtc.*` outside
  a session).
- Tests run against the in-memory adapters and need no network services, except the adapter and
  relay tests above, which skip without their variable.
- Coverage floors, enforced by `vitest.config.ts`: 90% of lines and 85% of branches in
  `packages/protocol`, `packages/core`, the server's `domain` and `handlers` layers, where
  authorization lives, and the SDK's signaling layer (`packages/sdk/src/*.ts`). Transport code and
  the SDK's WebRTC layer (`packages/sdk/src/webrtc/`) have no floor: integration and Playwright
  tests cover them. Never lower a floor to make a change pass; add the missing tests.

## Conventions

- Code, identifiers, comments, docs, and commit messages are in English.
- Use the terms of [`GLOSSARY.md`](GLOSSARY.md) in code, docs, and messages.
- A test fails on a relative Markdown link whose file, or whose heading in a Markdown file, does
  not exist (`apps/server/src/markdown-links.test.ts`). Anchors follow GitHub's: the heading in
  lowercase, punctuation dropped, and spaces turned into hyphens.
- Package dependencies follow [ADR 0002](docs/adr/0002-package-boundaries.md), which the lint
  enforces. A tool outside [ADR 0001](docs/adr/0001-typescript-node-toolchain.md) and the ADRs that
  extend it needs a new ADR.
- Resource limits are configurable, never hardcoded constants.

### Commits

Follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/):

```text
<type>(<optional scope>): <imperative summary>

<optional body: what and why>

<optional footer: BREAKING CHANGE: ..., Refs: ...>
```

- Types: `feat`, `fix`, `docs`, `refactor`, `test`, `perf`, `build`, `ci`, `chore`, `style`,
  `revert`.
- Scopes: `server`, `sdk`, `protocol`, `core`, `storage`, `coordination`, `adr`, `spec`, `roadmap`.
- Summary in the imperative mood, lowercase, no trailing period, at most 72 characters.
- Breaking protocol or SDK changes use `!` after the type or scope and a `BREAKING CHANGE:` footer.
- One logical change per commit.

Examples:

```text
docs(adr): record namespace authorization source
feat(protocol): add versioned auth message schemas
fix(server): reject auth.refresh with a different device_id
feat(protocol)!: rename rtc.ice to rtc.ice_candidate
```

### Pull requests

- Every change, code or docs, reaches `main` through a pull request. Nobody pushes to `main`.
- Work on a branch cut from the latest `main`; one logical change per pull request.
- A release has a pull request of its own, which sets the versions and writes the `CHANGELOG.md`
  entries ([ADR 0043](docs/adr/0043-semantic-versioning.md),
  [ADR 0050](docs/adr/0050-publishing-releases.md)).
