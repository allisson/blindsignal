import type {
  ApplicationRecord,
  ApplicationRepository,
  ConnectionContext,
  CoordinationAdapter,
  IssuerKeys,
} from '@blindsignal/core';
import { createHash } from 'node:crypto';
import { deviceId, namespaceId, userId } from '@blindsignal/protocol';
import {
  calculateJwkThumbprint,
  createLocalJWKSet,
  createRemoteJWKSet,
  customFetch,
  decodeJwt,
  decodeProtectedHeader,
  EmbeddedJWK,
  errors,
  jwtVerify,
  type FetchImplementation,
  type JWK,
  type JWTVerifyGetKey,
} from 'jose';
import { z } from 'zod';

const REQUIRED_CLAIMS = [
  'iss',
  'aud',
  'sub',
  'app_id',
  'device_id',
  'iat',
  'exp',
  'jti',
  'namespaces',
];

const claims = z.object({
  sub: userId,
  app_id: z.string(),
  device_id: deviceId,
  iat: z.number(),
  exp: z.number(),
  jti: z.string().min(1),
  namespaces: z.array(namespaceId),
  permissions: z
    .record(namespaceId, z.array(z.enum(['session.create', 'session.accept', 'pairing.approve'])))
    .optional(),
  pairing: z.array(namespaceId).optional(),
  cnf: z.object({ jkt: z.string().min(1) }).optional(),
});

const PROOF_TYPE = 'blindsignal-pop+jwt';

/** The connection's challenge, and the proof sent with the token, if any (ADR 0041). */
export interface Possession {
  readonly nonce: string;
  readonly proof?: string | undefined;
}

/**
 * The proof is signed by the key `jkt` names, for this connection's nonce and this token, in the
 * shape of a DPoP proof (RFC 9449 §4.2) without its HTTP claims.
 */
async function proves(token: string, jkt: string, possession?: Possession): Promise<boolean> {
  if (possession?.proof === undefined) return false;
  try {
    // EmbeddedJWK refuses a private or symmetric key in the header.
    const { payload, protectedHeader } = await jwtVerify(possession.proof, EmbeddedJWK, {
      typ: PROOF_TYPE,
      algorithms: ['ES256', 'EdDSA'],
    });
    return (
      payload.nonce === possession.nonce &&
      payload.ath === createHash('sha256').update(token).digest('base64url') &&
      (await calculateJwkThumbprint(protectedHeader.jwk as JWK, 'sha256')) === jkt
    );
  } catch {
    return false;
  }
}

export interface TokenVerifierOptions {
  readonly applications: Pick<ApplicationRepository, 'getByIssuer'>;
  readonly coordination: Pick<CoordinationAdapter, 'claimJti'>;
  readonly maxLifetimeSeconds: number;
  readonly clockSkewSeconds: number;
  readonly maxNamespaces: number;
  /** Tokens issued before it are rejected, since `jti` tracking does not survive a restart. */
  readonly startedAt: Date;
  readonly now?: () => Date;
  /** Remote key set fetching, spec §5.3; the defaults are jose's. */
  readonly jwks?: {
    readonly timeoutMs?: number;
    readonly cacheMaxAgeMs?: number;
    readonly cooldownMs?: number;
    readonly fetch?: FetchImplementation;
  };
}

/** A verified token: the connection context minus what the protocol layer adds. */
export interface VerifiedToken {
  readonly application: ApplicationRecord;
  readonly context: Omit<ConnectionContext, 'protocolVersion'>;
}

export type VerifyFailure =
  'invalid_token' | 'token_expired' | 'application_unavailable' | 'device_revoked';

/**
 * Why a device of the application may not use the service, or undefined when it may. An
 * application missing from the registry is unavailable.
 */
export function unavailability(
  application: ApplicationRecord | undefined,
  device: { readonly userId: string; readonly deviceId: string },
): 'application_unavailable' | 'device_revoked' | undefined {
  if (application?.status !== 'active') return 'application_unavailable';
  const revoked = application.revokedDevices.some(
    (d) => d.userId === device.userId && d.deviceId === device.deviceId,
  );
  return revoked ? 'device_revoked' : undefined;
}

export type VerifyResult =
  | { readonly ok: true; readonly token: VerifiedToken }
  | { readonly ok: false; readonly code: VerifyFailure };

const fail = (code: VerifyFailure): VerifyResult => ({ ok: false, code });

/**
 * Verifies an application-issued access token (spec §5.3, ADR 0006). Checks run cheapest and
 * least revealing first, and the `jti` is claimed last, so a rejected token never burns it.
 */
export class TokenVerifier {
  readonly #options: TokenVerifierOptions;
  readonly #now: () => Date;
  /** One key set per issuer, kept across reloads while its key configuration is unchanged. */
  readonly #keySets = new Map<
    string,
    { readonly config: string; readonly getKey: JWTVerifyGetKey }
  >();

  constructor(options: TokenVerifierOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
  }

  async verify(token: string, possession?: Possession): Promise<VerifyResult> {
    const { clockSkewSeconds: skew, maxLifetimeSeconds, maxNamespaces } = this.#options;

    // 1. Header and issuer, unverified, only to pick the application and its keys. The algorithm
    // allowlist is the application's, enforced by jwtVerify.
    let issuer: unknown;
    try {
      const header = decodeProtectedHeader(token);
      if (typeof header.kid !== 'string') {
        return fail('invalid_token');
      }
      issuer = decodeJwt(token).iss;
    } catch {
      return fail('invalid_token');
    }
    if (typeof issuer !== 'string') return fail('invalid_token');
    const application = await this.#options.applications.getByIssuer(issuer);
    if (application === undefined) return fail('invalid_token');

    // 2. Signature, issuer, audience, time claims, and claim presence.
    const now = this.#now();
    let payload: Record<string, unknown>;
    try {
      ({ payload } = await jwtVerify(token, this.#keySet(application), {
        issuer: application.issuer,
        audience: application.audience,
        algorithms: [...application.algorithms],
        currentDate: now,
        clockTolerance: skew,
        requiredClaims: REQUIRED_CLAIMS,
      }));
    } catch (error) {
      return fail(error instanceof errors.JWTExpired ? 'token_expired' : 'invalid_token');
    }

    // 3. Claims against the application.
    const parsed = claims.safeParse(payload);
    if (!parsed.success) return fail('invalid_token');
    const { sub, app_id, device_id, iat, exp, jti, namespaces, permissions, pairing, cnf } =
      parsed.data;
    const prefix = `${application.appId}:`;
    if (
      app_id !== application.appId ||
      namespaces.length > maxNamespaces ||
      !namespaces.every((namespace) => namespace.startsWith(prefix)) ||
      (pairing ?? []).length > maxNamespaces ||
      !(pairing ?? []).every((namespace) => namespace.startsWith(prefix)) ||
      // Permissions only narrow the token's own namespaces (ADR 0040).
      !Object.keys(permissions ?? {}).every((namespace) => namespaces.includes(namespace))
    ) {
      return fail('invalid_token');
    }

    // 4. Lifetime. `iat` has one-second resolution, so a token from the start's own second passes.
    const nowSeconds = now.getTime() / 1000;
    if (
      exp - iat > maxLifetimeSeconds ||
      iat > nowSeconds + skew ||
      iat < Math.floor(this.#options.startedAt.getTime() / 1000)
    ) {
      return fail('invalid_token');
    }

    // 5. A token bound to a device key needs its proof; the application may require the binding.
    if (
      cnf === undefined
        ? application.requireProofOfPossession === true
        : !(await proves(token, cnf.jkt, possession))
    ) {
      return fail('invalid_token');
    }

    // 6–7. Only a verified token learns the application's or device's status.
    const unavailable = unavailability(application, { userId: sub, deviceId: device_id });
    if (unavailable !== undefined) return fail(unavailable);

    // 8. Single use, tracked until the token can no longer pass the `exp` check.
    const ttlMs = (exp + skew) * 1000 - now.getTime();
    if (!(await this.#options.coordination.claimJti(application.issuer, jti, ttlMs))) {
      return fail('invalid_token');
    }

    return {
      ok: true,
      token: {
        application,
        context: {
          appId: application.appId,
          userId: sub,
          deviceId: device_id,
          namespaces,
          ...(permissions === undefined ? {} : { permissions }),
          ...(pairing === undefined ? {} : { pairing }),
          ...(cnf === undefined ? {} : { keyThumbprint: cnf.jkt }),
          tokenExpiresAt: new Date(exp * 1000),
        },
      },
    };
  }

  #keySet({ issuer, keys }: ApplicationRecord): JWTVerifyGetKey {
    const config = JSON.stringify(keys);
    const cached = this.#keySets.get(issuer);
    if (cached?.config === config) return cached.getKey;
    const getKey = this.#createKeySet(keys);
    this.#keySets.set(issuer, { config, getKey });
    return getKey;
  }

  #createKeySet(keys: IssuerKeys): JWTVerifyGetKey {
    if ('publicKeys' in keys) return createLocalJWKSet({ keys: keys.publicKeys as JWK[] });
    const { timeoutMs, cacheMaxAgeMs, cooldownMs = 30_000, fetch } = this.#options.jwks ?? {};
    const remote = createRemoteJWKSet(new URL(keys.jwksUri), {
      timeoutDuration: timeoutMs,
      cacheMaxAge: cacheMaxAgeMs,
      cooldownDuration: cooldownMs,
      [customFetch]: fetch,
    });
    // jose starts its cooldown only after a fetch succeeds: while the issuer's endpoint fails,
    // every token would fetch again (spec §5.3).
    let failedAt = -Infinity;
    return async (header, token) => {
      if (Date.now() - failedAt < cooldownMs) throw new errors.JWKSNoMatchingKey();
      try {
        return await remote(header, token);
      } catch (error) {
        const fetched =
          error instanceof errors.JWKSNoMatchingKey ||
          error instanceof errors.JWKSMultipleMatchingKeys;
        if (!fetched) failedAt = Date.now();
        throw error;
      }
    };
  }
}
