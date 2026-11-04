import type {
  ApplicationRecord,
  ApplicationRepository,
  CoordinationAdapter,
  IssuerKeys,
} from '@blindsignal/core';
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
        pairing: rateLimitPolicy,
        signaling: rateLimitPolicy,
        rtc: rateLimitPolicy,
        rtc_ice_candidate: rateLimitPolicy,
      })
      .partial()
      .default({}),
    revokedDevices: z.array(z.strictObject({ userId, deviceId })).default([]),
    requireProofOfPossession: z.boolean().optional(),
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

/**
 * What a load is checked against: the stored registry, which another instance or an earlier
 * process may have written, plus every application this process saw revoked (ADR 0021).
 */
export async function storedRegistry(
  applications: Pick<ApplicationRepository, 'getAll'>,
  current?: Registry,
): Promise<Registry> {
  return withRevoked(await applications.getAll(), current);
}

function withRevoked(stored: readonly ApplicationRecord[], current?: Registry): Registry {
  const revoked = new Set(current?.revoked);
  for (const app of stored) if (app.status === 'revoked') revoked.add(app.appId);
  return { applications: stored, revoked };
}

/**
 * Checks the registry file against the stored registry and stores the result, in one turn of
 * the storage, so a concurrent load on any instance cannot undo a revocation (ADR 0025). On a
 * reload, `current` adds the applications this process saw revoked.
 */
export async function storeRegistry(
  text: string,
  applications: Pick<ApplicationRepository, 'replaceWith'>,
  options: Omit<ParseRegistryOptions, 'previous'> & { readonly current?: Registry },
): Promise<RegistryResult> {
  const { current, ...parse } = options;
  let result: RegistryResult | undefined;
  await applications.replaceWith((stored) => {
    result = parseRegistry(text, { ...parse, previous: withRevoked(stored, current) });
    return result.ok ? result.registry.applications : undefined;
  });
  return result as RegistryResult;
}

/** Every instance publishes on it once it installs a reload (ADR 0024). */
export const REGISTRY_TOPIC = 'registry';
export const REGISTRY_CHANGED = { type: 'registry.changed' } as const;

/**
 * Installs the stored registry, which another instance's reload may have written, in this
 * process's copy, keeping every application this process saw revoked (ADR 0024).
 */
export async function syncRegistry(
  stored: Pick<ApplicationRepository, 'getAll'>,
  copy: Pick<ApplicationRepository, 'replaceAll'>,
  current: Registry,
  development: boolean,
): Promise<Registry> {
  const next = await storedRegistry(stored, current);
  // Another instance, in development mode by mistake, may have stored it (spec §14.1).
  const dev = next.applications.some(({ issuer, keys }) =>
    trustsDevIssuer(issuer, 'publicKeys' in keys ? keys.publicKeys : undefined),
  );
  if (dev && !development) throw new Error('the stored registry trusts the dev issuer');
  await copy.replaceAll(next.applications);
  return next;
}

/**
 * Runs `sync` on every registry event and every `intervalMs`; the interval covers an event lost
 * while coordination was unreachable (ADR 0024). Returns a function that stops.
 */
export async function followRegistry(
  coordination: Pick<CoordinationAdapter, 'subscribe'>,
  intervalMs: number,
  sync: () => void,
): Promise<() => Promise<void>> {
  const unsubscribe = await coordination.subscribe(REGISTRY_TOPIC, () => sync());
  const timer = setInterval(sync, intervalMs);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await unsubscribe();
  };
}

export type RegistryResult =
  | { readonly ok: true; readonly registry: Registry }
  | { readonly ok: false; readonly error: string };

/** Whether an application trusts the dev issuer, whose private key is public (spec §14.1). */
function trustsDevIssuer(
  issuer: string,
  publicKeys: readonly { readonly [parameter: string]: unknown }[] | undefined,
): boolean {
  const devKey = publicKeys?.some((key) => key.x === DEV_PUBLIC_KEY_X) ?? false;
  return issuer.startsWith(DEV_ISSUER_ORIGIN) || devKey;
}

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
    if (!development && trustsDevIssuer(entry.issuer, entry.publicKeys)) {
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
