import { defineConfig, devices } from '@playwright/test';
import { registryEntry } from '@blindsignal/backend-issuer';
import { configFromEnv } from '@blindsignal/backend-issuer/config';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Ports apart from the browser demo's, so both suites can run at once.
const signalingPort = 8797;
const appPort = 3797;

// A key for this run, kept in the environment so Playwright's workers load the same one.
process.env.BLINDSIGNAL_EXAMPLE_SIGNING_JWK ??= JSON.stringify({
  ...generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' }),
  kid: 'minimal-app-test',
});
const appEnv = {
  BLINDSIGNAL_EXAMPLE_SIGNING_JWK: process.env.BLINDSIGNAL_EXAMPLE_SIGNING_JWK,
  BLINDSIGNAL_EXAMPLE_PORT: String(appPort),
  BLINDSIGNAL_EXAMPLE_SIGNALING_URL: `ws://localhost:${signalingPort}`,
  // Every test page signs in from 127.0.0.1, so the per-address limit would throttle them.
  BLINDSIGNAL_EXAMPLE_RATE_LIMIT_PER_MINUTE: '1000',
};
const registryPath = join(tmpdir(), 'blindsignal-minimal-app', 'registry.json');
mkdirSync(join(registryPath, '..'), { recursive: true });
writeFileSync(
  registryPath,
  JSON.stringify({ applications: [registryEntry(configFromEnv(appEnv))] }),
);

export default defineConfig({
  testDir: 'tests',
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? 'github' : 'list',
  use: { baseURL: `http://127.0.0.1:${appPort}` },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Host candidates as IPs: headless CI has no mDNS to resolve `.local` names.
        launchOptions: { args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] },
      },
    },
    {
      name: 'firefox',
      use: {
        ...devices['Desktop Firefox'],
        launchOptions: {
          firefoxUserPrefs: { 'media.peerconnection.ice.obfuscate_host_addresses': false },
        },
      },
    },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: [
    {
      command: 'node ../../apps/server/src/main.ts',
      url: `http://127.0.0.1:${signalingPort}/readyz`,
      env: {
        BLINDSIGNAL_ENV: 'development',
        BLINDSIGNAL_PORT: String(signalingPort),
        BLINDSIGNAL_ADMIN_PORT: '0',
        BLINDSIGNAL_REGISTRY_PATH: registryPath,
        // Every test device connects from 127.0.0.1, so the per-address limits would throttle them.
        BLINDSIGNAL_RATE_LIMIT_CONNECTION_ATTEMPTS: '100,100',
        BLINDSIGNAL_RATE_LIMIT_AUTHENTICATION: '100,100',
      },
      reuseExistingServer: !process.env.CI,
    },
    {
      command: 'node server.ts',
      url: `http://127.0.0.1:${appPort}/config`,
      env: appEnv,
      reuseExistingServer: !process.env.CI,
    },
  ],
});
