import { defineConfig, devices } from '@playwright/test';

// Ports apart from the defaults, so a local server and demo can keep running.
const signalingPort = 8787;
const demoPort = 3787;
const development = { BLINDSIGNAL_ENV: 'development' };
// BLINDSIGNAL_TEST_TURN=1 starts the compose.yaml Coturn, with Docker, and one signaling server per
// TURN transport, each offering only that URL, plus one whose TURN URL nothing listens on; the
// relay tests run only then.
const turn = !!process.env.BLINDSIGNAL_TEST_TURN;
const turnUrls = {
  [signalingPort]: 'turn:127.0.0.1:3478?transport=udp',
  [signalingPort + 1]: 'turn:127.0.0.1:3478?transport=tcp',
  [signalingPort + 2]: 'turns:localhost:5349?transport=tcp',
  [signalingPort + 3]: 'turn:127.0.0.1:3479?transport=udp',
};
const turnEnv = (port: number): Record<string, string> =>
  turn
    ? {
        BLINDSIGNAL_TURN_URLS: turnUrls[port]!,
        BLINDSIGNAL_TURN_SECRET: 'blindsignal-test-turn-secret-never-in-production',
      }
    : {};
const signalingPorts = turn ? Object.keys(turnUrls).map(Number) : [signalingPort];

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
        launchOptions: {
          args: [
            // Host candidates as IPs: headless CI has no mDNS to resolve `.local` names.
            '--disable-features=WebRtcHideLocalIpsWithMdns',
            // Accepts the test TURN server's self-signed certificate; the pages are plain HTTP.
            '--ignore-certificate-errors',
          ],
        },
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
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
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
    ...signalingPorts.map((port) => ({
      command: 'node ../../apps/server/src/main.ts',
      url: `http://127.0.0.1:${port}/readyz`,
      env: {
        ...development,
        ...turnEnv(port),
        BLINDSIGNAL_PORT: String(port),
        BLINDSIGNAL_ADMIN_PORT: '0',
        BLINDSIGNAL_REGISTRY_PATH: '../registry.dev.json',
        // Every test device connects from 127.0.0.1, so the per-address limits would throttle them.
        BLINDSIGNAL_RATE_LIMIT_CONNECTION_ATTEMPTS: '100,100',
        BLINDSIGNAL_RATE_LIMIT_AUTHENTICATION: '100,100',
      },
      reuseExistingServer: !process.env.CI,
    })),
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
