import type {
  ApplicationRateLimit,
  ApplicationRecord,
  Quotas,
  RateLimitPolicy,
} from '@blindsignal/core';

/** Every quota and post-authentication rate limit, all set (ADR 0011). */
export interface Limits {
  readonly quotas: Quotas;
  readonly rateLimits: Readonly<Record<ApplicationRateLimit, RateLimitPolicy>>;
}

/** The server defaults, with each limit the application's registry entry sets taking their place. */
export function applicationLimits(
  defaults: Limits,
  application: Pick<ApplicationRecord, 'quotas' | 'rateLimits'>,
): Limits {
  return {
    quotas: { ...defaults.quotas, ...application.quotas },
    rateLimits: { ...defaults.rateLimits, ...application.rateLimits },
  };
}
