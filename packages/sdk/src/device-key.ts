import { loadKeyPair } from './storage/key-store.ts';

const PROOF_TYPE = 'blindsignal-pop+jwt';
const encoder = new TextEncoder();

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const segment = (value: object) => base64url(encoder.encode(JSON.stringify(value)));

const sha256 = async (text: string) =>
  base64url(await crypto.subtle.digest('SHA-256', encoder.encode(text)));

interface EcPublicJwk {
  crv: string;
  kty: string;
  x: string;
  y: string;
}

/**
 * The key a device proves it holds when its tokens are bound to it with `cnf.jkt` (ADR 0041): a
 * P-256 ECDSA key pair whose private half no script can export.
 */
export class DeviceKey {
  /** The public key's JWK thumbprint (RFC 7638, SHA-256): the backend puts it in `cnf.jkt`. */
  readonly thumbprint: string;
  readonly #privateKey: CryptoKey;
  readonly #jwk: EcPublicJwk;

  private constructor(privateKey: CryptoKey, jwk: EcPublicJwk, thumbprint: string) {
    this.#privateKey = privateKey;
    this.#jwk = jwk;
    this.thumbprint = thumbprint;
  }

  /** This origin's device key: generated non-extractable on first use, then kept in IndexedDB. */
  static async load(): Promise<DeviceKey> {
    return DeviceKey.from(await loadKeyPair());
  }

  /** Wraps a P-256 ECDSA key pair held elsewhere; in a browser, load() is the way in. */
  static async from({ privateKey, publicKey }: CryptoKeyPair): Promise<DeviceKey> {
    const { crv, x, y } = await crypto.subtle.exportKey('jwk', publicKey);
    if (crv !== 'P-256' || !x || !y) {
      throw new TypeError('a device key is a P-256 ECDSA key pair');
    }
    // RFC 7638: the required members only, in lexicographic order.
    const jwk = { crv, kty: 'EC', x, y };
    return new DeviceKey(privateKey, jwk, await sha256(JSON.stringify(jwk)));
  }

  /** Proves possession for one token on the connection whose challenge sent `nonce`. */
  async proof(token: string, nonce: string): Promise<string> {
    const header = segment({ typ: PROOF_TYPE, alg: 'ES256', jwk: this.#jwk });
    const input = `${header}.${segment({ nonce, ath: await sha256(token) })}`;
    const signature = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      this.#privateKey,
      encoder.encode(input),
    );
    return `${input}.${base64url(signature)}`;
  }
}
