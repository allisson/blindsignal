import type { RateLimitPolicy } from '@blindsignal/core';
import { MAX_MESSAGE_BYTES } from '@blindsignal/protocol';
import { isIP, type BlockList } from 'node:net';
import { z } from 'zod';
import { parseTrustedProxies, type ForwardedHeader } from './domain/client-ip.ts';
import type { AbuseAlertPolicy } from './domain/abuse.ts';
import type { Limits } from './domain/limits.ts';
import type { AllowedOrigins } from './domain/origin.ts';
import type { TurnPolicy } from './domain/turn.ts';
import { levels, type Level } from './telemetry.ts';

const seconds = z.coerce.number().int().nonnegative();
const port = z.coerce.number().int().min(0).max(65_535);
const count = z.coerce.number().int().positive();

/** `rate,burst`: tokens added per second, and the bucket's size (ADR 0011). */
const rateLimit = (ratePerSecond: number, burst: number) =>
  z
    .string()
    .regex(/^\d+(\.\d+)?,\d+$/, 'must be rate,burst')
    .transform((value) => {
      const [rate, size] = value.split(',').map(Number) as [number, number];
      return { ratePerSecond: rate, burst: size };
    })
    .pipe(z.object({ ratePerSecond: z.number().positive(), burst: z.number().int().positive() }))
    .default({ ratePerSecond, burst });

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

// STUN only, so no static TURN credential can be configured (ADR 0017).
const iceServers = z.array(
  z.strictObject({ urls: z.array(z.string().regex(/^stuns?:\S+$/)).min(1) }),
);

// TURN servers get temporary credentials minted per message (docs/adr/0017-turn-credentials.md).
const turnUrls = z
  .string()
  .default('')
  .transform(list)
  .refine(
    (entries) => entries.every((entry) => /^turns?:\S+$/.test(entry)),
    'each entry must be a turn: or turns: URL',
  );

// The TURN server checks a credential with it; a short secret is guessed offline (ADR 0017).
const MIN_TURN_SECRET_BYTES = 32;

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
    // Events below it are not written (ADR 0037).
    BLINDSIGNAL_LOG_LEVEL: z.enum(levels).default('info'),
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
    BLINDSIGNAL_TURN_URLS: turnUrls,
    BLINDSIGNAL_TURN_SECRET: z.string().default(''),
    BLINDSIGNAL_TURN_CREDENTIAL_TTL_SECONDS: seconds.positive().default(900),
    BLINDSIGNAL_TOKEN_MAX_LIFETIME_SECONDS: seconds.positive().default(600),
    BLINDSIGNAL_TOKEN_CLOCK_SKEW_SECONDS: seconds.default(60),
    BLINDSIGNAL_TOKEN_MAX_NAMESPACES: seconds.positive().default(100),
    // Remote key sets (spec §5.3): jose's defaults, and a size limit on the response.
    BLINDSIGNAL_JWKS_TIMEOUT_SECONDS: seconds.positive().default(5),
    BLINDSIGNAL_JWKS_CACHE_SECONDS: seconds.positive().default(600),
    BLINDSIGNAL_JWKS_COOLDOWN_SECONDS: seconds.positive().default(30),
    BLINDSIGNAL_JWKS_MAX_BYTES: count.default(65_536),
    BLINDSIGNAL_HEARTBEAT_INTERVAL_SECONDS: seconds.positive().default(30),
    // How long a closing connection waits for the client's close before it is terminated (ADR 0011).
    BLINDSIGNAL_CLOSE_TIMEOUT_SECONDS: seconds.positive().default(5),
    BLINDSIGNAL_PRESENCE_LEASE_SECONDS: seconds.positive().default(90),
    BLINDSIGNAL_NEGOTIATION_TIMEOUT_SECONDS: seconds.positive().default(30),
    BLINDSIGNAL_DEVICE_TTL_DAYS: seconds.positive().default(30),
    BLINDSIGNAL_DEVICE_SWEEP_INTERVAL_SECONDS: seconds.positive().default(3600),
    // Unset keeps storage in memory, for a single instance (ADR 0021).
    BLINDSIGNAL_DATABASE_URL: z
      .string()
      .default('')
      .refine((value) => value === '' || /^postgres(ql)?:\/\//.test(value), {
        message: 'must be a postgres:// URL',
      }),
    BLINDSIGNAL_DATABASE_POOL_SIZE: count.default(10),
    // Unset keeps coordination in memory, for a single instance (ADR 0023).
    BLINDSIGNAL_REDIS_URL: z
      .string()
      .default('')
      .refine((value) => value === '' || /^rediss?:\/\//.test(value), {
        message: 'must be a redis:// or rediss:// URL',
      }),
    // Starts every key and channel, so deployments sharing a Redis stay apart (ADR 0022).
    BLINDSIGNAL_REDIS_PREFIX: z.string().regex(/^\S+$/).default('blindsignal:'),
    // How often each instance rereads the stored registry, with Redis (ADR 0024).
    BLINDSIGNAL_REGISTRY_SYNC_INTERVAL_SECONDS: seconds.positive().default(60),
    // How long a scrape of /metrics waits for each dependency's probe (ADR 0028).
    BLINDSIGNAL_DEPENDENCY_PROBE_TIMEOUT_SECONDS: seconds.positive().default(2),
    // On SIGTERM, readiness fails this long before the connections close (ADR 0031).
    BLINDSIGNAL_SHUTDOWN_DELAY_SECONDS: seconds.default(0),
    // Exits with status 1 when the shutdown, delay included, takes longer (ADR 0031).
    BLINDSIGNAL_SHUTDOWN_TIMEOUT_SECONDS: seconds.positive().default(8),
    // Before authentication, keyed by client IP or global; no application can override them.
    BLINDSIGNAL_AUTHENTICATION_TIMEOUT_SECONDS: seconds.positive().default(10),
    BLINDSIGNAL_MAX_UNAUTHENTICATED_PER_IP: count.default(20),
    BLINDSIGNAL_MAX_UNAUTHENTICATED: count.default(1_000),
    BLINDSIGNAL_RATE_LIMIT_CONNECTION_ATTEMPTS: rateLimit(5, 20),
    BLINDSIGNAL_RATE_LIMIT_AUTHENTICATION: rateLimit(1, 10),
    // The protocol caps it at its default (docs/protocol.md §1).
    BLINDSIGNAL_MAX_MESSAGE_BYTES: count.max(MAX_MESSAGE_BYTES).default(MAX_MESSAGE_BYTES),
    // Per connection (ADR 0013): reading pauses at half the queue, so it holds at least two; the
    // send buffer holds at least one message of the protocol's maximum size.
    BLINDSIGNAL_MAX_QUEUED_MESSAGES: count.min(2).default(1_024),
    BLINDSIGNAL_MAX_BUFFERED_BYTES: count.min(MAX_MESSAGE_BYTES).default(1_048_576),
    // Server defaults for every application; a registry entry may override each (ADR 0011). They
    // are starting values until load testing sets them (spec §8.2).
    BLINDSIGNAL_MAX_CONNECTIONS_PER_APP: count.default(10_000),
    BLINDSIGNAL_MAX_DEVICES_PER_APP: count.default(10_000),
    BLINDSIGNAL_MAX_SESSIONS_PER_APP: count.default(10_000),
    BLINDSIGNAL_MAX_SESSIONS_PER_DEVICE: count.default(16),
    BLINDSIGNAL_MAX_NAMESPACES_PER_DEVICE: count.default(100),
    // Open connections on this instance, upgrades in progress included; 0 sets no limit (ADR 0030).
    BLINDSIGNAL_MAX_CONNECTIONS: z.coerce.number().int().nonnegative().default(0),
    // 0 sets no limit; set it below the hosting platform's request timeout (ADR 0029).
    BLINDSIGNAL_MAX_CONNECTION_SECONDS: seconds.default(0),
    // 0 sets no limit: a session already ends with either connection (ADR 0014).
    BLINDSIGNAL_MAX_SESSION_DURATION_SECONDS: seconds.default(0),
    BLINDSIGNAL_RATE_LIMIT_DISCOVERY: rateLimit(2, 10),
    BLINDSIGNAL_RATE_LIMIT_SESSION_CREATE: rateLimit(2, 10),
    BLINDSIGNAL_RATE_LIMIT_PAIRING: rateLimit(0.1, 3),
    BLINDSIGNAL_RATE_LIMIT_SIGNALING: rateLimit(50, 100),
    BLINDSIGNAL_RATE_LIMIT_RTC: rateLimit(10, 30),
    BLINDSIGNAL_RATE_LIMIT_RTC_ICE_CANDIDATE: rateLimit(20, 50),
    // Rejections of one application per window that raise an alert; 0 turns alerts off (ADR 0016).
    BLINDSIGNAL_ABUSE_ALERT_THRESHOLD: seconds.default(0),
    BLINDSIGNAL_ABUSE_ALERT_WINDOW_SECONDS: seconds.positive().default(60),
    // OpenTelemetry's own variables (ADR 0038): either endpoint turns the OTLP export on, and the
    // exporter reads them, with OTEL_EXPORTER_OTLP_HEADERS, itself.
    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().default(''),
    OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: z.string().default(''),
    OTEL_METRIC_EXPORT_INTERVAL: z.coerce.number().int().positive().default(60_000),
  })
  .refine(
    (vars) => vars.BLINDSIGNAL_ENV === 'development' || vars.BLINDSIGNAL_ALLOWED_ORIGINS.length > 0,
    {
      path: ['BLINDSIGNAL_ALLOWED_ORIGINS'],
      message: 'required in production; use * to allow every origin',
    },
  )
  // Shared coordination with per-instance storage would split device quotas and revocations.
  .refine((vars) => vars.BLINDSIGNAL_REDIS_URL === '' || vars.BLINDSIGNAL_DATABASE_URL !== '', {
    path: ['BLINDSIGNAL_REDIS_URL'],
    message: 'requires BLINDSIGNAL_DATABASE_URL',
  })
  .refine(
    (vars) => vars.BLINDSIGNAL_TURN_URLS.length > 0 === (vars.BLINDSIGNAL_TURN_SECRET !== ''),
    { path: ['BLINDSIGNAL_TURN_SECRET'], message: 'set together with BLINDSIGNAL_TURN_URLS' },
  )
  .refine(
    (vars) =>
      vars.BLINDSIGNAL_TURN_SECRET === '' ||
      Buffer.byteLength(vars.BLINDSIGNAL_TURN_SECRET) >= MIN_TURN_SECRET_BYTES,
    {
      path: ['BLINDSIGNAL_TURN_SECRET'],
      message: `must be at least ${MIN_TURN_SECRET_BYTES} bytes`,
    },
  )
  .refine(
    (vars) => vars.BLINDSIGNAL_SHUTDOWN_TIMEOUT_SECONDS > vars.BLINDSIGNAL_SHUTDOWN_DELAY_SECONDS,
    {
      path: ['BLINDSIGNAL_SHUTDOWN_TIMEOUT_SECONDS'],
      message: 'must exceed BLINDSIGNAL_SHUTDOWN_DELAY_SECONDS',
    },
  )
  // Each set stays valid until the next auth.refresh brings a new one (ADR 0009).
  .refine(
    (vars) =>
      vars.BLINDSIGNAL_TURN_CREDENTIAL_TTL_SECONDS >=
      vars.BLINDSIGNAL_TOKEN_MAX_LIFETIME_SECONDS + vars.BLINDSIGNAL_TOKEN_CLOCK_SKEW_SECONDS,
    {
      path: ['BLINDSIGNAL_TURN_CREDENTIAL_TTL_SECONDS'],
      message: 'must be at least the maximum token lifetime plus the clock skew',
    },
  );

export interface ServerConfig {
  readonly development: boolean;
  readonly port: number;
  readonly adminPort: number;
  readonly adminHost: string;
  readonly registryPath: string;
  readonly logLevel: Level;
  readonly allowedOrigins: AllowedOrigins;
  readonly proxyTrust: { readonly proxies: BlockList; readonly header: ForwardedHeader };
  readonly iceServers: readonly { readonly urls: readonly string[] }[];
  /** Absent when no TURN server is configured. */
  readonly turn?: TurnPolicy;
  readonly token: {
    readonly maxLifetimeSeconds: number;
    readonly clockSkewSeconds: number;
    readonly maxNamespaces: number;
    readonly jwks: {
      readonly timeoutMs: number;
      readonly cacheMaxAgeMs: number;
      readonly cooldownMs: number;
      readonly maxBytes: number;
    };
  };
  readonly heartbeatIntervalMs: number;
  readonly closeTimeoutMs: number;
  /** 0 when connections have no maximum lifetime. */
  readonly maxConnectionMs: number;
  /** 0 when the instance has no connection cap. */
  readonly maxConnections: number;
  readonly presenceLeaseMs: number;
  readonly negotiationTimeoutMs: number;
  readonly deviceTtlMs: number;
  readonly deviceSweepIntervalMs: number;
  /** Absent when storage stays in memory. */
  readonly database?: { readonly url: string; readonly poolSize: number };
  /** Absent when coordination stays in memory. */
  readonly redis?: { readonly url: string; readonly prefix: string };
  readonly registrySyncIntervalMs: number;
  readonly dependencyProbeTimeoutMs: number;
  /** On SIGTERM, how long readiness fails before the connections close (ADR 0031). */
  readonly shutdownDelayMs: number;
  /** The shutdown's deadline, delay included; past it the process exits with status 1. */
  readonly shutdownTimeoutMs: number;
  readonly preAuthentication: PreAuthentication;
  readonly maxMessageBytes: number;
  readonly maxQueuedMessages: number;
  readonly maxBufferedBytes: number;
  readonly limits: Limits;
  readonly abuseAlerts: AbuseAlertPolicy;
  /** Absent when no OTLP endpoint is set: metrics are only scraped from `/metrics`. */
  readonly otlp?: { readonly intervalMs: number };
}

/** Limits before authentication, when only the client IP is known (spec §8.1, §8.4). */
export interface PreAuthentication {
  readonly authenticationTimeoutMs: number;
  /** Concurrent unauthenticated connections, per client IP and in all, on this instance. */
  readonly maxUnauthenticatedPerIp: number;
  readonly maxUnauthenticated: number;
  readonly connectionAttempts: RateLimitPolicy;
  /** `auth.authenticate` and `auth.refresh`, per client IP. */
  readonly authenticationAttempts: RateLimitPolicy;
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
      logLevel: vars.BLINDSIGNAL_LOG_LEVEL,
      // Only development reaches here with an empty list; it allows every origin.
      allowedOrigins: origins.length === 0 || origins.includes('*') ? '*' : new Set(origins),
      proxyTrust: {
        proxies: vars.BLINDSIGNAL_TRUSTED_PROXIES,
        header: vars.BLINDSIGNAL_FORWARDED_HEADER,
      },
      iceServers: vars.BLINDSIGNAL_ICE_SERVERS,
      ...(vars.BLINDSIGNAL_TURN_URLS.length === 0
        ? {}
        : {
            turn: {
              urls: vars.BLINDSIGNAL_TURN_URLS,
              secret: vars.BLINDSIGNAL_TURN_SECRET,
              credentialTtlSeconds: vars.BLINDSIGNAL_TURN_CREDENTIAL_TTL_SECONDS,
            },
          }),
      token: {
        maxLifetimeSeconds: vars.BLINDSIGNAL_TOKEN_MAX_LIFETIME_SECONDS,
        clockSkewSeconds: vars.BLINDSIGNAL_TOKEN_CLOCK_SKEW_SECONDS,
        maxNamespaces: vars.BLINDSIGNAL_TOKEN_MAX_NAMESPACES,
        jwks: {
          timeoutMs: vars.BLINDSIGNAL_JWKS_TIMEOUT_SECONDS * 1000,
          cacheMaxAgeMs: vars.BLINDSIGNAL_JWKS_CACHE_SECONDS * 1000,
          cooldownMs: vars.BLINDSIGNAL_JWKS_COOLDOWN_SECONDS * 1000,
          maxBytes: vars.BLINDSIGNAL_JWKS_MAX_BYTES,
        },
      },
      heartbeatIntervalMs: vars.BLINDSIGNAL_HEARTBEAT_INTERVAL_SECONDS * 1000,
      closeTimeoutMs: vars.BLINDSIGNAL_CLOSE_TIMEOUT_SECONDS * 1000,
      maxConnectionMs: vars.BLINDSIGNAL_MAX_CONNECTION_SECONDS * 1000,
      maxConnections: vars.BLINDSIGNAL_MAX_CONNECTIONS,
      presenceLeaseMs: vars.BLINDSIGNAL_PRESENCE_LEASE_SECONDS * 1000,
      negotiationTimeoutMs: vars.BLINDSIGNAL_NEGOTIATION_TIMEOUT_SECONDS * 1000,
      deviceTtlMs: vars.BLINDSIGNAL_DEVICE_TTL_DAYS * 86_400_000,
      deviceSweepIntervalMs: vars.BLINDSIGNAL_DEVICE_SWEEP_INTERVAL_SECONDS * 1000,
      registrySyncIntervalMs: vars.BLINDSIGNAL_REGISTRY_SYNC_INTERVAL_SECONDS * 1000,
      dependencyProbeTimeoutMs: vars.BLINDSIGNAL_DEPENDENCY_PROBE_TIMEOUT_SECONDS * 1000,
      shutdownDelayMs: vars.BLINDSIGNAL_SHUTDOWN_DELAY_SECONDS * 1000,
      shutdownTimeoutMs: vars.BLINDSIGNAL_SHUTDOWN_TIMEOUT_SECONDS * 1000,
      ...(vars.BLINDSIGNAL_DATABASE_URL === ''
        ? {}
        : {
            database: {
              url: vars.BLINDSIGNAL_DATABASE_URL,
              poolSize: vars.BLINDSIGNAL_DATABASE_POOL_SIZE,
            },
          }),
      ...(vars.BLINDSIGNAL_REDIS_URL === ''
        ? {}
        : { redis: { url: vars.BLINDSIGNAL_REDIS_URL, prefix: vars.BLINDSIGNAL_REDIS_PREFIX } }),
      ...(vars.OTEL_EXPORTER_OTLP_ENDPOINT === '' && vars.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT === ''
        ? {}
        : { otlp: { intervalMs: vars.OTEL_METRIC_EXPORT_INTERVAL } }),
      preAuthentication: {
        authenticationTimeoutMs: vars.BLINDSIGNAL_AUTHENTICATION_TIMEOUT_SECONDS * 1000,
        maxUnauthenticatedPerIp: vars.BLINDSIGNAL_MAX_UNAUTHENTICATED_PER_IP,
        maxUnauthenticated: vars.BLINDSIGNAL_MAX_UNAUTHENTICATED,
        connectionAttempts: vars.BLINDSIGNAL_RATE_LIMIT_CONNECTION_ATTEMPTS,
        authenticationAttempts: vars.BLINDSIGNAL_RATE_LIMIT_AUTHENTICATION,
      },
      maxMessageBytes: vars.BLINDSIGNAL_MAX_MESSAGE_BYTES,
      maxQueuedMessages: vars.BLINDSIGNAL_MAX_QUEUED_MESSAGES,
      maxBufferedBytes: vars.BLINDSIGNAL_MAX_BUFFERED_BYTES,
      limits: {
        quotas: {
          connections: vars.BLINDSIGNAL_MAX_CONNECTIONS_PER_APP,
          devices: vars.BLINDSIGNAL_MAX_DEVICES_PER_APP,
          sessions: vars.BLINDSIGNAL_MAX_SESSIONS_PER_APP,
          sessionsPerDevice: vars.BLINDSIGNAL_MAX_SESSIONS_PER_DEVICE,
          namespacesPerDevice: vars.BLINDSIGNAL_MAX_NAMESPACES_PER_DEVICE,
          sessionDurationSeconds: vars.BLINDSIGNAL_MAX_SESSION_DURATION_SECONDS,
        },
        rateLimits: {
          discovery: vars.BLINDSIGNAL_RATE_LIMIT_DISCOVERY,
          session_create: vars.BLINDSIGNAL_RATE_LIMIT_SESSION_CREATE,
          pairing: vars.BLINDSIGNAL_RATE_LIMIT_PAIRING,
          signaling: vars.BLINDSIGNAL_RATE_LIMIT_SIGNALING,
          rtc: vars.BLINDSIGNAL_RATE_LIMIT_RTC,
          rtc_ice_candidate: vars.BLINDSIGNAL_RATE_LIMIT_RTC_ICE_CANDIDATE,
        },
      },
      abuseAlerts: {
        threshold: vars.BLINDSIGNAL_ABUSE_ALERT_THRESHOLD,
        windowMs: vars.BLINDSIGNAL_ABUSE_ALERT_WINDOW_SECONDS * 1000,
      },
    },
  };
}
