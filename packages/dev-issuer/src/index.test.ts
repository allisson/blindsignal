import { decodeJwt, decodeProtectedHeader, importJWK, jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';
import { DEV_PUBLIC_JWK, devApplication, devIssuer, mintDevToken } from './index.ts';

const identity = { app_id: 'notes', sub: 'u1', device_id: 'd1' };
const now = new Date('2026-11-02T00:00:00Z');
const iat = now.getTime() / 1000;

describe('mintDevToken', () => {
  it('signs a token the public key verifies, with the default claims', async () => {
    const token = await mintDevToken(identity, { now });
    const { payload, protectedHeader } = await jwtVerify(
      token,
      await importJWK(DEV_PUBLIC_JWK, 'EdDSA'),
      {
        currentDate: now,
      },
    );
    expect(protectedHeader).toEqual({ alg: 'EdDSA', kid: 'blindsignal-dev' });
    expect(payload).toEqual({
      iss: 'https://dev-issuer.blindsignal.invalid/notes',
      aud: 'blindsignal',
      sub: 'u1',
      app_id: 'notes',
      device_id: 'd1',
      namespaces: [],
      iat,
      exp: iat + 300,
      jti: expect.any(String) as string,
    });
  });

  it('mints a new jti every time', async () => {
    const [a, b] = await Promise.all([mintDevToken(identity), mintDevToken(identity)]);
    expect(decodeJwt(a).jti).not.toBe(decodeJwt(b).jti);
  });

  it('overrides and omits claims, and sets another kid', async () => {
    const token = await mintDevToken(
      { ...identity, aud: 'other', jti: undefined, namespaces: ['notes:a'] },
      { kid: 'unknown' },
    );
    const payload = decodeJwt(token);
    expect(payload.aud).toBe('other');
    expect(payload.namespaces).toEqual(['notes:a']);
    expect(payload).not.toHaveProperty('jti');
    expect(decodeProtectedHeader(token).kid).toBe('unknown');
  });
});

describe('devApplication', () => {
  it('trusts the dev public key under a per-application issuer', () => {
    expect(devApplication('notes')).toMatchObject({
      issuer: devIssuer('notes'),
      publicKeys: [DEV_PUBLIC_JWK],
      algorithms: ['EdDSA'],
    });
    expect(DEV_PUBLIC_JWK).not.toHaveProperty('d');
  });
});
