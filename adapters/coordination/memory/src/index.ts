import type { CoordinationAdapter, DeviceIdentity } from '@blindsignal/core';

const SWEEP_INTERVAL_MS = 60_000;

interface Lease {
  readonly device: DeviceIdentity;
  readonly connectionId: string;
  readonly expiresAt: number;
}

interface Subscription {
  readonly handler: (event: unknown) => void;
}

const deviceKey = ({ appId, userId, deviceId }: DeviceIdentity) =>
  JSON.stringify([appId, userId, deviceId]);

/**
 * Single-instance only: state lives in this process and is lost on restart (spec §10.3).
 * Rate limits and concurrency slots arrive with Phase 6.
 */
export class InMemoryCoordinationAdapter implements Omit<
  CoordinationAdapter,
  'consumeRateLimit' | 'acquireSlots' | 'releaseSlots'
> {
  readonly #now: () => number;
  readonly #jtis = new Map<string, number>();
  readonly #connections = new Map<string, string>();
  readonly #presence = new Map<string, Map<string, Lease>>();
  readonly #topics = new Map<string, Set<Subscription>>();
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

  /** Topics with at least one subscriber; for tests. */
  get subscribedTopics(): number {
    return this.#topics.size;
  }
}
