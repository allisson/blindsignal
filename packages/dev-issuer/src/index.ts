import { importJWK, SignJWT } from 'jose';

// TEST KEY. Its private half is public in this repository: never trust it outside development.
// The server refuses a registry entry with this key or a dev issuer unless it runs in development
// mode, and keeps its own copy of the public half (ADR 0002 forbids importing this package).
const DEV_PRIVATE_JWK = {
  kty: 'OKP',
  crv: 'Ed25519',
  x: 'wAzWXTlkeTKt5gt4V5mhStDncwJrxy3TTMKI-uoSCSg',
  d: 'JjYmcEYsv1xfWV9t2o4AYZaB1v-2LyF-Xesy0xTj0eU',
} as const;

export const DEV_KID = 'blindsignal-dev';

export const DEV_PUBLIC_JWK = {
  kty: DEV_PRIVATE_JWK.kty,
  crv: DEV_PRIVATE_JWK.crv,
  x: DEV_PRIVATE_JWK.x,
  kid: DEV_KID,
} as const;

/** The `.invalid` TLD never resolves, so a dev issuer can never be fetched or confused. */
export const DEV_ISSUER_ORIGIN = 'https://dev-issuer.blindsignal.invalid';

/** One issuer per application, since each issuer maps to exactly one application. */
export function devIssuer(appId: string): string {
  return `${DEV_ISSUER_ORIGIN}/${appId}`;
}

/** A registry file entry trusting the dev issuer for `appId`. */
export function devApplication(appId: string) {
  return {
    appId,
    name: `${appId} (development)`,
    status: 'active',
    issuer: devIssuer(appId),
    audience: 'blindsignal',
    publicKeys: [DEV_PUBLIC_JWK],
    algorithms: ['EdDSA'],
  };
}

export interface DevClaims {
  iss: string;
  aud: string;
  sub: string;
  app_id: string;
  device_id: string;
  namespaces: string[];
  iat: number;
  exp: number;
  nbf: number;
  jti: string;
  [claim: string]: unknown;
}

const signingKey = importJWK(DEV_PRIVATE_JWK, 'EdDSA');

/**
 * Mints a token for `app_id`, with a fresh `jti` and a 5-minute lifetime from `now`. Any claim
 * may be overridden; setting one to `undefined` leaves it out, for negative tests.
 */
export async function mintDevToken(
  claims: Partial<DevClaims> & Pick<DevClaims, 'app_id' | 'sub' | 'device_id'>,
  { now = new Date(), kid = DEV_KID }: { now?: Date; kid?: string } = {},
): Promise<string> {
  const iat = Math.floor(now.getTime() / 1000);
  const payload = {
    iss: devIssuer(claims.app_id),
    aud: 'blindsignal',
    namespaces: [],
    iat,
    exp: iat + 300,
    jti: crypto.randomUUID(),
    ...claims,
  };
  return new SignJWT(payload).setProtectedHeader({ alg: 'EdDSA', kid }).sign(await signingKey);
}
