# The server runs its TypeScript sources through Node's type stripping, as in development
# (ADR 0001): the workspace packages export `src/index.ts`, so there is no build step.
FROM node:26-slim AS deps
WORKDIR /app
# Node 26 no longer bundles corepack; install the pinned pnpm (package.json `packageManager`).
RUN npm install --global pnpm@12.16.1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY packages/protocol/package.json packages/protocol/
COPY packages/core/package.json packages/core/
COPY adapters/storage/memory/package.json adapters/storage/memory/
COPY adapters/coordination/memory/package.json adapters/coordination/memory/
RUN pnpm install --frozen-lockfile --prod --filter '@blindsignal/server...'

FROM node:26-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app ./
COPY packages/protocol/src packages/protocol/src
COPY packages/core/src packages/core/src
COPY adapters/storage/memory/src adapters/storage/memory/src
COPY adapters/coordination/memory/src adapters/coordination/memory/src
COPY apps/server/src apps/server/src
USER node
# Signaling (health and readiness included) and the admin port with /metrics.
EXPOSE 8080 9090
HEALTHCHECK CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.BLINDSIGNAL_PORT ?? 8080}/healthz`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "apps/server/src/main.ts"]
