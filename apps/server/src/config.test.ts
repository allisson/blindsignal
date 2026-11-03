import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.ts';

const required = { BLINDSIGNAL_REGISTRY_PATH: '/etc/blindsignal/registry.json' };
const production = { ...required, BLINDSIGNAL_ALLOWED_ORIGINS: 'https://app.example' };

function config(env: Record<string, string>) {
  const result = loadConfig(env);
  if (!result.ok) throw new Error(result.error);
  return result.config;
}

function error(env: Record<string, string>) {
  const result = loadConfig(env);
  if (result.ok) throw new Error('expected an invalid configuration');
  return result.error;
}

describe('loadConfig', () => {
  it('defaults to production, ADR 0006 and the Phase 3 timings', () => {
    const { proxyTrust, ...rest } = config(production);
    expect(rest).toEqual({
      development: false,
      port: 8080,
      adminPort: 9090,
      adminHost: '127.0.0.1',
      registryPath: '/etc/blindsignal/registry.json',
      allowedOrigins: new Set(['https://app.example']),
      iceServers: [],
      token: { maxLifetimeSeconds: 600, clockSkewSeconds: 60, maxNamespaces: 100 },
      heartbeatIntervalMs: 30_000,
      presenceLeaseMs: 90_000,
      negotiationTimeoutMs: 30_000,
      deviceTtlMs: 30 * 86_400_000,
      preAuthentication: {
        authenticationTimeoutMs: 10_000,
        maxUnauthenticatedPerIp: 20,
        maxUnauthenticated: 1_000,
        connectionAttempts: { ratePerSecond: 5, burst: 20 },
        authenticationAttempts: { ratePerSecond: 1, burst: 10 },
      },
      maxMessageBytes: 65_536,
      maxQueuedMessages: 1_024,
      maxBufferedBytes: 1_048_576,
      limits: {
        quotas: {
          connections: 10_000,
          devices: 10_000,
          sessions: 10_000,
          sessionsPerDevice: 16,
          namespacesPerDevice: 100,
        },
        rateLimits: {
          discovery: { ratePerSecond: 2, burst: 10 },
          session_create: { ratePerSecond: 2, burst: 10 },
          signaling: { ratePerSecond: 50, burst: 100 },
          rtc: { ratePerSecond: 10, burst: 30 },
          rtc_ice_candidate: { ratePerSecond: 20, burst: 50 },
        },
      },
    });
    expect(proxyTrust.header).toBe('x-forwarded-for');
    expect(proxyTrust.proxies.rules).toEqual([]);
  });

  it('reads every variable', () => {
    const { proxyTrust, ...rest } = config({
      BLINDSIGNAL_ENV: 'development',
      BLINDSIGNAL_PORT: '0',
      BLINDSIGNAL_ADMIN_PORT: '9191',
      BLINDSIGNAL_ADMIN_HOST: '0.0.0.0',
      BLINDSIGNAL_REGISTRY_PATH: 'registry.json',
      BLINDSIGNAL_ALLOWED_ORIGINS: ' https://a.example , http://localhost:5173,',
      BLINDSIGNAL_TRUSTED_PROXIES: '10.0.0.0/8, ::1',
      BLINDSIGNAL_FORWARDED_HEADER: 'cf-connecting-ip',
      BLINDSIGNAL_ICE_SERVERS: '[{"urls":["stun:stun.example:3478","stuns:stun.example"]}]',
      BLINDSIGNAL_TOKEN_MAX_LIFETIME_SECONDS: '300',
      BLINDSIGNAL_TOKEN_CLOCK_SKEW_SECONDS: '0',
      BLINDSIGNAL_TOKEN_MAX_NAMESPACES: '5',
      BLINDSIGNAL_HEARTBEAT_INTERVAL_SECONDS: '10',
      BLINDSIGNAL_PRESENCE_LEASE_SECONDS: '25',
      BLINDSIGNAL_NEGOTIATION_TIMEOUT_SECONDS: '15',
      BLINDSIGNAL_DEVICE_TTL_DAYS: '7',
      BLINDSIGNAL_AUTHENTICATION_TIMEOUT_SECONDS: '4',
      BLINDSIGNAL_MAX_UNAUTHENTICATED_PER_IP: '3',
      BLINDSIGNAL_MAX_UNAUTHENTICATED: '30',
      BLINDSIGNAL_RATE_LIMIT_CONNECTION_ATTEMPTS: '1,4',
      BLINDSIGNAL_RATE_LIMIT_AUTHENTICATION: '0.2,3',
      BLINDSIGNAL_MAX_MESSAGE_BYTES: '1024',
      BLINDSIGNAL_MAX_QUEUED_MESSAGES: '64',
      BLINDSIGNAL_MAX_BUFFERED_BYTES: '131072',
      BLINDSIGNAL_MAX_CONNECTIONS_PER_APP: '40',
      BLINDSIGNAL_MAX_DEVICES_PER_APP: '50',
      BLINDSIGNAL_MAX_SESSIONS_PER_APP: '60',
      BLINDSIGNAL_MAX_SESSIONS_PER_DEVICE: '3',
      BLINDSIGNAL_MAX_NAMESPACES_PER_DEVICE: '7',
      BLINDSIGNAL_RATE_LIMIT_DISCOVERY: '0.5,1',
      BLINDSIGNAL_RATE_LIMIT_SESSION_CREATE: '1,2',
      BLINDSIGNAL_RATE_LIMIT_SIGNALING: '30,60',
      BLINDSIGNAL_RATE_LIMIT_RTC: '5,15',
      BLINDSIGNAL_RATE_LIMIT_RTC_ICE_CANDIDATE: '8,40',
    });
    expect(rest).toEqual({
      development: true,
      port: 0,
      adminPort: 9191,
      adminHost: '0.0.0.0',
      registryPath: 'registry.json',
      allowedOrigins: new Set(['https://a.example', 'http://localhost:5173']),
      iceServers: [{ urls: ['stun:stun.example:3478', 'stuns:stun.example'] }],
      token: { maxLifetimeSeconds: 300, clockSkewSeconds: 0, maxNamespaces: 5 },
      heartbeatIntervalMs: 10_000,
      presenceLeaseMs: 25_000,
      negotiationTimeoutMs: 15_000,
      deviceTtlMs: 7 * 86_400_000,
      preAuthentication: {
        authenticationTimeoutMs: 4_000,
        maxUnauthenticatedPerIp: 3,
        maxUnauthenticated: 30,
        connectionAttempts: { ratePerSecond: 1, burst: 4 },
        authenticationAttempts: { ratePerSecond: 0.2, burst: 3 },
      },
      maxMessageBytes: 1024,
      maxQueuedMessages: 64,
      maxBufferedBytes: 131_072,
      limits: {
        quotas: {
          connections: 40,
          devices: 50,
          sessions: 60,
          sessionsPerDevice: 3,
          namespacesPerDevice: 7,
        },
        rateLimits: {
          discovery: { ratePerSecond: 0.5, burst: 1 },
          session_create: { ratePerSecond: 1, burst: 2 },
          signaling: { ratePerSecond: 30, burst: 60 },
          rtc: { ratePerSecond: 5, burst: 15 },
          rtc_ice_candidate: { ratePerSecond: 8, burst: 40 },
        },
      },
    });
    expect(proxyTrust.header).toBe('cf-connecting-ip');
    expect(proxyTrust.proxies.check('10.1.2.3', 'ipv4')).toBe(true);
    expect(proxyTrust.proxies.check('::1', 'ipv6')).toBe(true);
    expect(proxyTrust.proxies.check('11.0.0.1', 'ipv4')).toBe(false);
  });

  it('requires the registry path', () => {
    expect(error({ BLINDSIGNAL_ALLOWED_ORIGINS: '*' })).toContain('BLINDSIGNAL_REGISTRY_PATH');
  });

  describe('allowed origins', () => {
    it('are required in production', () => {
      expect(error(required)).toContain('BLINDSIGNAL_ALLOWED_ORIGINS');
      expect(error({ ...required, BLINDSIGNAL_ALLOWED_ORIGINS: ' , ' })).toContain(
        'BLINDSIGNAL_ALLOWED_ORIGINS',
      );
    });

    it('allow every origin when empty in development', () => {
      expect(config({ ...required, BLINDSIGNAL_ENV: 'development' }).allowedOrigins).toBe('*');
    });

    it('allow every origin only through an explicit *', () => {
      const env = { ...required, BLINDSIGNAL_ALLOWED_ORIGINS: 'https://a.example,*' };
      expect(config(env).allowedOrigins).toBe('*');
    });

    it.each(['https://a.example/', 'https://a.example/path', 'a.example', 'null', '**'])(
      'reject %s, which is not a serialized origin',
      (entry) => {
        const env = { ...required, BLINDSIGNAL_ALLOWED_ORIGINS: entry };
        expect(error(env)).toContain('BLINDSIGNAL_ALLOWED_ORIGINS');
      },
    );
  });

  it.each([
    ['BLINDSIGNAL_TRUSTED_PROXIES', 'proxy.internal'],
    ['BLINDSIGNAL_FORWARDED_HEADER', 'forwarded'],
    ['BLINDSIGNAL_ICE_SERVERS', '[{"urls":["turn:turn.example"]}]'],
    ['BLINDSIGNAL_ICE_SERVERS', '[{"urls":["stun:a"],"username":"u","credential":"c"}]'],
    ['BLINDSIGNAL_ICE_SERVERS', '[{"urls":[]}]'],
    ['BLINDSIGNAL_ICE_SERVERS', '{"urls":["stun:a"]}'],
    ['BLINDSIGNAL_PORT', '65536'],
    ['BLINDSIGNAL_ADMIN_PORT', '-1'],
    ['BLINDSIGNAL_ADMIN_HOST', 'localhost'],
    ['BLINDSIGNAL_HEARTBEAT_INTERVAL_SECONDS', '0'],
    ['BLINDSIGNAL_PRESENCE_LEASE_SECONDS', '1.5'],
    ['BLINDSIGNAL_NEGOTIATION_TIMEOUT_SECONDS', 'soon'],
    ['BLINDSIGNAL_DEVICE_TTL_DAYS', '0'],
    ['BLINDSIGNAL_AUTHENTICATION_TIMEOUT_SECONDS', '0'],
    ['BLINDSIGNAL_MAX_UNAUTHENTICATED_PER_IP', '0'],
    ['BLINDSIGNAL_MAX_UNAUTHENTICATED', '2.5'],
    ['BLINDSIGNAL_RATE_LIMIT_CONNECTION_ATTEMPTS', '5'],
    ['BLINDSIGNAL_RATE_LIMIT_AUTHENTICATION', '1,'],
    ['BLINDSIGNAL_MAX_DEVICES_PER_APP', '0'],
    ['BLINDSIGNAL_MAX_MESSAGE_BYTES', '0'],
    ['BLINDSIGNAL_MAX_MESSAGE_BYTES', '65537'],
    ['BLINDSIGNAL_MAX_QUEUED_MESSAGES', '1'],
    ['BLINDSIGNAL_MAX_BUFFERED_BYTES', '65535'],
    ['BLINDSIGNAL_MAX_CONNECTIONS_PER_APP', '1.5'],
    ['BLINDSIGNAL_MAX_SESSIONS_PER_APP', 'many'],
    ['BLINDSIGNAL_MAX_SESSIONS_PER_DEVICE', '-1'],
    ['BLINDSIGNAL_MAX_NAMESPACES_PER_DEVICE', '0'],
    ['BLINDSIGNAL_RATE_LIMIT_DISCOVERY', '2'],
    ['BLINDSIGNAL_RATE_LIMIT_SESSION_CREATE', '2,10,3'],
    ['BLINDSIGNAL_RATE_LIMIT_SIGNALING', '0,10'],
    ['BLINDSIGNAL_RATE_LIMIT_RTC', '10,0'],
    ['BLINDSIGNAL_RATE_LIMIT_RTC_ICE_CANDIDATE', ' 20, 50'],
  ])('rejects %s=%s', (name, value) => {
    expect(error({ ...production, [name]: value })).toContain(name);
  });

  it('names invalid variables without their values', () => {
    const message = error({
      ...production,
      BLINDSIGNAL_ENV: 'staging',
      BLINDSIGNAL_TOKEN_MAX_LIFETIME_SECONDS: '0',
      BLINDSIGNAL_TOKEN_MAX_NAMESPACES: 'many',
      BLINDSIGNAL_ICE_SERVERS: '[{"urls":["stun:secret-host"]',
      BLINDSIGNAL_TRUSTED_PROXIES: 'secret-proxy',
    });
    for (const name of [
      'BLINDSIGNAL_ENV',
      'BLINDSIGNAL_TOKEN_MAX_LIFETIME_SECONDS',
      'BLINDSIGNAL_TOKEN_MAX_NAMESPACES',
      'BLINDSIGNAL_ICE_SERVERS',
      'BLINDSIGNAL_TRUSTED_PROXIES',
    ]) {
      expect(message).toContain(name);
    }
    for (const value of ['staging', 'many', 'secret-host', 'secret-proxy']) {
      expect(message).not.toContain(value);
    }
  });
});
