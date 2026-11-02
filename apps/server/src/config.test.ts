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
      devices: { ttlMs: 30 * 86_400_000, maxDevices: 10_000 },
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
      BLINDSIGNAL_MAX_DEVICES_PER_APP: '50',
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
      devices: { ttlMs: 7 * 86_400_000, maxDevices: 50 },
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
    ['BLINDSIGNAL_MAX_DEVICES_PER_APP', '0'],
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
