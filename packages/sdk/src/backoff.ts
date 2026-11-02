export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
}

export const defaultBackoff: BackoffOptions = { baseMs: 1_000, maxMs: 30_000 };

/** Full jitter: a random delay in `[0, min(maxMs, baseMs × 2^attempt))` (docs/protocol.md §10). */
export function backoffDelay(attempt: number, { baseMs, maxMs }: BackoffOptions): number {
  return Math.random() * Math.min(maxMs, baseMs * 2 ** attempt);
}
