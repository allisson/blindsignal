import { defineConfig, devices } from '@playwright/test';

// Ports apart from the defaults, so a local server and demo can keep running.
const signalingPort = 8787;
const demoPort = 3787;
const development = { BLINDSIGNAL_ENV: 'development' };

export default defineConfig({
  testDir: 'tests',
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? 'github' : 'list',
  use: { baseURL: `http://127.0.0.1:${demoPort}` },
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
  ],
  webServer: [
    {
      command: 'node ../../apps/server/src/main.ts',
      url: `http://127.0.0.1:${signalingPort}/readyz`,
      env: {
        ...development,
        BLINDSIGNAL_PORT: String(signalingPort),
        BLINDSIGNAL_ADMIN_PORT: '0',
        BLINDSIGNAL_REGISTRY_PATH: '../registry.dev.json',
      },
      reuseExistingServer: !process.env.CI,
    },
    {
      command: 'node server.ts',
      url: `http://127.0.0.1:${demoPort}/config`,
      env: {
        ...development,
        BLINDSIGNAL_DEMO_PORT: String(demoPort),
        BLINDSIGNAL_DEMO_SIGNALING_URL: `ws://localhost:${signalingPort}`,
      },
      reuseExistingServer: !process.env.CI,
    },
  ],
});
