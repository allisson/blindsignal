import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.ts';

describe('loadConfig', () => {
  it('defaults to production and the ADR 0006 token profile', () => {
    expect(loadConfig({})).toEqual({
      ok: true,
      config: {
        development: false,
        token: { maxLifetimeSeconds: 600, clockSkewSeconds: 60, maxNamespaces: 100 },
      },
    });
  });

  it('reads every variable', () => {
    const result = loadConfig({
      BLINDSIGNAL_ENV: 'development',
      BLINDSIGNAL_TOKEN_MAX_LIFETIME_SECONDS: '300',
      BLINDSIGNAL_TOKEN_CLOCK_SKEW_SECONDS: '0',
      BLINDSIGNAL_TOKEN_MAX_NAMESPACES: '5',
    });
    expect(result).toEqual({
      ok: true,
      config: {
        development: true,
        token: { maxLifetimeSeconds: 300, clockSkewSeconds: 0, maxNamespaces: 5 },
      },
    });
  });

  it('names invalid variables without their values', () => {
    const result = loadConfig({
      BLINDSIGNAL_ENV: 'staging',
      BLINDSIGNAL_TOKEN_MAX_LIFETIME_SECONDS: '0',
      BLINDSIGNAL_TOKEN_MAX_NAMESPACES: 'many',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('BLINDSIGNAL_ENV');
    expect(result.error).toContain('BLINDSIGNAL_TOKEN_MAX_LIFETIME_SECONDS');
    expect(result.error).toContain('BLINDSIGNAL_TOKEN_MAX_NAMESPACES');
    expect(result.error).not.toContain('staging');
    expect(result.error).not.toContain('many');
  });
});
