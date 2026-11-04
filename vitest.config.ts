import { defineConfig } from 'vitest/config';

// Coverage floors per area, from the testing policy in AGENTS.md.
const floor = { lines: 90, branches: 85 };

export default defineConfig({
  test: {
    // Not examples/*: the browser demo's specs are Playwright's.
    projects: ['apps/*', 'packages/*', 'adapters/*/*', 'examples/backend-issuer'],
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      include: ['apps/*/src/**/*.ts', 'packages/*/src/**/*.ts', 'adapters/*/*/src/**/*.ts'],
      thresholds: {
        'packages/protocol/src/**': floor,
        'packages/core/src/**': floor,
        'apps/server/src/{domain,handlers}/**': floor,
        // The SDK's signaling layer; its WebRTC layer lives in src/webrtc/ and has no floor.
        'packages/sdk/src/*.ts': floor,
      },
    },
  },
});
