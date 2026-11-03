import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DEV_PUBLIC_JWK,
  devApplication,
  DEV_ISSUER_ORIGIN as ISSUER_ORIGIN,
} from '@blindsignal/dev-issuer';
import { DEV_ISSUER_ORIGIN, DEV_PUBLIC_KEY_X, parseRegistry, type Registry } from './registry.ts';

const t0 = new Date('2026-11-01T00:00:00Z');
const t1 = new Date('2026-11-02T00:00:00Z');

const okpKey = { kty: 'OKP', crv: 'Ed25519', x: 'abc', kid: 'k1' };
const ecKey = { kty: 'EC', crv: 'P-256', x: 'abc', y: 'def', kid: 'k2', alg: 'ES256' };

const app = (overrides: object = {}) => ({
  appId: 'notes',
  name: 'Notes',
  status: 'active',
  issuer: 'https://api.notes.example',
  audience: 'blindsignal',
  jwksUri: 'https://api.notes.example/.well-known/jwks.json',
  algorithms: ['EdDSA'],
  ...overrides,
});

const file = (...applications: object[]) => JSON.stringify({ applications });

function load(text: string, now = t0, previous?: Registry): Registry {
  const result = parseRegistry(text, { now, previous });
  if (!result.ok) throw new Error(result.error);
  return result.registry;
}

function error(text: string, previous?: Registry): string {
  const result = parseRegistry(text, { now: t1, previous });
  if (result.ok) throw new Error('expected the registry to be rejected');
  return result.error;
}

describe('parseRegistry', () => {
  it('maps an entry to an application record with defaults', () => {
    expect(load(file(app())).applications).toEqual([
      {
        appId: 'notes',
        name: 'Notes',
        status: 'active',
        issuer: 'https://api.notes.example',
        audience: 'blindsignal',
        keys: { jwksUri: 'https://api.notes.example/.well-known/jwks.json' },
        algorithms: ['EdDSA'],
        quotas: {},
        rateLimits: {},
        revokedDevices: [],
        createdAt: t0,
        updatedAt: t0,
      },
    ]);
  });

  it('accepts static public keys, overrides, and revoked devices', () => {
    const entry = app({
      jwksUri: undefined,
      publicKeys: [okpKey, ecKey],
      algorithms: ['EdDSA', 'ES256'],
      quotas: { devices: 50, sessionDurationSeconds: 3600 },
      rateLimits: { discovery: { ratePerSecond: 2, burst: 5 } },
      revokedDevices: [{ userId: 'u1', deviceId: 'd1' }],
    });
    expect(load(file(entry)).applications[0]).toMatchObject({
      keys: { publicKeys: [okpKey, ecKey] },
      quotas: { devices: 50, sessionDurationSeconds: 3600 },
      rateLimits: { discovery: { ratePerSecond: 2, burst: 5 } },
      revokedDevices: [{ userId: 'u1', deviceId: 'd1' }],
    });
  });

  it('accepts an empty registry', () => {
    expect(load(file()).applications).toEqual([]);
  });

  it.each([
    ['invalid JSON', '{', 'registry is not valid JSON'],
    ['a missing applications list', '{}', 'applications'],
    ['an unknown top-level key', JSON.stringify({ applications: [], apps: [] }), 'apps'],
    ['an unknown entry key', file(app({ revokedDevice: [] })), 'revokedDevice'],
    ['an invalid appId', file(app({ appId: 'Notes' })), 'applications.0.appId'],
    ['an unknown status', file(app({ status: 'paused' })), 'applications.0.status'],
    ['an http JWKS URI', file(app({ jwksUri: 'http://api.notes.example/jwks' })), 'jwksUri'],
    ['no keys', file(app({ jwksUri: undefined })), 'exactly one of jwksUri and publicKeys'],
    [
      'both JWKS URI and static keys',
      file(app({ publicKeys: [okpKey] })),
      'exactly one of jwksUri and publicKeys',
    ],
    [
      'a private key',
      file(app({ jwksUri: undefined, publicKeys: [{ ...okpKey, d: 'secret' }] })),
      'publicKeys.0',
    ],
    [
      'an unsupported curve',
      file(app({ jwksUri: undefined, publicKeys: [{ ...okpKey, crv: 'Ed448' }] })),
      'publicKeys.0.crv',
    ],
    [
      'a key without kid',
      file(app({ jwksUri: undefined, publicKeys: [{ ...okpKey, kid: undefined }] })),
      'publicKeys.0.kid',
    ],
    [
      'duplicate kid values',
      file(app({ jwksUri: undefined, publicKeys: [okpKey, { ...ecKey, kid: 'k1' }] })),
      'kid values must be unique',
    ],
    ['no algorithms', file(app({ algorithms: [] })), 'algorithms'],
    ['a disallowed algorithm', file(app({ algorithms: ['RS256'] })), 'algorithms.0'],
    ['a zero quota', file(app({ quotas: { sessions: 0 } })), 'quotas.sessions'],
    [
      'a zero session duration',
      file(app({ quotas: { sessionDurationSeconds: 0 } })),
      'quotas.sessionDurationSeconds',
    ],
    ['an unknown quota', file(app({ quotas: { calls: 1 } })), 'calls'],
    [
      'an unknown rate limit',
      file(app({ rateLimits: { connection: { ratePerSecond: 1, burst: 1 } } })),
      'connection',
    ],
    [
      'an invalid revoked device',
      file(app({ revokedDevices: [{ userId: 'u1', deviceId: '' }] })),
      'revokedDevices.0.deviceId',
    ],
    [
      'a duplicate appId',
      file(app(), app({ issuer: 'https://other.example' })),
      'notes: duplicate appId',
    ],
    [
      'an issuer shared by two applications',
      file(app(), app({ appId: 'vault' })),
      'vault: issuer used by another app',
    ],
  ])('rejects %s', (_, text, message) => {
    expect(error(text)).toContain(message);
  });

  it('does not echo rejected values', () => {
    const text = file(app({ jwksUri: undefined, publicKeys: [{ ...okpKey, d: 'top-secret' }] }));
    expect(error(text)).not.toContain('top-secret');
  });
});

describe('parseRegistry on reload', () => {
  it('keeps timestamps of an unchanged application and stamps a changed one', () => {
    const first = load(file(app(), app({ appId: 'vault', issuer: 'https://vault.example' })));
    const second = load(
      file(app(), app({ appId: 'vault', issuer: 'https://vault.example', status: 'suspended' })),
      t1,
      first,
    );
    expect(second.applications.map(({ createdAt, updatedAt }) => [createdAt, updatedAt])).toEqual([
      [t0, t0],
      [t0, t1],
    ]);
  });

  it('stamps an application added on reload', () => {
    const first = load(file(app()));
    const second = load(
      file(app(), app({ appId: 'vault', issuer: 'https://v.example' })),
      t1,
      first,
    );
    expect(second.applications[1]).toMatchObject({ createdAt: t1, updatedAt: t1 });
  });

  it('reactivates a suspended application', () => {
    const first = load(file(app({ status: 'suspended' })));
    expect(load(file(app()), t1, first).applications[0]?.status).toBe('active');
  });

  it.each(['active', 'suspended'])('refuses to turn a revoked application %s', (status) => {
    const first = load(file(app({ status: 'revoked' })));
    expect(error(file(app({ status })), first)).toBe(
      'notes: a revoked application cannot be reactivated',
    );
  });

  it('refuses to re-add a removed revoked application', () => {
    const revoked = load(file(app({ status: 'revoked' })));
    const removed = load(file(), t1, revoked);
    expect(removed.revoked.has('notes')).toBe(true);
    expect(error(file(app()), removed)).toContain('cannot be reactivated');
  });

  it('keeps a revoked application revoked', () => {
    const first = load(file(app({ status: 'revoked' })));
    expect(load(file(app({ status: 'revoked' })), t1, first).applications[0]?.status).toBe(
      'revoked',
    );
  });
});

describe('parseRegistry and the dev issuer', () => {
  it('keeps its copy of the dev issuer equal to packages/dev-issuer', () => {
    expect(DEV_ISSUER_ORIGIN).toBe(ISSUER_ORIGIN);
    expect(DEV_PUBLIC_KEY_X).toBe(DEV_PUBLIC_JWK.x);
  });

  it('trusts the dev issuer in development mode', () => {
    const result = parseRegistry(file(devApplication('notes')), { now: t0, development: true });
    expect(result.ok).toBe(true);
  });

  it.each([
    ['the dev application', devApplication('notes')],
    [
      'the dev key under another issuer',
      { ...devApplication('notes'), issuer: 'https://x.example' },
    ],
    ['a dev issuer with another key', app({ issuer: `${DEV_ISSUER_ORIGIN}/notes` })],
  ])('refuses %s outside development mode', (_, entry) => {
    expect(error(file(entry))).toBe('notes: the dev issuer is trusted only in development mode');
  });

  it('ships a development example that loads only in development mode', () => {
    const text = readFileSync(
      new URL('../../../../examples/registry.dev.json', import.meta.url),
      'utf8',
    );
    expect(JSON.parse(text)).toEqual({ applications: [devApplication('notes')] });
    expect(parseRegistry(text, { now: t0, development: true }).ok).toBe(true);
    expect(parseRegistry(text, { now: t0 }).ok).toBe(false);
  });
});
