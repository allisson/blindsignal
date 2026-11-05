import { createHmac, randomBytes } from 'node:crypto';

/** TURN servers and the secret shared with them (ADR 0017). */
export interface TurnPolicy {
  readonly urls: readonly string[];
  readonly secret: string;
  readonly credentialTtlSeconds: number;
}

/**
 * A TURN server entry with a credential of the TURN REST shared-secret scheme, Coturn's
 * `use-auth-secret`: valid until `<expiry>`, carrying the application ID and a random value, so
 * that no two credentials share a Coturn user and its `user-quota` (ADR 0017).
 */
export function turnServer(
  policy: TurnPolicy,
  appId: string,
  now: Date,
  nonce = randomBytes(12).toString('base64url'),
) {
  const expiry = Math.floor(now.getTime() / 1000) + policy.credentialTtlSeconds;
  const username = `${expiry}:${appId}:${nonce}`;
  // HMAC-SHA1 is the scheme's: the TURN server checks exactly this.
  const credential = createHmac('sha1', policy.secret).update(username).digest('base64');
  return { urls: [...policy.urls], username, credential };
}
