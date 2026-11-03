import { base64url, calculateJwkThumbprint, EmbeddedJWK, jwtVerify, type JWK } from 'jose';
import { describe, expect, it } from 'vitest';
import { DeviceKey } from './device-key.ts';

const keyPair = (curve = 'P-256') =>
  crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: curve }, false, ['sign']);

describe('DeviceKey', () => {
  it('exposes the RFC 7638 thumbprint of its public key', async () => {
    const pair = await keyPair();
    const key = await DeviceKey.from(pair);
    const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
    expect(key.thumbprint).toBe(await calculateJwkThumbprint(jwk as JWK, 'sha256'));
  });

  it('signs a proof the server accepts: its key, the nonce, and the token hash', async () => {
    const key = await DeviceKey.from(await keyPair());
    const token = 'header.payload.signature';
    const proof = await key.proof(token, 'nonce-1');
    const { payload, protectedHeader } = await jwtVerify(proof, EmbeddedJWK, {
      typ: 'blindsignal-pop+jwt',
      algorithms: ['ES256'],
    });
    expect(Object.keys(protectedHeader)).toEqual(['typ', 'alg', 'jwk']);
    expect(Object.keys(protectedHeader.jwk!)).toEqual(['crv', 'kty', 'x', 'y']);
    expect(await calculateJwkThumbprint(protectedHeader.jwk as JWK, 'sha256')).toBe(key.thumbprint);
    const digest = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)),
    );
    expect(payload).toEqual({ nonce: 'nonce-1', ath: base64url.encode(digest) });
  });

  it('signs a fresh proof each time', async () => {
    const key = await DeviceKey.from(await keyPair());
    expect(await key.proof('t', 'n')).not.toBe(await key.proof('t', 'n'));
  });

  it.each([
    ['another curve', () => keyPair('P-384')],
    ['an Ed25519 key', () => crypto.subtle.generateKey('Ed25519', false, ['sign'])],
  ])('refuses %s', async (_, generate) => {
    await expect(DeviceKey.from(await generate())).rejects.toThrow(TypeError);
  });
});
