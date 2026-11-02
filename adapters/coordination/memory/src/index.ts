import type { CoordinationAdapter } from '@blindsignal/core';

const SWEEP_INTERVAL_MS = 60_000;

/**
 * Single-instance only: state lives in this process and is lost on restart (spec §10.3).
 * Implements what Phase 2 needs; Phase 3 completes the `CoordinationAdapter` contract.
 */
export class InMemoryCoordinationAdapter implements Pick<CoordinationAdapter, 'claimJti'> {
  readonly #now: () => number;
  readonly #jtis = new Map<string, number>();
  #lastSweep: number;

  constructor({ now = Date.now }: { now?: () => number } = {}) {
    this.#now = now;
    this.#lastSweep = now();
  }

  claimJti(issuer: string, jti: string, ttlMs: number): Promise<boolean> {
    const now = this.#now();
    this.#sweep(now);
    const key = JSON.stringify([issuer, jti]);
    const expiresAt = this.#jtis.get(key);
    if (expiresAt !== undefined && expiresAt > now) return Promise.resolve(false);
    this.#jtis.set(key, now + ttlMs);
    return Promise.resolve(true);
  }

  /** Drops expired entries at most once per interval, so memory stays bounded by live tokens. */
  #sweep(now: number): void {
    if (now - this.#lastSweep < SWEEP_INTERVAL_MS) return;
    this.#lastSweep = now;
    for (const [key, expiresAt] of this.#jtis) if (expiresAt <= now) this.#jtis.delete(key);
  }

  /** Tracked pairs, expired ones not yet swept included; for tests. */
  get trackedJtis(): number {
    return this.#jtis.size;
  }
}
