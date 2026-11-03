import { defineConfig, devices } from '@playwright/test';

// Ports apart from the defaults, so a local server and demo can keep running.
const signalingPort = 8787;
const demoPort = 3787;
const development = { BLINDSIGNAL_ENV: 'development' };
// BLINDSIGNAL_TEST_TURN=1 starts the compose.yaml Coturn, with Docker, and hands its secret to the
// signaling server; the relay test runs only then.
const turn = !!process.env.BLINDSIGNAL_TEST_TURN;
const turnEnv: Record<string, string> = turn
  ? {
      BLINDSIGNAL_TURN_URLS: 'turn:127.0.0.1:3478?transport=udp',
      BLINDSIGNAL_TURN_SECRET: 'blindsignal-test-turn-secret-never-in-production',
    }
  : {};

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
          firefoxUserPrefs: {
            'media.peerconnection.ice.obfuscate_host_addresses': false,
            // The test TURN server listens on loopback, which Firefox's ICE skips by default.
            'media.peerconnection.ice.loopback': true,
          },
        },
      },
    },
  ],
  webServer: [
    ...(turn
      ? [
          {
            command: 'docker compose --profile turn up coturn',
            cwd: '../..',
            port: 3478,
            // Ctrl-C, so Compose stops the container instead of leaving it running.
            gracefulShutdown: { signal: 'SIGINT' as const, timeout: 10_000 },
            reuseExistingServer: !process.env.CI,
          },
        ]
      : []),
    {
      command: 'node ../../apps/server/src/main.ts',
      url: `http://127.0.0.1:${signalingPort}/readyz`,
      env: {
        ...development,
        ...turnEnv,
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
