# The server runs its TypeScript sources through Node's type stripping, as in development
# (ADR 0001): the workspace packages export `src/index.ts`, so there is no build step.
# Both stages pin the base by digest; Dependabot proposes its updates (ADR 0033).
FROM node:26.13.0-slim@sha256:e4db4c914bf8ad241bd24804fc25d272d89bad97e68cdc8a1414862790a02c39 AS deps
WORKDIR /app
# Node 26 no longer bundles corepack; install the pinned pnpm (package.json `packageManager`).
RUN npm install --global pnpm@12.16.1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY packages/protocol/package.json packages/protocol/
COPY packages/core/package.json packages/core/
COPY adapters/storage/memory/package.json adapters/storage/memory/
COPY adapters/storage/postgresql/package.json adapters/storage/postgresql/
COPY adapters/coordination/memory/package.json adapters/coordination/memory/
COPY adapters/coordination/redis/package.json adapters/coordination/redis/
RUN pnpm install --frozen-lockfile --prod --filter '@blindsignal/server...'

FROM node:26.13.0-slim@sha256:e4db4c914bf8ad241bd24804fc25d272d89bad97e68cdc8a1414862790a02c39
ENV NODE_ENV=production
# The server needs no package manager at runtime.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
WORKDIR /app
COPY --from=deps /app ./
COPY packages/protocol/src packages/protocol/src
COPY packages/core/src packages/core/src
COPY adapters/storage/memory/src adapters/storage/memory/src
COPY adapters/storage/postgresql/src adapters/storage/postgresql/src
COPY adapters/coordination/memory/src adapters/coordination/memory/src
COPY adapters/coordination/redis/src adapters/coordination/redis/src
COPY apps/server/src apps/server/src
USER node
# Signaling (health and readiness included) and the admin port with /metrics.
EXPOSE 8080 9090
# Every second while starting, so `docker compose up --wait` returns once the server listens.
HEALTHCHECK --start-period=30s --start-interval=1s CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.BLINDSIGNAL_PORT ?? 8080}/healthz`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
# Migrations run before a release with this image and BLINDSIGNAL_DATABASE_URL (ADR 0019):
# node adapters/storage/postgresql/src/migrate-command.ts
CMD ["node", "apps/server/src/main.ts"]
