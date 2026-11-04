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

  it('signs a pairing approval the server accepts, valid for 5 minutes', async () => {
    const key = await DeviceKey.from(await keyPair());
    const device = {
      pairingId: 'p1',
      namespace: 'notes:a',
      userId: 'alice',
      deviceId: 'tablet',
      jkt: 'new-key',
    };
    const before = Math.floor(Date.now() / 1000);
    const approval = await key.approval(device);
    const { payload, protectedHeader } = await jwtVerify(approval, EmbeddedJWK, {
      typ: 'blindsignal-pairing+jwt',
      algorithms: ['ES256'],
    });
    expect(Object.keys(protectedHeader)).toEqual(['typ', 'alg', 'jwk']);
    expect(await calculateJwkThumbprint(protectedHeader.jwk as JWK, 'sha256')).toBe(key.thumbprint);
    const { exp, ...claims } = payload;
    expect(claims).toEqual({
      pairing_id: 'p1',
      namespace: 'notes:a',
      sub: 'alice',
      device_id: 'tablet',
      jkt: 'new-key',
    });
    expect(exp).toBeGreaterThanOrEqual(before + 300);
    expect(exp).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 300);
  });

  it('signs a fresh proof each time', async () => {
    const key = await DeviceKey.from(await keyPair());
    expect(await key.proof('t', 'n')).not.toBe(await key.proof('t', 'n'));
  });

  it.each([
    ['another curve', () => keyPair('P-384')],
    ['an Ed25519 key', () => crypto.subtle.generateKey('Ed25519', false, ['sign'])],
    [
      'an extractable key',
      () => crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']),
    ],
    [
      'an ECDH key',
      () => crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']),
    ],
    [
      'a pair in the wrong order',
      async () => {
        const { privateKey, publicKey } = await keyPair();
        return { privateKey: publicKey, publicKey: privateKey };
      },
    ],
    [
      'a private key as the public one',
      async () => {
        const { privateKey } = await keyPair();
        return { privateKey, publicKey: privateKey };
      },
    ],
    [
      'an ECDH public key',
      async () => ({
        privateKey: (await keyPair()).privateKey,
        publicKey: (
          await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
            'deriveBits',
          ])
        ).publicKey,
      }),
    ],
  ])('refuses %s', async (_, generate) => {
    await expect(DeviceKey.from(await generate())).rejects.toThrow(TypeError);
  });
});
