import { InMemoryCoordinationAdapter } from '@blindsignal/coordination-memory';
import { devApplication, devIssuer, mintDevToken } from '@blindsignal/dev-issuer';
import { InMemoryApplicationRepository } from '@blindsignal/storage-memory';
import { createHash } from 'node:crypto';
import {
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type JWK,
} from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TokenVerifier, type TokenVerifierOptions } from './auth.ts';
import { parseRegistry } from './registry.ts';

const now = new Date('2026-11-02T00:00:00Z');
const at = (seconds: number) => new Date(now.getTime() + seconds * 1000);
const identity = { app_id: 'notes', sub: 'u1', device_id: 'd1' };
const JWKS_URI = 'https://keys.example/jwks.json';

async function esKey(kid: string): Promise<{ privateKey: CryptoKey; jwk: JWK }> {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  return { privateKey, jwk: { ...(await exportJWK(publicKey)), kid } };
}

/** Signs any header and claims, for tokens the dev issuer cannot produce. */
function sign(claims: Record<string, unknown>, key: CryptoKey | Uint8Array, header: object) {
  return new SignJWT(claims).setProtectedHeader(header as { alg: string }).sign(key);
}

async function setup(
  entries: object[] = [devApplication('notes')],
  options: Partial<TokenVerifierOptions> = {},
) {
  const applications = new InMemoryApplicationRepository();
  const coordination = new InMemoryCoordinationAdapter({ now: () => now.getTime() });
  const load = async (list: object[]) => {
    const result = parseRegistry(JSON.stringify({ applications: list }), {
      now,
      development: true,
    });
    if (!result.ok) throw new Error(result.error);
    await applications.replaceAll(result.registry.applications);
  };
  await load(entries);
  const verifier = new TokenVerifier({
    applications,
    coordination,
    maxLifetimeSeconds: 600,
    clockSkewSeconds: 60,
    maxNamespaces: 100,
    startedAt: at(-60),
    now: () => now,
    ...options,
  });
  return { verifier, coordination, load };
}

/** A device key: its private half signs proofs, and `jkt` goes in the token's `cnf`. */
async function deviceKey(alg: 'ES256' | 'EdDSA' = 'ES256') {
  const { privateKey, publicKey } = await generateKeyPair(alg, { extractable: true });
  const jwk = await exportJWK(publicKey);
  return { alg, privateKey, jwk, jkt: await calculateJwkThumbprint(jwk, 'sha256') };
}

type DeviceKey = Awaited<ReturnType<typeof deviceKey>>;
const NONCE = 'n'.repeat(43);
const hash = (token: string) => createHash('sha256').update(token).digest('base64url');

/** A proof of possession of `key` for `token` on the connection that sent `NONCE` (ADR 0041). */
function prove(
  token: string,
  key: DeviceKey,
  { claims = {}, header = {} }: { claims?: object; header?: object } = {},
) {
  return sign({ nonce: NONCE, ath: hash(token), ...claims }, key.privateKey, {
    alg: key.alg,
    typ: 'blindsignal-pop+jwt',
    jwk: key.jwk,
    ...header,
  });
}

describe('TokenVerifier', () => {
  it('accepts a valid token and returns the application-scoped context', async () => {
    const { verifier } = await setup();
    const token = await mintDevToken({ ...identity, namespaces: ['notes:a'] }, { now });
    const result = await verifier.verify(token);
    expect(result.ok && result.token.context).toEqual({
      appId: 'notes',
      userId: 'u1',
      deviceId: 'd1',
      namespaces: ['notes:a'],
      tokenExpiresAt: at(300),
    });
    expect(result.ok && result.token.application.appId).toBe('notes');
  });

  it('returns the permissions claim, when present, in the context (ADR 0040)', async () => {
    const { verifier } = await setup();
    const permissions = { 'notes:a': ['session.accept'] };
    const token = await mintDevToken(
      { ...identity, namespaces: ['notes:a', 'notes:b'], permissions },
      { now },
    );
    const result = await verifier.verify(token);
    expect(result.ok && result.token.context.permissions).toEqual(permissions);
  });

  describe('proof of possession (ADR 0041)', () => {
    const bound = (key: DeviceKey) => mintDevToken({ ...identity, cnf: { jkt: key.jkt } }, { now });

    it.each(['ES256', 'EdDSA'] as const)(
      'accepts a bound token with an %s proof, and keeps the thumbprint',
      async (alg) => {
        const { verifier } = await setup();
        const key = await deviceKey(alg);
        const token = await bound(key);
        const result = await verifier.verify(token, {
          nonce: NONCE,
          proof: await prove(token, key),
        });
        expect(result.ok && result.token.context.keyThumbprint).toBe(key.jkt);
      },
    );

    const rejected: [string, (token: string, key: DeviceKey) => Promise<string | undefined>][] = [
      ['no proof', () => Promise.resolve(undefined)],
      ['a proof for another nonce', (token, key) => prove(token, key, { claims: { nonce: 'x' } })],
      ['a proof for another token', (_, key) => prove('other', key)],
      ['a proof without ath', (token, key) => prove(token, key, { claims: { ath: undefined } })],
      ['a proof by another key', async (token) => prove(token, await deviceKey())],
      [
        'a proof whose header names another key than the signer',
        async (token, key) => prove(token, key, { header: { jwk: (await deviceKey()).jwk } }),
      ],
      ['a proof of another type', (token, key) => prove(token, key, { header: { typ: 'JWT' } })],
      [
        'a proof whose header holds a private key',
        async (token, key) =>
          prove(token, key, { header: { jwk: await exportJWK(key.privateKey) } }),
      ],
      ['a proof that is not a JWT', () => Promise.resolve('not.a.jwt')],
    ];
    it.each(rejected)('rejects a bound token with %s, without burning it', async (_, proof) => {
      const { verifier } = await setup();
      const key = await deviceKey();
      const token = await bound(key);
      expect(
        await verifier.verify(token, { nonce: NONCE, proof: await proof(token, key) }),
      ).toEqual({ ok: false, code: 'invalid_token' });
      const valid = await verifier.verify(token, { nonce: NONCE, proof: await prove(token, key) });
      expect(valid.ok).toBe(true);
    });

    it('rejects a cnf claim without jkt', async () => {
      const { verifier } = await setup();
      const key = await deviceKey();
      const token = await mintDevToken({ ...identity, cnf: { jwk: key.jwk } }, { now });
      expect(
        await verifier.verify(token, { nonce: NONCE, proof: await prove(token, key) }),
      ).toEqual({ ok: false, code: 'invalid_token' });
    });

    it('rejects an unbound token only when the application requires the binding', async () => {
      const { verifier, load } = await setup();
      const key = await deviceKey();
      const token = await mintDevToken(identity, { now });
      const result = await verifier.verify(token, { nonce: NONCE, proof: await prove(token, key) });
      expect(result.ok && result.token.context).not.toHaveProperty('keyThumbprint');
      await load([{ ...devApplication('notes'), requireProofOfPossession: true }]);
      expect(await verifier.verify(await mintDevToken(identity, { now }))).toEqual({
        ok: false,
        code: 'invalid_token',
      });
      const boundToken = await bound(key);
      const proof = await prove(boundToken, key);
      expect((await verifier.verify(boundToken, { nonce: NONCE, proof })).ok).toBe(true);
    });
  });

  describe('rejects with invalid_token', () => {
    const cases: [string, Parameters<typeof mintDevToken>[0], Date?][] = [
      ['an unknown issuer', { ...identity, iss: 'https://unknown.example' }],
      ['a non-string issuer', { ...identity, iss: undefined }],
      ['a wrong audience', { ...identity, aud: 'other-service' }],
      [
        'an app_id that is not the issuer application',
        { ...identity, iss: devIssuer('notes'), app_id: 'other' },
      ],
      ['a missing jti', { ...identity, jti: undefined }],
      ['a missing namespaces claim', { ...identity, namespaces: undefined }],
      ['a malformed sub', { ...identity, sub: '' }],
      ['a malformed namespace', { ...identity, namespaces: ['not a namespace'] }],
      ['a namespace of another application', { ...identity, namespaces: ['other:a'] }],
      [
        'permissions for a namespace the token does not list',
        { ...identity, namespaces: ['notes:a'], permissions: { 'notes:b': [] } },
      ],
      [
        'an unknown permission',
        { ...identity, namespaces: ['notes:a'], permissions: { 'notes:a': ['session.signal'] } },
      ],
      ['a permissions claim that is not a map', { ...identity, permissions: ['session.create'] }],
      [
        'a lifetime above the maximum',
        { ...identity, exp: Math.floor(now.getTime() / 1000) + 601 },
      ],
      ['a future nbf beyond the skew', { ...identity, nbf: Math.floor(now.getTime() / 1000) + 61 }],
      ['an iat in the future beyond the skew', identity, at(61)],
      ['an iat before the server started', identity, at(-61)],
    ];
    it.each(cases)('%s', async (_, claims, issuedAt = now) => {
      const { verifier } = await setup();
      expect(await verifier.verify(await mintDevToken(claims, { now: issuedAt }))).toEqual({
        ok: false,
        code: 'invalid_token',
      });
    });

    it('a malformed token', async () => {
      const { verifier } = await setup();
      expect((await verifier.verify('not.a.jwt')).ok).toBe(false);
      expect(await verifier.verify('')).toEqual({ ok: false, code: 'invalid_token' });
    });

    it('a bad signature', async () => {
      const { verifier } = await setup();
      const [header, , signature] = (await mintDevToken(identity, { now })).split('.');
      const [, payload] = (await mintDevToken({ ...identity, sub: 'u2' }, { now })).split('.');
      expect(await verifier.verify(`${header}.${payload}.${signature}`)).toEqual({
        ok: false,
        code: 'invalid_token',
      });
    });

    it('an algorithm outside the allowlist', async () => {
      const { verifier } = await setup();
      const claims = { ...identity, iss: devIssuer('notes'), aud: 'blindsignal', jti: 'j1' };
      const secret = new Uint8Array(32);
      const token = await sign(claims, secret, { alg: 'HS256', kid: 'blindsignal-dev' });
      expect(await verifier.verify(token)).toEqual({ ok: false, code: 'invalid_token' });
    });

    it('an algorithm the application does not allow', async () => {
      const { privateKey, jwk } = await esKey('es');
      const app = { ...devApplication('notes'), publicKeys: [jwk], algorithms: ['EdDSA'] };
      const { verifier } = await setup([app]);
      const iat = Math.floor(now.getTime() / 1000);
      const claims = { ...identity, iss: devIssuer('notes'), aud: 'blindsignal', namespaces: [] };
      const token = await sign({ ...claims, iat, exp: iat + 60, jti: 'j1' }, privateKey, {
        alg: 'ES256',
        kid: 'es',
      });
      expect(await verifier.verify(token)).toEqual({ ok: false, code: 'invalid_token' });
    });

    it('a missing kid', async () => {
      const { privateKey, jwk } = await esKey('es');
      const { verifier } = await setup([
        { ...devApplication('notes'), publicKeys: [jwk], algorithms: ['ES256'] },
      ]);
      const iat = Math.floor(now.getTime() / 1000);
      const claims = { ...identity, iss: devIssuer('notes'), aud: 'blindsignal', namespaces: [] };
      const token = await sign({ ...claims, iat, exp: iat + 60, jti: 'j1' }, privateKey, {
        alg: 'ES256',
      });
      expect(await verifier.verify(token)).toEqual({ ok: false, code: 'invalid_token' });
    });

    it('an unknown kid', async () => {
      const { verifier } = await setup();
      const token = await mintDevToken(identity, { now, kid: 'unknown' });
      expect(await verifier.verify(token)).toEqual({ ok: false, code: 'invalid_token' });
    });

    it('more namespaces than the maximum', async () => {
      const { verifier } = await setup(undefined, { maxNamespaces: 2 });
      const namespaces = ['notes:a', 'notes:b', 'notes:c'];
      const token = await mintDevToken({ ...identity, namespaces }, { now });
      expect(await verifier.verify(token)).toEqual({ ok: false, code: 'invalid_token' });
    });

    it('a replayed jti', async () => {
      const { verifier } = await setup();
      const token = await mintDevToken(identity, { now });
      expect((await verifier.verify(token)).ok).toBe(true);
      expect(await verifier.verify(token)).toEqual({ ok: false, code: 'invalid_token' });
    });
  });

  it('accepts the limits themselves: maximum lifetime, skew on iat, exp, and nbf', async () => {
    const { verifier } = await setup();
    const iat = Math.floor(now.getTime() / 1000);
    const tokens = await Promise.all([
      mintDevToken({ ...identity, exp: iat + 600 }, { now }),
      mintDevToken(identity, { now: at(60) }),
      mintDevToken({ ...identity, exp: iat - 30 }, { now: at(-50) }),
      mintDevToken({ ...identity, nbf: iat + 60 }, { now }),
      mintDevToken(identity, { now: at(-60) }),
    ]);
    for (const token of tokens) expect((await verifier.verify(token)).ok).toBe(true);
  });

  it('rejects an expired token with token_expired', async () => {
    const { verifier } = await setup();
    const token = await mintDevToken(
      { ...identity, exp: Math.floor(now.getTime() / 1000) - 61 },
      { now: at(-60) },
    );
    expect(await verifier.verify(token)).toEqual({ ok: false, code: 'token_expired' });
  });

  it.each(['suspended', 'revoked'])('rejects a %s application', async (status) => {
    const { verifier } = await setup([{ ...devApplication('notes'), status }]);
    expect(await verifier.verify(await mintDevToken(identity, { now }))).toEqual({
      ok: false,
      code: 'application_unavailable',
    });
  });

  it('reports the status only for a verified token', async () => {
    const { verifier } = await setup([{ ...devApplication('notes'), status: 'suspended' }]);
    const token = await mintDevToken({ ...identity, aud: 'other-service' }, { now });
    expect(await verifier.verify(token)).toEqual({ ok: false, code: 'invalid_token' });
  });

  it('rejects a revoked device, by user and device together', async () => {
    const revokedDevices = [{ userId: 'u1', deviceId: 'd1' }];
    const { verifier } = await setup([{ ...devApplication('notes'), revokedDevices }]);
    expect(await verifier.verify(await mintDevToken(identity, { now }))).toEqual({
      ok: false,
      code: 'device_revoked',
    });
    const otherUser = await mintDevToken({ ...identity, sub: 'u2' }, { now });
    expect((await verifier.verify(otherUser)).ok).toBe(true);
  });

  it('claims the jti last, until exp plus skew', async () => {
    const { verifier, coordination, load } = await setup([
      { ...devApplication('notes'), status: 'suspended' },
    ]);
    const claim = vi.spyOn(coordination, 'claimJti');
    const token = await mintDevToken({ ...identity, jti: 'j1' }, { now });
    expect((await verifier.verify(token)).ok).toBe(false);
    expect(claim).not.toHaveBeenCalled();
    await load([devApplication('notes')]);
    expect((await verifier.verify(token)).ok).toBe(true);
    expect(claim).toHaveBeenCalledWith(devIssuer('notes'), 'j1', 360_000);
  });

  it('follows a static key rotation on reload', async () => {
    const { privateKey, jwk } = await esKey('es');
    const { verifier, load } = await setup();
    const devToken = await mintDevToken(identity, { now });
    await load([{ ...devApplication('notes'), publicKeys: [jwk], algorithms: ['ES256'] }]);
    expect((await verifier.verify(devToken)).ok).toBe(false);
    const iat = Math.floor(now.getTime() / 1000);
    const claims = { ...identity, iss: devIssuer('notes'), aud: 'blindsignal', namespaces: [] };
    const token = await sign({ ...claims, iat, exp: iat + 60, jti: 'j1' }, privateKey, {
      alg: 'ES256',
      kid: 'es',
    });
    expect((await verifier.verify(token)).ok).toBe(true);
  });

  describe('with a remote key set', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    async function remote() {
      vi.useFakeTimers({ toFake: ['Date'], now });
      const first = await esKey('k1');
      const second = await esKey('k2');
      let published = [first.jwk];
      const fetch = vi.fn((url: string) => {
        expect(url).toBe(JWKS_URI);
        return Promise.resolve(Response.json({ keys: published }));
      });
      const app = {
        appId: 'notes',
        name: 'Notes',
        status: 'active',
        audience: 'blindsignal',
        issuer: 'https://api.notes.example',
        jwksUri: JWKS_URI,
        algorithms: ['ES256'],
      };
      const { verifier } = await setup([app], { jwks: { fetch } });
      const mint = async (key: CryptoKey, kid: string) => {
        const iat = Math.floor(Date.now() / 1000);
        const claims = { ...identity, iss: app.issuer, aud: 'blindsignal', namespaces: [] };
        return sign({ ...claims, iat, exp: iat + 60, jti: crypto.randomUUID() }, key, {
          alg: 'ES256',
          kid,
        });
      };
      return {
        verifier,
        fetch,
        first,
        second,
        mint,
        rotate: () => (published = [first.jwk, second.jwk]),
      };
    }

    it('fetches once and serves later tokens from the cache', async () => {
      const { verifier, fetch, first, mint } = await remote();
      expect((await verifier.verify(await mint(first.privateKey, 'k1'))).ok).toBe(true);
      expect((await verifier.verify(await mint(first.privateKey, 'k1'))).ok).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('limits refetches on an unknown kid to one per cooldown, then picks up a rotation', async () => {
      const { verifier, fetch, first, second, mint, rotate } = await remote();
      expect((await verifier.verify(await mint(first.privateKey, 'k1'))).ok).toBe(true);
      rotate();
      for (let attempt = 0; attempt < 3; attempt++) {
        const result = await verifier.verify(await mint(second.privateKey, 'k2'));
        expect(result).toEqual({ ok: false, code: 'invalid_token' });
      }
      // An unknown kid is no failed fetch: the cached keys still verify.
      expect((await verifier.verify(await mint(first.privateKey, 'k1'))).ok).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(1);
      vi.setSystemTime(at(30));
      expect((await verifier.verify(await mint(second.privateKey, 'k2'))).ok).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('waits a cooldown after a failed fetch, then fetches again', async () => {
      const { verifier, fetch, first, mint } = await remote();
      fetch.mockResolvedValueOnce(new Response('down', { status: 503 }));
      for (let attempt = 0; attempt < 3; attempt++) {
        const result = await verifier.verify(await mint(first.privateKey, 'k1'));
        expect(result).toEqual({ ok: false, code: 'invalid_token' });
      }
      expect(fetch).toHaveBeenCalledTimes(1);
      vi.setSystemTime(at(30));
      expect((await verifier.verify(await mint(first.privateKey, 'k1'))).ok).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('rejects when the key set cannot be fetched', async () => {
      const { verifier, fetch, first, mint } = await remote();
      fetch.mockResolvedValueOnce(new Response('down', { status: 503 }));
      expect(await verifier.verify(await mint(first.privateKey, 'k1'))).toEqual({
        ok: false,
        code: 'invalid_token',
      });
    });
  });
});
