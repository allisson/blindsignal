import { describe, expect, it, vi } from 'vitest';
import type { CoordinationAdapter } from '../coordination.ts';

export interface CoordinationHarness {
  readonly coordination: CoordinationAdapter;
  /** Lets `ms` pass: a fake clock moves, a real adapter waits. */
  readonly elapse: (ms: number) => Promise<void>;
}

const alice = { appId: 'notes', userId: 'alice', deviceId: 'd1' };
const bob = { appId: 'notes', userId: 'bob', deviceId: 'd1' };

// Long enough for a real adapter's round trips to stay well inside each margin.
const TTL = 400;

/** Waits until `seen` holds `expected`; delivery may be asynchronous, on another connection. */
const received = (seen: unknown[], expected: unknown[]) =>
  vi.waitFor(() => expect(seen).toEqual(expected), { timeout: 2000 });

/**
 * The behavior every `CoordinationAdapter` shares (ADR 0010, ADR 0022). `create` returns an
 * empty adapter for each test. Exact expiry boundaries are left to each adapter's own tests.
 */
export function describeCoordinationContract(
  name: string,
  create: () => Promise<CoordinationHarness>,
) {
  describe(`${name}: jti claims`, () => {
    it('accepts a pair once while it is tracked, and again after its ttl', async () => {
      const { coordination, elapse } = await create();
      expect(await coordination.claimJti('iss', 'j1', TTL)).toBe(true);
      expect(await coordination.claimJti('iss', 'j1', TTL)).toBe(false);
      await elapse(TTL + 200);
      expect(await coordination.claimJti('iss', 'j1', TTL)).toBe(true);
    });

    it('tracks pairs, and never confuses pairs whose concatenations match', async () => {
      const { coordination } = await create();
      expect(await coordination.claimJti('a', 'j1', TTL)).toBe(true);
      expect(await coordination.claimJti('b', 'j1', TTL)).toBe(true);
      expect(await coordination.claimJti('ab', 'c', TTL)).toBe(true);
      expect(await coordination.claimJti('a', 'bc', TTL)).toBe(true);
    });

    it('accepts one of concurrent claims of a pair', async () => {
      const { coordination } = await create();
      const claims = await Promise.all(
        Array.from({ length: 10 }, () => coordination.claimJti('iss', 'j1', TTL)),
      );
      expect(claims.filter(Boolean)).toHaveLength(1);
    });
  });

  describe(`${name}: device connections`, () => {
    it('returns the connection a claim replaces', async () => {
      const { coordination } = await create();
      expect(await coordination.claimDeviceConnection(alice, 'c1', TTL)).toBeUndefined();
      expect(await coordination.claimDeviceConnection(alice, 'c2', TTL)).toBe('c1');
      expect(await coordination.claimDeviceConnection(alice, 'c2', TTL)).toBeUndefined();
      expect(await coordination.claimDeviceConnection(bob, 'c3', TTL)).toBeUndefined();
    });

    it('reads the connection that holds the claim, per device', async () => {
      const { coordination } = await create();
      expect(await coordination.connectionOf(alice)).toBeUndefined();
      await coordination.claimDeviceConnection(alice, 'c1', TTL);
      await coordination.claimDeviceConnection(alice, 'c2', TTL);
      await coordination.claimDeviceConnection(bob, 'c3', TTL);
      expect(await coordination.connectionOf(alice)).toBe('c2');
      expect(await coordination.connectionOf({ ...alice, appId: 'other' })).toBeUndefined();
      await coordination.releaseDeviceConnection(alice, 'c2');
      expect(await coordination.connectionOf(alice)).toBeUndefined();
      expect(await coordination.connectionOf(bob)).toBe('c3');
    });

    it('expires a claim unless renewed, and reads only a live one', async () => {
      const { coordination, elapse } = await create();
      await coordination.claimDeviceConnection(alice, 'c1', TTL);
      await coordination.claimDeviceConnection(bob, 'c2', TTL);
      await elapse(TTL / 2);
      expect(await coordination.renewDeviceConnection(bob, 'c2', TTL)).toBe(true);
      await elapse(TTL / 2 + 100);
      expect(await coordination.connectionOf(alice)).toBeUndefined();
      expect(await coordination.connectionOf(bob)).toBe('c2');
      expect(await coordination.claimDeviceConnection(alice, 'c3', TTL)).toBeUndefined();
    });

    it('renews only its own claim, and takes an expired one again', async () => {
      const { coordination, elapse } = await create();
      expect(await coordination.renewDeviceConnection(alice, 'c1', TTL)).toBe(true);
      expect(await coordination.connectionOf(alice)).toBe('c1');
      await coordination.claimDeviceConnection(alice, 'c2', TTL);
      expect(await coordination.renewDeviceConnection(alice, 'c1', TTL)).toBe(false);
      expect(await coordination.connectionOf(alice)).toBe('c2');
      await elapse(TTL + 200);
      expect(await coordination.renewDeviceConnection(alice, 'c1', TTL)).toBe(true);
      expect(await coordination.claimDeviceConnection(alice, 'c3', TTL)).toBe('c1');
    });

    it('ignores a release by a stale holder', async () => {
      const { coordination } = await create();
      await coordination.claimDeviceConnection(alice, 'c1', TTL);
      await coordination.claimDeviceConnection(alice, 'c2', TTL);
      await coordination.releaseDeviceConnection(alice, 'c1');
      expect(await coordination.claimDeviceConnection(alice, 'c3', TTL)).toBe('c2');
      await coordination.releaseDeviceConnection(alice, 'c3');
      await coordination.releaseDeviceConnection(alice, 'c3');
      expect(await coordination.claimDeviceConnection(alice, 'c4', TTL)).toBeUndefined();
    });
  });

  describe(`${name}: presence`, () => {
    const sorted = (devices: readonly { userId: string }[]) =>
      [...devices].sort((a, b) => a.userId.localeCompare(b.userId));

    it('lists live leases per namespace, one per device', async () => {
      const { coordination } = await create();
      await coordination.acquirePresence('notes:a', alice, 'c1', TTL);
      await coordination.acquirePresence('notes:a', alice, 'c1', TTL);
      await coordination.acquirePresence('notes:a', bob, 'c2', TTL);
      await coordination.acquirePresence('notes:b', bob, 'c2', TTL);
      expect(sorted(await coordination.listPresence('notes:a'))).toEqual([alice, bob]);
      expect(await coordination.listPresence('notes:b')).toEqual([bob]);
      expect(await coordination.listPresence('notes:c')).toEqual([]);
    });

    it("lists one user's live leases, and reads one device's", async () => {
      const { coordination, elapse } = await create();
      const phone = { ...alice, deviceId: 'd2' };
      await coordination.acquirePresence('notes:a', alice, 'c1', TTL);
      await coordination.acquirePresence('notes:a', bob, 'c2', TTL);
      await coordination.acquirePresence('notes:b', phone, 'c3', TTL);
      expect(await coordination.listPresence('notes:a', { userId: 'alice' })).toEqual([alice]);
      expect(await coordination.listPresence('notes:a', { userId: 'carol' })).toEqual([]);
      expect(await coordination.isPresent('notes:a', alice)).toBe(true);
      expect(await coordination.isPresent('notes:a', phone)).toBe(false);
      expect(await coordination.isPresent('notes:b', phone)).toBe(true);
      expect(await coordination.isPresent('notes:a', { ...alice, appId: 'chat' })).toBe(false);
      await coordination.acquirePresence('notes:a', phone, 'c3', TTL);
      expect(
        [...(await coordination.listPresence('notes:a', { userId: 'alice' }))].sort((a, b) =>
          a.deviceId.localeCompare(b.deviceId),
        ),
      ).toEqual([alice, phone]);
      expect(await coordination.releasePresence('notes:a', alice, 'c1')).toBe(true);
      expect(await coordination.listPresence('notes:a', { userId: 'alice' })).toEqual([phone]);
      expect(await coordination.isPresent('notes:a', alice)).toBe(false);
      await elapse(TTL + 200);
      expect(await coordination.listPresence('notes:a', { userId: 'alice' })).toEqual([]);
      expect(await coordination.isPresent('notes:a', bob)).toBe(false);
    });

    it('expires a lease unless renewed', async () => {
      const { coordination, elapse } = await create();
      await coordination.acquirePresence('notes:a', alice, 'c1', TTL);
      await coordination.acquirePresence('notes:a', bob, 'c2', TTL);
      await elapse(TTL / 2);
      await coordination.acquirePresence('notes:a', bob, 'c2', TTL);
      await elapse(TTL / 2 + 100);
      expect(await coordination.listPresence('notes:a')).toEqual([bob]);
      // Expired while the namespace's other lease keeps it.
      expect(await coordination.isPresent('notes:a', alice)).toBe(false);
      expect(await coordination.isPresent('notes:a', bob)).toBe(true);
      await elapse(TTL / 2);
      expect(await coordination.listPresence('notes:a')).toEqual([]);
    });

    it('releases a lease only for its holder', async () => {
      const { coordination } = await create();
      await coordination.acquirePresence('notes:a', alice, 'c1', TTL);
      await coordination.acquirePresence('notes:a', alice, 'c2', TTL);
      expect(await coordination.releasePresence('notes:a', alice, 'c1')).toBe(false);
      expect(await coordination.releasePresence('notes:b', alice, 'c2')).toBe(false);
      expect(await coordination.listPresence('notes:a')).toEqual([alice]);
      expect(await coordination.releasePresence('notes:a', alice, 'c2')).toBe(true);
      expect(await coordination.releasePresence('notes:a', alice, 'c2')).toBe(false);
      expect(await coordination.listPresence('notes:a')).toEqual([]);
    });
  });

  describe(`${name}: rate limits`, () => {
    it('allows a burst, then refuses until the next token', async () => {
      const { coordination } = await create();
      const policy = { ratePerSecond: 1, burst: 2 };
      expect(await coordination.consumeRateLimit('k', policy)).toEqual({ allowed: true });
      expect(await coordination.consumeRateLimit('k', policy)).toEqual({ allowed: true });
      const refused = await coordination.consumeRateLimit('k', policy);
      expect(refused.allowed).toBe(false);
      const { retryAfterMs } = refused as { retryAfterMs: number };
      expect(Number.isInteger(retryAfterMs)).toBe(true);
      expect(retryAfterMs).toBeGreaterThan(800);
      expect(retryAfterMs).toBeLessThanOrEqual(1000);
    });

    it('refills at the rate, up to the burst, with a bucket per key', async () => {
      const { coordination, elapse } = await create();
      const policy = { ratePerSecond: 4, burst: 2 };
      await coordination.consumeRateLimit('k', policy);
      await coordination.consumeRateLimit('k', policy);
      expect((await coordination.consumeRateLimit('k', policy)).allowed).toBe(false);
      expect(await coordination.consumeRateLimit('other', policy)).toEqual({ allowed: true });
      await elapse(300);
      expect(await coordination.consumeRateLimit('k', policy)).toEqual({ allowed: true });
      expect((await coordination.consumeRateLimit('k', policy)).allowed).toBe(false);
      await elapse(1000);
      expect(await coordination.consumeRateLimit('k', policy)).toEqual({ allowed: true });
      expect(await coordination.consumeRateLimit('k', policy)).toEqual({ allowed: true });
      expect((await coordination.consumeRateLimit('k', policy)).allowed).toBe(false);
    });

    it('allows only the burst of concurrent requests', async () => {
      const { coordination } = await create();
      const policy = { ratePerSecond: 0.1, burst: 3 };
      const decisions = await Promise.all(
        Array.from({ length: 10 }, () => coordination.consumeRateLimit('k', policy)),
      );
      expect(decisions.filter((decision) => decision.allowed)).toHaveLength(3);
    });
  });

  describe(`${name}: slots`, () => {
    const app = { key: 'app', limit: 2 };
    const device = { key: 'device', limit: 1 };

    it('takes slots up to each limit, all or none', async () => {
      const { coordination } = await create();
      expect(await coordination.acquireSlots('h1', [app], TTL)).toBe(true);
      expect(await coordination.acquireSlots('h2', [device], TTL)).toBe(true);
      expect(await coordination.acquireSlots('h3', [app, device], TTL)).toBe(false);
      expect(await coordination.acquireSlots('h4', [app], TTL)).toBe(true);
      expect(await coordination.acquireSlots('h5', [app], TTL)).toBe(false);
    });

    it('keeps a slot the holder already has without taking another', async () => {
      const { coordination } = await create();
      await coordination.acquireSlots('h1', [device], TTL);
      expect(await coordination.acquireSlots('h1', [device], TTL)).toBe(true);
      expect(await coordination.acquireSlots('h2', [device], TTL)).toBe(false);
    });

    it('frees released slots, only the holder releases its own, and twice has no effect', async () => {
      const { coordination } = await create();
      await coordination.acquireSlots('h1', [device], TTL);
      await coordination.releaseSlots('h2', ['device', 'unknown']);
      expect(await coordination.acquireSlots('h2', [device], TTL)).toBe(false);
      await coordination.releaseSlots('h1', ['device']);
      await coordination.releaseSlots('h1', ['device']);
      expect(await coordination.acquireSlots('h2', [device], TTL)).toBe(true);
    });

    it('expires a slot unless renewed', async () => {
      const { coordination, elapse } = await create();
      await coordination.acquireSlots('h1', [app], TTL);
      await coordination.acquireSlots('h2', [app], TTL);
      await elapse(TTL / 2);
      expect(await coordination.acquireSlots('h2', [app], TTL)).toBe(true);
      await elapse(TTL / 2 + 100);
      expect(await coordination.acquireSlots('h3', [app], TTL)).toBe(true);
      expect(await coordination.acquireSlots('h1', [app], TTL)).toBe(false);
    });
  });

  describe(`${name}: publish and subscribe`, () => {
    it('delivers a copy of an event to every subscriber of its topic only', async () => {
      const { coordination } = await create();
      const a: unknown[] = [];
      const b: unknown[] = [];
      await coordination.subscribe('t1', (event) => a.push(event));
      await coordination.subscribe('t1', (event) => b.push(event));
      await coordination.subscribe('t2', (event) => b.push(['t2', event]));
      const event = { type: 'deliver', message: { n: 1 } };
      await coordination.publish('t1', event);
      await coordination.publish('t3', 'lost');
      await coordination.publish('t2', 'end');
      await received(b, [event, ['t2', 'end']]);
      expect(a).toEqual([event]);
    });

    it('unsubscribes one subscription at a time, and twice harmlessly', async () => {
      const { coordination } = await create();
      const seen: unknown[] = [];
      const clock: unknown[] = [];
      const handler = (event: unknown) => seen.push(event);
      await coordination.subscribe('t1', (event) => clock.push(event));
      const first = await coordination.subscribe('t1', handler);
      const second = await coordination.subscribe('t1', handler);
      await first();
      await coordination.publish('t1', 1);
      await received(clock, [1]);
      await second();
      await second();
      await coordination.publish('t1', 2);
      await received(clock, [1, 2]);
      expect(seen).toEqual([1]);
    });

    it('keeps a later subscription when an old unsubscribe runs again', async () => {
      const { coordination } = await create();
      const seen: unknown[] = [];
      const old = await coordination.subscribe('t1', () => seen.push('old'));
      await old();
      await coordination.subscribe('t1', (event) => seen.push(event));
      await old();
      await coordination.publish('t1', 'new');
      await received(seen, ['new']);
    });

    it('still delivers to the next subscriber when one unsubscribes during delivery', async () => {
      const { coordination } = await create();
      const seen: string[] = [];
      const unsubscribe = await coordination.subscribe('t1', () => {
        seen.push('first');
        void unsubscribe();
      });
      await coordination.subscribe('t1', () => seen.push('second'));
      await coordination.publish('t1', null);
      await received(seen, ['first', 'second']);
      await coordination.publish('t1', null);
      await received(seen, ['first', 'second', 'second']);
    });
  });
}
