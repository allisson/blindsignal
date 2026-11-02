import { z } from 'zod';

const seconds = z.coerce.number().int().nonnegative();

// Environment variables, all prefixed `BLINDSIGNAL_`. Defaults follow ADR 0006; an unset
// environment is production, so the dev issuer is never trusted by accident.
const environment = z.object({
  BLINDSIGNAL_ENV: z.enum(['development', 'production']).default('production'),
  BLINDSIGNAL_TOKEN_MAX_LIFETIME_SECONDS: seconds.positive().default(600),
  BLINDSIGNAL_TOKEN_CLOCK_SKEW_SECONDS: seconds.default(60),
  BLINDSIGNAL_TOKEN_MAX_NAMESPACES: seconds.positive().default(100),
});

export interface ServerConfig {
  readonly development: boolean;
  readonly token: {
    readonly maxLifetimeSeconds: number;
    readonly clockSkewSeconds: number;
    readonly maxNamespaces: number;
  };
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
  return {
    ok: true,
    config: {
      development: vars.BLINDSIGNAL_ENV === 'development',
      token: {
        maxLifetimeSeconds: vars.BLINDSIGNAL_TOKEN_MAX_LIFETIME_SECONDS,
        clockSkewSeconds: vars.BLINDSIGNAL_TOKEN_CLOCK_SKEW_SECONDS,
        maxNamespaces: vars.BLINDSIGNAL_TOKEN_MAX_NAMESPACES,
      },
    },
  };
}
