import type {
  CoordinationAdapter,
  DeviceIdentity,
  RateLimitDecision,
  RateLimitPolicy,
  Slot,
} from '@blindsignal/core';

const SWEEP_INTERVAL_MS = 60_000;

interface Lease {
  readonly device: DeviceIdentity;
  readonly connectionId: string;
  readonly expiresAt: number;
}

interface Bucket {
  readonly tokens: number;
  readonly updatedAt: number;
  /** When the bucket is full again, and as good as absent. */
  readonly fullAt: number;
}

interface Subscription {
  readonly handler: (event: unknown) => void;
}

const deviceKey = ({ appId, userId, deviceId }: DeviceIdentity) =>
  JSON.stringify([appId, userId, deviceId]);

/**
 * Single-instance only: state lives in this process and is lost on restart (spec §10.3).
 */
export class InMemoryCoordinationAdapter implements CoordinationAdapter {
  readonly #now: () => number;
  readonly #jtis = new Map<string, number>();
  readonly #connections = new Map<string, string>();
  readonly #presence = new Map<string, Map<string, Lease>>();
  readonly #topics = new Map<string, Set<Subscription>>();
  readonly #buckets = new Map<string, Bucket>();
  /** The holders of each key's slots, with when each slot expires. */
  readonly #slots = new Map<string, Map<string, number>>();
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

  claimDeviceConnection(device: DeviceIdentity, connectionId: string): Promise<string | undefined> {
    const key = deviceKey(device);
    const previous = this.#connections.get(key);
    this.#connections.set(key, connectionId);
    return Promise.resolve(previous === connectionId ? undefined : previous);
  }

  releaseDeviceConnection(device: DeviceIdentity, connectionId: string): Promise<void> {
    const key = deviceKey(device);
    if (this.#connections.get(key) === connectionId) this.#connections.delete(key);
    return Promise.resolve();
  }

  acquirePresence(
    namespace: string,
    device: DeviceIdentity,
    connectionId: string,
    ttlMs: number,
  ): Promise<void> {
    const now = this.#now();
    this.#sweep(now);
    let leases = this.#presence.get(namespace);
    if (leases === undefined) this.#presence.set(namespace, (leases = new Map<string, Lease>()));
    leases.set(deviceKey(device), { device, connectionId, expiresAt: now + ttlMs });
    return Promise.resolve();
  }

  releasePresence(
    namespace: string,
    device: DeviceIdentity,
    connectionId: string,
  ): Promise<boolean> {
    const leases = this.#presence.get(namespace);
    const key = deviceKey(device);
    if (leases?.get(key)?.connectionId !== connectionId) return Promise.resolve(false);
    leases.delete(key);
    if (leases.size === 0) this.#presence.delete(namespace);
    return Promise.resolve(true);
  }

  listPresence(namespace: string): Promise<readonly DeviceIdentity[]> {
    const now = this.#now();
    const leases = [...(this.#presence.get(namespace)?.values() ?? [])];
    return Promise.resolve(leases.filter((lease) => lease.expiresAt > now).map((l) => l.device));
  }

  /** A token bucket per key, created full (ADR 0011). */
  consumeRateLimit(
    key: string,
    { ratePerSecond, burst }: RateLimitPolicy,
  ): Promise<RateLimitDecision> {
    const now = this.#now();
    this.#sweep(now);
    const bucket = this.#buckets.get(key);
    const refilled =
      bucket === undefined
        ? burst
        : bucket.tokens + ((now - bucket.updatedAt) / 1000) * ratePerSecond;
    const available = Math.min(burst, refilled);
    if (available < 1) {
      return Promise.resolve({
        allowed: false,
        retryAfterMs: Math.ceil(((1 - available) / ratePerSecond) * 1000),
      });
    }
    const tokens = available - 1;
    this.#buckets.set(key, {
      tokens,
      updatedAt: now,
      fullAt: now + ((burst - tokens) / ratePerSecond) * 1000,
    });
    return Promise.resolve({ allowed: true });
  }

  acquireSlots(holder: string, slots: readonly Slot[], ttlMs: number): Promise<boolean> {
    const now = this.#now();
    this.#sweep(now);
    // A slot the holder already has stays its own, without taking a second one.
    const free = slots.every(({ key, limit }) => {
      const holders = this.#slots.get(key);
      if (holders === undefined) return true;
      let live = 0;
      for (const expiresAt of holders.values()) if (expiresAt > now) live++;
      return (holders.get(holder) ?? 0) > now || live < limit;
    });
    if (!free) return Promise.resolve(false);
    for (const { key } of slots) {
      let holders = this.#slots.get(key);
      if (holders === undefined) this.#slots.set(key, (holders = new Map<string, number>()));
      holders.set(holder, now + ttlMs);
    }
    return Promise.resolve(true);
  }

  releaseSlots(holder: string, keys: readonly string[]): Promise<void> {
    for (const key of keys) {
      const holders = this.#slots.get(key);
      if (holders?.delete(holder) && holders.size === 0) this.#slots.delete(key);
    }
    return Promise.resolve();
  }

  publish(topic: string, event: unknown): Promise<void> {
    // A copy, so a handler that unsubscribes does not skip the next one.
    for (const { handler } of [...(this.#topics.get(topic) ?? [])]) handler(event);
    return Promise.resolve();
  }

  subscribe(topic: string, handler: (event: unknown) => void): Promise<() => Promise<void>> {
    // One object per call, so subscribing the same handler twice needs two unsubscribes.
    const subscription = { handler };
    let subscriptions = this.#topics.get(topic);
    if (subscriptions === undefined)
      this.#topics.set(topic, (subscriptions = new Set<Subscription>()));
    subscriptions.add(subscription);
    return Promise.resolve(() => {
      subscriptions.delete(subscription);
      if (subscriptions.size === 0 && this.#topics.get(topic) === subscriptions) {
        this.#topics.delete(topic);
      }
      return Promise.resolve();
    });
  }

  /** Drops expired entries at most once per interval, so memory stays bounded by live state. */
  #sweep(now: number): void {
    if (now - this.#lastSweep < SWEEP_INTERVAL_MS) return;
    this.#lastSweep = now;
    for (const [key, expiresAt] of this.#jtis) if (expiresAt <= now) this.#jtis.delete(key);
    for (const [namespace, leases] of this.#presence) {
      for (const [key, lease] of leases) if (lease.expiresAt <= now) leases.delete(key);
      if (leases.size === 0) this.#presence.delete(namespace);
    }
    for (const [key, bucket] of this.#buckets) if (bucket.fullAt <= now) this.#buckets.delete(key);
    for (const [key, holders] of this.#slots) {
      for (const [holder, expiresAt] of holders) if (expiresAt <= now) holders.delete(holder);
      if (holders.size === 0) this.#slots.delete(key);
    }
  }

  /** Tracked pairs, expired ones not yet swept included; for tests. */
  get trackedJtis(): number {
    return this.#jtis.size;
  }

  /** Tracked leases, expired ones not yet swept included; for tests. */
  get trackedLeases(): number {
    let count = 0;
    for (const leases of this.#presence.values()) count += leases.size;
    return count;
  }

  /** Tracked rate-limit buckets, full ones not yet swept included; for tests. */
  get trackedBuckets(): number {
    return this.#buckets.size;
  }

  /** Keys with at least one slot held, expired ones not yet swept included; for tests. */
  get heldSlotKeys(): number {
    return this.#slots.size;
  }

  /** Topics with at least one subscriber; for tests. */
  get subscribedTopics(): number {
    return this.#topics.size;
  }
}
