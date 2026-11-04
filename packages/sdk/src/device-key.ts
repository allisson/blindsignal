import { loadKeyPair } from './storage/key-store.ts';

const PROOF_TYPE = 'blindsignal-pop+jwt';
const APPROVAL_TYPE = 'blindsignal-pairing+jwt';
/** How long a backend accepts an approval: the token lifetime it is traded for. */
const APPROVAL_LIFETIME_S = 300;
const encoder = new TextEncoder();

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const segment = (value: object) => base64url(encoder.encode(JSON.stringify(value)));

const sha256 = async (text: string) =>
  base64url(await crypto.subtle.digest('SHA-256', encoder.encode(text)));

/** The device a pairing approval vouches for, as `pairing.request` names it (ADR 0042). */
export interface ApprovedDevice {
  pairingId: string;
  namespace: string;
  userId: string;
  deviceId: string;
  /** The new device's key thumbprint, its token's `cnf.jkt`. */
  jkt: string;
}

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
    return this.#sign(PROOF_TYPE, { nonce, ath: await sha256(token) });
  }

  /** Approves a new device of the same user, for its backend to grant the namespace (ADR 0042). */
  approval({ pairingId, namespace, userId, deviceId, jkt }: ApprovedDevice): Promise<string> {
    const exp = Math.floor(Date.now() / 1000) + APPROVAL_LIFETIME_S;
    const claims = { pairing_id: pairingId, namespace, sub: userId, device_id: deviceId, jkt, exp };
    return this.#sign(APPROVAL_TYPE, claims);
  }

  async #sign(typ: string, claims: object): Promise<string> {
    const input = `${segment({ typ, alg: 'ES256', jwk: this.#jwk })}.${segment(claims)}`;
    const signature = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      this.#privateKey,
      encoder.encode(input),
    );
    return `${input}.${base64url(signature)}`;
  }
}
