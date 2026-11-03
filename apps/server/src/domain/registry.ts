import type { ApplicationRecord, IssuerKeys } from '@blindsignal/core';
import { appId, deviceId, userId } from '@blindsignal/protocol';
import { z } from 'zod';

// Registry file schema (ADR 0005). Unknown keys are rejected: a misspelled key in operator
// configuration must fail the load, not be ignored.
const positiveInt = z.int().positive();

const publicJwk = z.discriminatedUnion('kty', [
  z.strictObject({
    kty: z.literal('OKP'),
    crv: z.literal('Ed25519'),
    x: z.string().min(1),
    kid: z.string().min(1),
    alg: z.literal('EdDSA').optional(),
    use: z.literal('sig').optional(),
  }),
  z.strictObject({
    kty: z.literal('EC'),
    crv: z.literal('P-256'),
    x: z.string().min(1),
    y: z.string().min(1),
    kid: z.string().min(1),
    alg: z.literal('ES256').optional(),
    use: z.literal('sig').optional(),
  }),
]);

const rateLimitPolicy = z.strictObject({
  ratePerSecond: z.number().positive(),
  burst: positiveInt,
});

const applicationEntry = z
  .strictObject({
    appId,
    name: z.string().min(1),
    status: z.enum(['active', 'suspended', 'revoked']),
    issuer: z.string().min(1),
    audience: z.string().min(1),
    jwksUri: z.url({ protocol: /^https$/ }).optional(),
    publicKeys: z.array(publicJwk).min(1).optional(),
    algorithms: z.array(z.enum(['EdDSA', 'ES256'])).min(1),
    quotas: z
      .strictObject({
        connections: positiveInt,
        devices: positiveInt,
        sessions: positiveInt,
        sessionsPerDevice: positiveInt,
        namespacesPerDevice: positiveInt,
        sessionDurationSeconds: positiveInt,
      })
      .partial()
      .default({}),
    rateLimits: z
      .strictObject({
        discovery: rateLimitPolicy,
        session_create: rateLimitPolicy,
        signaling: rateLimitPolicy,
        rtc: rateLimitPolicy,
        rtc_ice_candidate: rateLimitPolicy,
      })
      .partial()
      .default({}),
    revokedDevices: z.array(z.strictObject({ userId, deviceId })).default([]),
  })
  .refine((entry) => (entry.jwksUri === undefined) !== (entry.publicKeys === undefined), {
    message: 'set exactly one of jwksUri and publicKeys',
  })
  .refine(
    ({ publicKeys: keys }) =>
      keys === undefined || new Set(keys.map((key) => key.kid)).size === keys.length,
    { message: 'publicKeys kid values must be unique', path: ['publicKeys'] },
  );

const registryFile = z.strictObject({ applications: z.array(applicationEntry) });

// The dev issuer's origin and public key, copied from packages/dev-issuer, which server source
// may not import (ADR 0002); a test keeps the copies equal.
export const DEV_ISSUER_ORIGIN = 'https://dev-issuer.blindsignal.invalid';
export const DEV_PUBLIC_KEY_X = 'wAzWXTlkeTKt5gt4V5mhStDncwJrxy3TTMKI-uoSCSg';

export interface ParseRegistryOptions {
  readonly now: Date;
  /** The current registry, on a reload. */
  readonly previous?: Registry;
  /** Trust the dev issuer; only when the server runs in development mode. */
  readonly development?: boolean;
}

/** A loaded registry and what later reloads are checked against. */
export interface Registry {
  readonly applications: readonly ApplicationRecord[];
  /** Every application seen revoked in this process, removed ones included. */
  readonly revoked: ReadonlySet<string>;
}

export type RegistryResult =
  | { readonly ok: true; readonly registry: Registry }
  | { readonly ok: false; readonly error: string };

/**
 * Parses and validates the registry file. A reload passes the current registry; the result is
 * all or nothing, and an error never repeats file content beyond key paths.
 */
export function parseRegistry(
  text: string,
  { now, previous, development = false }: ParseRegistryOptions,
): RegistryResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: 'registry is not valid JSON' };
  }
  const parsed = registryFile.safeParse(data);
  if (!parsed.success) {
    const paths = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    return { ok: false, error: paths.join('; ') };
  }

  const errors: string[] = [];
  const seenApps = new Set<string>();
  const seenIssuers = new Set<string>();
  for (const entry of parsed.data.applications) {
    if (seenApps.has(entry.appId)) errors.push(`${entry.appId}: duplicate appId`);
    if (seenIssuers.has(entry.issuer)) errors.push(`${entry.appId}: issuer used by another app`);
    if (previous?.revoked.has(entry.appId) && entry.status !== 'revoked') {
      errors.push(`${entry.appId}: a revoked application cannot be reactivated`);
    }
    const devKey = entry.publicKeys?.some((key) => key.x === DEV_PUBLIC_KEY_X) ?? false;
    if (!development && (entry.issuer.startsWith(DEV_ISSUER_ORIGIN) || devKey)) {
      errors.push(`${entry.appId}: the dev issuer is trusted only in development mode`);
    }
    seenApps.add(entry.appId);
    seenIssuers.add(entry.issuer);
  }
  if (errors.length > 0) return { ok: false, error: errors.join('; ') };

  const before = new Map(previous?.applications.map((app) => [app.appId, app]));
  const applications = parsed.data.applications.map((entry): ApplicationRecord => {
    const { jwksUri, publicKeys, ...rest } = entry;
    const keys: IssuerKeys = jwksUri === undefined ? { publicKeys: publicKeys ?? [] } : { jwksUri };
    const content = { ...rest, keys };
    const old = before.get(entry.appId);
    if (old === undefined) return { ...content, createdAt: now, updatedAt: now };
    const { createdAt, updatedAt, ...oldContent } = old;
    const changed = JSON.stringify(oldContent) !== JSON.stringify(content);
    return { ...content, createdAt, updatedAt: changed ? now : updatedAt };
  });

  const revoked = new Set(previous?.revoked);
  for (const app of applications) if (app.status === 'revoked') revoked.add(app.appId);
  return { ok: true, registry: { applications, revoked } };
}
