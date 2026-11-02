import { defineConfig } from 'vitest/config';

// Coverage floors per area, from the testing policy in AGENTS.md.
const floor = { lines: 90, branches: 85 };

export default defineConfig({
  test: {
    projects: ['apps/*', 'packages/*', 'adapters/*/*'],
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      include: ['apps/*/src/**/*.ts', 'packages/*/src/**/*.ts', 'adapters/*/*/src/**/*.ts'],
      thresholds: {
        'packages/protocol/src/**': floor,
        'packages/core/src/**': floor,
        'apps/server/src/{domain,handlers}/**': floor,
      },
    },
  },
});
