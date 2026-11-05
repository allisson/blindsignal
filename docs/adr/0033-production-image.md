# Production image

**Status:** accepted

Phase 10 asks for a production Docker image that runs unchanged in managed and self-hosted
environments. The Phase 3 `Dockerfile` already ran the server as `node`, with production
dependencies only and a health check, but its base, `node:26-slim`, moved with every upstream
push, it shipped npm and the core package's test helpers, and no check ran the image: a broken
`COPY` or a failing migration in it reached `main` unnoticed.

## Rules

- **One image for every environment,** configured by environment variables only
  (`apps/server/README.md`). Migrations run from the same image (ADR 0019).
- **Both stages pin the base by Node version and digest.** Dependabot proposes a pull request when
  the digest or the Node 26 release moves (`.github/dependabot.yml`), so security fixes to the base
  arrive as reviewed changes.
- **The runtime stage carries no package manager:** npm and npx are removed. Tests, `*.test.ts`
  and `packages/core/src/testing`, stay out of the image.
- **The server runs as `node`, with a read-only root filesystem and no capabilities.** It writes
  nothing to disk; logs go to standard output. `examples/self-hosted/compose.yaml` sets both for
  the server and the migration.
- **The health check runs every second during its 30-second start period,** so
  `docker compose up --wait` returns once the server listens instead of after the 30-second
  default interval.
- **CI builds the image on every pull request** and runs `.github/scripts/image-smoke.sh`: the
  migrations against PostgreSQL, the server read-only and without capabilities until healthy and
  ready, `blindsignal_dependency_up` for PostgreSQL, and `docker stop` ending with status 0 within
  the 10-second grace period (ADR 0031). It also validates `examples/self-hosted/compose.yaml`.
- **The image is published to Docker Hub as `allisson/blindsignal`** (amended by ADR 0050: it
  was not published until a release scheme existed). Operators can still build it from a checkout
  and push it to their own registry.

## Considered options

- **Publishing to GitHub Container Registry.** Deferred until a release and versioning scheme
  existed; ADR 0050 publishes to Docker Hub instead.
- **A distroless base.** Rejected for now: it ties the Node version to another release cadence,
  and its lack of a shell leaves operators no way to inspect a running container.
- **An Alpine base.** Rejected: musl builds of Node are not an official tier-1 target.
- **Compiling to JavaScript.** Rejected: the server runs its sources through type stripping
  (ADR 0001), so the image has no build step to get wrong.

## Consequences

- Dependabot opens a pull request for each base update; the `image` job tests it before merge.
- Removing npm saves no space, because the base layer still holds it; the image stays near 284 MB.
- `docker exec` into the container cannot install packages.
