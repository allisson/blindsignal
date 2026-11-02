import { isIP, type BlockList } from 'node:net';
import { z } from 'zod';
import { parseTrustedProxies, type ForwardedHeader } from './domain/client-ip.ts';
import type { AllowedOrigins } from './domain/origin.ts';

const seconds = z.coerce.number().int().nonnegative();
const port = z.coerce.number().int().min(0).max(65_535);

const list = (value: string) =>
  value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');

// An entry must already be a serialized origin, so `https://a.example/` is a typo, not a match.
const isOrigin = (entry: string) => {
  try {
    return entry === '*' || new URL(entry).origin === entry;
  } catch {
    return false;
  }
};

// STUN only: TURN credentials arrive with Phase 8 (docs/adr/0009-ice-configuration.md).
const iceServers = z.array(
  z.strictObject({ urls: z.array(z.string().regex(/^stuns?:\S+$/)).min(1) }),
);

const json = z.string().transform((value, context) => {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    // The parser's message quotes the input; never echo a configuration value.
    context.addIssue({ code: 'custom', message: 'invalid JSON' });
    return z.NEVER;
  }
});

// Environment variables, all prefixed `BLINDSIGNAL_`. Defaults follow ADR 0006 and the Phase 3
// plan; an unset environment is production, so the dev issuer is never trusted by accident.
const environment = z
  .object({
    BLINDSIGNAL_ENV: z.enum(['development', 'production']).default('production'),
    BLINDSIGNAL_PORT: port.default(8080),
    BLINDSIGNAL_ADMIN_PORT: port.default(9090),
    // Loopback by default: metrics are for the operator, never for clients.
    BLINDSIGNAL_ADMIN_HOST: z
      .string()
      .refine((value) => isIP(value) !== 0, 'must be an IP address')
      .default('127.0.0.1'),
    BLINDSIGNAL_REGISTRY_PATH: z.string().min(1),
    BLINDSIGNAL_ALLOWED_ORIGINS: z
      .string()
      .default('')
      .transform(list)
      .refine((entries) => entries.every(isOrigin), 'each entry must be an origin or *'),
    BLINDSIGNAL_TRUSTED_PROXIES: z
      .string()
      .default('')
      .transform((value, context) => {
        const proxies = parseTrustedProxies(value);
        if (proxies !== undefined) return proxies;
        context.addIssue({ code: 'custom', message: 'each entry must be an IP or a CIDR' });
        return z.NEVER;
      }),
    BLINDSIGNAL_FORWARDED_HEADER: z
      .enum(['x-forwarded-for', 'cf-connecting-ip'])
      .default('x-forwarded-for'),
    BLINDSIGNAL_ICE_SERVERS: json.pipe(iceServers).default([]),
    BLINDSIGNAL_TOKEN_MAX_LIFETIME_SECONDS: seconds.positive().default(600),
    BLINDSIGNAL_TOKEN_CLOCK_SKEW_SECONDS: seconds.default(60),
    BLINDSIGNAL_TOKEN_MAX_NAMESPACES: seconds.positive().default(100),
    BLINDSIGNAL_HEARTBEAT_INTERVAL_SECONDS: seconds.positive().default(30),
    BLINDSIGNAL_PRESENCE_LEASE_SECONDS: seconds.positive().default(90),
    BLINDSIGNAL_NEGOTIATION_TIMEOUT_SECONDS: seconds.positive().default(30),
    BLINDSIGNAL_DEVICE_TTL_DAYS: seconds.positive().default(30),
    BLINDSIGNAL_MAX_DEVICES_PER_APP: seconds.positive().default(10_000),
  })
  .refine(
    (vars) => vars.BLINDSIGNAL_ENV === 'development' || vars.BLINDSIGNAL_ALLOWED_ORIGINS.length > 0,
    {
      path: ['BLINDSIGNAL_ALLOWED_ORIGINS'],
      message: 'required in production; use * to allow every origin',
    },
  );

export interface ServerConfig {
  readonly development: boolean;
  readonly port: number;
  readonly adminPort: number;
  readonly adminHost: string;
  readonly registryPath: string;
  readonly allowedOrigins: AllowedOrigins;
  readonly proxyTrust: { readonly proxies: BlockList; readonly header: ForwardedHeader };
  readonly iceServers: readonly { readonly urls: readonly string[] }[];
  readonly token: {
    readonly maxLifetimeSeconds: number;
    readonly clockSkewSeconds: number;
    readonly maxNamespaces: number;
  };
  readonly heartbeatIntervalMs: number;
  readonly presenceLeaseMs: number;
  readonly negotiationTimeoutMs: number;
  readonly devices: { readonly ttlMs: number; readonly maxDevices: number };
}

export type ConfigResult =
  | { readonly ok: true; readonly config: ServerConfig }
  | { readonly ok: false; readonly error: string };

/** Reads the configuration; an error names the variables, never their values. */
export function loadConfig(env: Readonly<Record<string, string | undefined>>): ConfigResult {
  const parsed = environment.safeParse(env);
  if (!parsed.success) {
    const paths = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    return { ok: false, error: paths.join('; ') };
  }
  const vars = parsed.data;
  const origins = vars.BLINDSIGNAL_ALLOWED_ORIGINS;
  return {
    ok: true,
    config: {
      development: vars.BLINDSIGNAL_ENV === 'development',
      port: vars.BLINDSIGNAL_PORT,
      adminPort: vars.BLINDSIGNAL_ADMIN_PORT,
      adminHost: vars.BLINDSIGNAL_ADMIN_HOST,
      registryPath: vars.BLINDSIGNAL_REGISTRY_PATH,
      // Only development reaches here with an empty list; it allows every origin.
      allowedOrigins: origins.length === 0 || origins.includes('*') ? '*' : new Set(origins),
      proxyTrust: {
        proxies: vars.BLINDSIGNAL_TRUSTED_PROXIES,
        header: vars.BLINDSIGNAL_FORWARDED_HEADER,
      },
      iceServers: vars.BLINDSIGNAL_ICE_SERVERS,
      token: {
        maxLifetimeSeconds: vars.BLINDSIGNAL_TOKEN_MAX_LIFETIME_SECONDS,
        clockSkewSeconds: vars.BLINDSIGNAL_TOKEN_CLOCK_SKEW_SECONDS,
        maxNamespaces: vars.BLINDSIGNAL_TOKEN_MAX_NAMESPACES,
      },
      heartbeatIntervalMs: vars.BLINDSIGNAL_HEARTBEAT_INTERVAL_SECONDS * 1000,
      presenceLeaseMs: vars.BLINDSIGNAL_PRESENCE_LEASE_SECONDS * 1000,
      negotiationTimeoutMs: vars.BLINDSIGNAL_NEGOTIATION_TIMEOUT_SECONDS * 1000,
      devices: {
        ttlMs: vars.BLINDSIGNAL_DEVICE_TTL_DAYS * 86_400_000,
        maxDevices: vars.BLINDSIGNAL_MAX_DEVICES_PER_APP,
      },
    },
  };
}
