import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.ts';

const required = { BLINDSIGNAL_REGISTRY_PATH: '/etc/blindsignal/registry.json' };
const production = { ...required, BLINDSIGNAL_ALLOWED_ORIGINS: 'https://app.example' };
const SECRET = '0123456789abcdef0123456789abcdef';
const turn = {
  ...production,
  BLINDSIGNAL_TURN_URLS: 'turn:turn.example',
  BLINDSIGNAL_TURN_SECRET: SECRET,
};

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
      logLevel: 'info',
      registryPath: '/etc/blindsignal/registry.json',
      allowedOrigins: new Set(['https://app.example']),
      iceServers: [],
      token: {
        maxLifetimeSeconds: 600,
        clockSkewSeconds: 60,
        maxNamespaces: 100,
        jwks: { timeoutMs: 5_000, cacheMaxAgeMs: 600_000, cooldownMs: 30_000, maxBytes: 65_536 },
      },
      heartbeatIntervalMs: 30_000,
      closeTimeoutMs: 5_000,
      maxConnectionMs: 0,
      maxConnections: 0,
      presenceLeaseMs: 90_000,
      negotiationTimeoutMs: 30_000,
      deviceTtlMs: 30 * 86_400_000,
      deviceSweepIntervalMs: 3_600_000,
      registrySyncIntervalMs: 60_000,
      dependencyProbeTimeoutMs: 2_000,
      startupTimeoutMs: 30_000,
      shutdownDelayMs: 0,
      shutdownTimeoutMs: 8_000,
      preAuthentication: {
        authenticationTimeoutMs: 10_000,
        maxUnauthenticatedPerIp: 20,
        maxUnauthenticated: 1_000,
        connectionAttempts: { ratePerSecond: 5, burst: 20 },
        authenticationAttempts: { ratePerSecond: 1, burst: 10 },
        ipv6PrefixLength: 64,
        headersTimeoutMs: 10_000,
      },
      maxMessageBytes: 65_536,
      maxQueuedMessages: 1_024,
      maxBufferedBytes: 1_048_576,
      limits: {
        quotas: {
          connections: 10_000,
          devices: 10_000,
          devicesPerUser: 100,
          sessions: 10_000,
          sessionsPerDevice: 16,
          namespacesPerDevice: 100,
          sessionDurationSeconds: 0,
          pairingApprovers: 10,
        },
        rateLimits: {
          discovery: { ratePerSecond: 2, burst: 10 },
          session_create: { ratePerSecond: 2, burst: 10 },
          pairing: { ratePerSecond: 0.1, burst: 3 },
          presence: { ratePerSecond: 1, burst: 10 },
          refresh: { ratePerSecond: 0.1, burst: 5 },
          signaling: { ratePerSecond: 50, burst: 100 },
          rtc: { ratePerSecond: 10, burst: 30 },
          rtc_ice_candidate: { ratePerSecond: 20, burst: 50 },
        },
      },
      abuseAlerts: { threshold: 0, windowMs: 60_000 },
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
      BLINDSIGNAL_LOG_LEVEL: 'warn',
      BLINDSIGNAL_ALLOWED_ORIGINS: ' https://a.example , http://localhost:5173,',
      BLINDSIGNAL_TRUSTED_PROXIES: '10.0.0.0/8, ::1',
      BLINDSIGNAL_FORWARDED_HEADER: 'cf-connecting-ip',
      BLINDSIGNAL_ICE_SERVERS: '[{"urls":["stun:stun.example:3478","stuns:stun.example"]}]',
      BLINDSIGNAL_TURN_URLS: 'turn:turn.example:3478, turns:turn.example:443?transport=tcp',
      BLINDSIGNAL_TURN_SECRET: SECRET,
      BLINDSIGNAL_TURN_CREDENTIAL_TTL_SECONDS: '300',
      BLINDSIGNAL_TOKEN_MAX_LIFETIME_SECONDS: '300',
      BLINDSIGNAL_TOKEN_CLOCK_SKEW_SECONDS: '0',
      BLINDSIGNAL_TOKEN_MAX_NAMESPACES: '5',
      BLINDSIGNAL_JWKS_TIMEOUT_SECONDS: '2',
      BLINDSIGNAL_JWKS_CACHE_SECONDS: '60',
      BLINDSIGNAL_JWKS_COOLDOWN_SECONDS: '10',
      BLINDSIGNAL_JWKS_MAX_BYTES: '4096',
      BLINDSIGNAL_HEARTBEAT_INTERVAL_SECONDS: '10',
      BLINDSIGNAL_CLOSE_TIMEOUT_SECONDS: '2',
      BLINDSIGNAL_PRESENCE_LEASE_SECONDS: '25',
      BLINDSIGNAL_NEGOTIATION_TIMEOUT_SECONDS: '15',
      BLINDSIGNAL_DEVICE_TTL_DAYS: '7',
      BLINDSIGNAL_DEVICE_SWEEP_INTERVAL_SECONDS: '60',
      BLINDSIGNAL_DATABASE_URL: 'postgresql://bs:pw@db.example:5432/bs',
      BLINDSIGNAL_DATABASE_POOL_SIZE: '4',
      BLINDSIGNAL_REDIS_URL: 'rediss://default:pw@cache.example:6380',
      BLINDSIGNAL_REDIS_PREFIX: 'staging:',
      BLINDSIGNAL_REDIS_COMMAND_TIMEOUT_SECONDS: '1',
      BLINDSIGNAL_REGISTRY_SYNC_INTERVAL_SECONDS: '20',
      BLINDSIGNAL_MAX_CONNECTION_SECONDS: '3300',
      BLINDSIGNAL_MAX_CONNECTIONS: '900',
      BLINDSIGNAL_DEPENDENCY_PROBE_TIMEOUT_SECONDS: '5',
      BLINDSIGNAL_STARTUP_TIMEOUT_SECONDS: '90',
      BLINDSIGNAL_SHUTDOWN_DELAY_SECONDS: '5',
      BLINDSIGNAL_SHUTDOWN_TIMEOUT_SECONDS: '25',
      BLINDSIGNAL_AUTHENTICATION_TIMEOUT_SECONDS: '4',
      BLINDSIGNAL_MAX_UNAUTHENTICATED_PER_IP: '3',
      BLINDSIGNAL_MAX_UNAUTHENTICATED: '30',
      BLINDSIGNAL_RATE_LIMIT_CONNECTION_ATTEMPTS: '1,4',
      BLINDSIGNAL_RATE_LIMIT_AUTHENTICATION: '0.2,3',
      BLINDSIGNAL_IPV6_PREFIX_LENGTH: '56',
      BLINDSIGNAL_HTTP_HEADERS_TIMEOUT_SECONDS: '5',
      BLINDSIGNAL_MAX_MESSAGE_BYTES: '1024',
      BLINDSIGNAL_MAX_QUEUED_MESSAGES: '64',
      BLINDSIGNAL_MAX_BUFFERED_BYTES: '131072',
      BLINDSIGNAL_MAX_CONNECTIONS_PER_APP: '40',
      BLINDSIGNAL_MAX_DEVICES_PER_APP: '50',
      BLINDSIGNAL_MAX_DEVICES_PER_USER: '5',
      BLINDSIGNAL_MAX_SESSIONS_PER_APP: '60',
      BLINDSIGNAL_MAX_SESSIONS_PER_DEVICE: '3',
      BLINDSIGNAL_MAX_NAMESPACES_PER_DEVICE: '7',
      BLINDSIGNAL_MAX_PAIRING_APPROVERS: '4',
      BLINDSIGNAL_MAX_SESSION_DURATION_SECONDS: '3600',
      BLINDSIGNAL_RATE_LIMIT_DISCOVERY: '0.5,1',
      BLINDSIGNAL_RATE_LIMIT_SESSION_CREATE: '1,2',
      BLINDSIGNAL_RATE_LIMIT_PAIRING: '0.5,2',
      BLINDSIGNAL_RATE_LIMIT_PRESENCE: '0.25,4',
      BLINDSIGNAL_RATE_LIMIT_REFRESH: '0.05,2',
      BLINDSIGNAL_RATE_LIMIT_SIGNALING: '30,60',
      BLINDSIGNAL_RATE_LIMIT_RTC: '5,15',
      BLINDSIGNAL_RATE_LIMIT_RTC_ICE_CANDIDATE: '8,40',
      BLINDSIGNAL_ABUSE_ALERT_THRESHOLD: '25',
      BLINDSIGNAL_ABUSE_ALERT_WINDOW_SECONDS: '30',
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'https://otlp.example/v1/metrics',
      OTEL_METRIC_EXPORT_INTERVAL: '10000',
    });
    expect(rest).toEqual({
      development: true,
      port: 0,
      adminPort: 9191,
      adminHost: '0.0.0.0',
      logLevel: 'warn',
      registryPath: 'registry.json',
      allowedOrigins: new Set(['https://a.example', 'http://localhost:5173']),
      iceServers: [{ urls: ['stun:stun.example:3478', 'stuns:stun.example'] }],
      turn: {
        urls: ['turn:turn.example:3478', 'turns:turn.example:443?transport=tcp'],
        secret: SECRET,
        credentialTtlSeconds: 300,
      },
      token: {
        maxLifetimeSeconds: 300,
        clockSkewSeconds: 0,
        maxNamespaces: 5,
        jwks: { timeoutMs: 2_000, cacheMaxAgeMs: 60_000, cooldownMs: 10_000, maxBytes: 4_096 },
      },
      heartbeatIntervalMs: 10_000,
      closeTimeoutMs: 2_000,
      maxConnectionMs: 3_300_000,
      maxConnections: 900,
      presenceLeaseMs: 25_000,
      negotiationTimeoutMs: 15_000,
      deviceTtlMs: 7 * 86_400_000,
      deviceSweepIntervalMs: 60_000,
      registrySyncIntervalMs: 20_000,
      dependencyProbeTimeoutMs: 5_000,
      startupTimeoutMs: 90_000,
      shutdownDelayMs: 5_000,
      shutdownTimeoutMs: 25_000,
      database: { url: 'postgresql://bs:pw@db.example:5432/bs', poolSize: 4 },
      redis: {
        url: 'rediss://default:pw@cache.example:6380',
        prefix: 'staging:',
        commandTimeoutMs: 1_000,
      },
      preAuthentication: {
        authenticationTimeoutMs: 4_000,
        maxUnauthenticatedPerIp: 3,
        maxUnauthenticated: 30,
        connectionAttempts: { ratePerSecond: 1, burst: 4 },
        authenticationAttempts: { ratePerSecond: 0.2, burst: 3 },
        ipv6PrefixLength: 56,
        headersTimeoutMs: 5_000,
      },
      maxMessageBytes: 1024,
      maxQueuedMessages: 64,
      maxBufferedBytes: 131_072,
      limits: {
        quotas: {
          connections: 40,
          devices: 50,
          devicesPerUser: 5,
          sessions: 60,
          sessionsPerDevice: 3,
          namespacesPerDevice: 7,
          sessionDurationSeconds: 3600,
          pairingApprovers: 4,
        },
        rateLimits: {
          discovery: { ratePerSecond: 0.5, burst: 1 },
          session_create: { ratePerSecond: 1, burst: 2 },
          pairing: { ratePerSecond: 0.5, burst: 2 },
          presence: { ratePerSecond: 0.25, burst: 4 },
          refresh: { ratePerSecond: 0.05, burst: 2 },
          signaling: { ratePerSecond: 30, burst: 60 },
          rtc: { ratePerSecond: 5, burst: 15 },
          rtc_ice_candidate: { ratePerSecond: 8, burst: 40 },
        },
      },
      abuseAlerts: { threshold: 25, windowMs: 30_000 },
      otlp: { intervalMs: 10_000 },
    });
    expect(proxyTrust.header).toBe('cf-connecting-ip');
    expect(proxyTrust.proxies.check('10.1.2.3', 'ipv4')).toBe(true);
    expect(proxyTrust.proxies.check('::1', 'ipv6')).toBe(true);
    expect(proxyTrust.proxies.check('11.0.0.1', 'ipv4')).toBe(false);
  });

  it('exports over OTLP every 60 seconds once an endpoint is set (ADR 0038)', () => {
    expect(config(production).otlp).toBeUndefined();
    expect(
      config({ ...production, OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' }).otlp,
    ).toEqual({ intervalMs: 60_000 });
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
    ['BLINDSIGNAL_LOG_LEVEL', 'debug'],
    ['OTEL_METRIC_EXPORT_INTERVAL', '0'],
    ['BLINDSIGNAL_HEARTBEAT_INTERVAL_SECONDS', '0'],
    ['BLINDSIGNAL_CLOSE_TIMEOUT_SECONDS', '0'],
    ['BLINDSIGNAL_PRESENCE_LEASE_SECONDS', '1.5'],
    ['BLINDSIGNAL_NEGOTIATION_TIMEOUT_SECONDS', 'soon'],
    ['BLINDSIGNAL_DEVICE_TTL_DAYS', '0'],
    ['BLINDSIGNAL_AUTHENTICATION_TIMEOUT_SECONDS', '0'],
    ['BLINDSIGNAL_MAX_UNAUTHENTICATED_PER_IP', '0'],
    ['BLINDSIGNAL_MAX_UNAUTHENTICATED', '2.5'],
    ['BLINDSIGNAL_RATE_LIMIT_CONNECTION_ATTEMPTS', '5'],
    ['BLINDSIGNAL_RATE_LIMIT_AUTHENTICATION', '1,'],
    ['BLINDSIGNAL_RATE_LIMIT_REFRESH', '0,1'],
    ['BLINDSIGNAL_IPV6_PREFIX_LENGTH', '0'],
    ['BLINDSIGNAL_IPV6_PREFIX_LENGTH', '129'],
    ['BLINDSIGNAL_IPV6_PREFIX_LENGTH', '48.5'],
    ['BLINDSIGNAL_HTTP_HEADERS_TIMEOUT_SECONDS', '0'],
    ['BLINDSIGNAL_MAX_DEVICES_PER_APP', '0'],
    ['BLINDSIGNAL_MAX_DEVICES_PER_USER', '0'],
    ['BLINDSIGNAL_MAX_MESSAGE_BYTES', '0'],
    ['BLINDSIGNAL_MAX_MESSAGE_BYTES', '65537'],
    ['BLINDSIGNAL_MAX_QUEUED_MESSAGES', '1'],
    ['BLINDSIGNAL_MAX_BUFFERED_BYTES', '65535'],
    ['BLINDSIGNAL_MAX_CONNECTIONS_PER_APP', '1.5'],
    ['BLINDSIGNAL_MAX_SESSIONS_PER_APP', 'many'],
    ['BLINDSIGNAL_MAX_SESSIONS_PER_DEVICE', '-1'],
    ['BLINDSIGNAL_MAX_NAMESPACES_PER_DEVICE', '0'],
    ['BLINDSIGNAL_MAX_PAIRING_APPROVERS', '0'],
    ['BLINDSIGNAL_MAX_SESSION_DURATION_SECONDS', '-1'],
    ['BLINDSIGNAL_RATE_LIMIT_DISCOVERY', '2'],
    ['BLINDSIGNAL_RATE_LIMIT_SESSION_CREATE', '2,10,3'],
    ['BLINDSIGNAL_RATE_LIMIT_SIGNALING', '0,10'],
    ['BLINDSIGNAL_RATE_LIMIT_RTC', '10,0'],
    ['BLINDSIGNAL_RATE_LIMIT_RTC_ICE_CANDIDATE', ' 20, 50'],
    ['BLINDSIGNAL_ABUSE_ALERT_THRESHOLD', '-1'],
    ['BLINDSIGNAL_ABUSE_ALERT_WINDOW_SECONDS', '0'],
    ['BLINDSIGNAL_SHUTDOWN_DELAY_SECONDS', '-1'],
    ['BLINDSIGNAL_SHUTDOWN_TIMEOUT_SECONDS', '0'],
    ['BLINDSIGNAL_STARTUP_TIMEOUT_SECONDS', '0'],
    ['BLINDSIGNAL_REDIS_COMMAND_TIMEOUT_SECONDS', '0'],
  ])('rejects %s=%s', (name, value) => {
    expect(error({ ...production, [name]: value })).toContain(name);
  });

  describe('TURN', () => {
    it('is off by default', () => {
      expect(config(production).turn).toBeUndefined();
    });

    it('defaults the credential lifetime to 900 seconds', () => {
      expect(config(turn).turn).toEqual({
        urls: ['turn:turn.example'],
        secret: SECRET,
        credentialTtlSeconds: 900,
      });
    });

    it.each([
      ['urls without a secret', { BLINDSIGNAL_TURN_SECRET: '' }],
      ['a secret without urls', { BLINDSIGNAL_TURN_URLS: '' }],
      ['a secret of 31 bytes', { BLINDSIGNAL_TURN_SECRET: SECRET.slice(1) }],
    ])('rejects %s', (_, vars) => {
      expect(error({ ...turn, ...vars })).toContain('BLINDSIGNAL_TURN_SECRET');
    });

    it('measures the secret in bytes', () => {
      const secret = 'é'.repeat(16);
      expect(config({ ...turn, BLINDSIGNAL_TURN_SECRET: secret }).turn?.secret).toBe(secret);
    });

    it.each(['stun:turn.example', 'turn:', 'https://turn.example', 'turn:a, stun:b'])(
      'rejects the TURN URL %s',
      (urls) => {
        expect(error({ ...turn, BLINDSIGNAL_TURN_URLS: urls })).toContain('BLINDSIGNAL_TURN_URLS');
      },
    );

    it('requires the lifetime to cover the maximum token lifetime plus the skew', () => {
      expect(
        config({ ...turn, BLINDSIGNAL_TURN_CREDENTIAL_TTL_SECONDS: '660' }).turn,
      ).toMatchObject({ credentialTtlSeconds: 660 });
      for (const ttl of ['659', '0']) {
        const env = { ...turn, BLINDSIGNAL_TURN_CREDENTIAL_TTL_SECONDS: ttl };
        expect(error(env)).toContain('BLINDSIGNAL_TURN_CREDENTIAL_TTL_SECONDS');
      }
    });

    it('caps the lifetime at a day', () => {
      expect(
        config({ ...turn, BLINDSIGNAL_TURN_CREDENTIAL_TTL_SECONDS: '86400' }).turn,
      ).toMatchObject({ credentialTtlSeconds: 86_400 });
      const env = { ...turn, BLINDSIGNAL_TURN_CREDENTIAL_TTL_SECONDS: '86401' };
      expect(error(env)).toContain('BLINDSIGNAL_TURN_CREDENTIAL_TTL_SECONDS');
    });

    it('never echoes the secret', () => {
      const secret = 'short-secret-value';
      expect(error({ ...turn, BLINDSIGNAL_TURN_SECRET: secret })).not.toContain(secret);
    });
  });

  it('accepts only a postgres:// database URL, and never echoes it', () => {
    expect(
      config({ ...production, BLINDSIGNAL_DATABASE_URL: 'postgres://db/bs' }).database,
    ).toEqual({ url: 'postgres://db/bs', poolSize: 10 });
    const message = error({ ...production, BLINDSIGNAL_DATABASE_URL: 'mysql://u:secret-pw@db/bs' });
    expect(message).toContain('BLINDSIGNAL_DATABASE_URL');
    expect(message).not.toContain('secret-pw');
  });

  it('accepts only a redis:// URL, with a database, and never echoes it', () => {
    const database = { ...production, BLINDSIGNAL_DATABASE_URL: 'postgres://db/bs' };
    expect(config({ ...database, BLINDSIGNAL_REDIS_URL: 'redis://cache' }).redis).toEqual({
      url: 'redis://cache',
      prefix: 'blindsignal:',
      commandTimeoutMs: 2_000,
    });
    for (const prefix of ['', 'a b']) {
      expect(error({ ...database, BLINDSIGNAL_REDIS_PREFIX: prefix })).toContain(
        'BLINDSIGNAL_REDIS_PREFIX',
      );
    }
    expect(config(database).redis).toBeUndefined();
    const invalid = error({ ...database, BLINDSIGNAL_REDIS_URL: 'http://u:secret-pw@cache' });
    expect(invalid).toContain('BLINDSIGNAL_REDIS_URL');
    expect(invalid).not.toContain('secret-pw');
    expect(error({ ...production, BLINDSIGNAL_REDIS_URL: 'redis://cache' })).toBe(
      'BLINDSIGNAL_REDIS_URL: requires BLINDSIGNAL_DATABASE_URL',
    );
    expect(
      error({
        ...production,
        BLINDSIGNAL_SHUTDOWN_DELAY_SECONDS: '8',
        BLINDSIGNAL_SHUTDOWN_TIMEOUT_SECONDS: '8',
      }),
    ).toBe('BLINDSIGNAL_SHUTDOWN_TIMEOUT_SECONDS: must exceed BLINDSIGNAL_SHUTDOWN_DELAY_SECONDS');
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
