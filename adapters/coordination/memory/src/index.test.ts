import { describe, expect, it } from 'vitest';
import { InMemoryCoordinationAdapter } from './index.ts';

function setup() {
  let now = 0;
  const adapter = new InMemoryCoordinationAdapter({ now: () => now });
  return { adapter, advance: (ms: number) => (now += ms) };
}

describe('InMemoryCoordinationAdapter.claimJti', () => {
  it('accepts a pair once while it is tracked', async () => {
    const { adapter } = setup();
    expect(await adapter.claimJti('iss', 'j1', 1000)).toBe(true);
    expect(await adapter.claimJti('iss', 'j1', 1000)).toBe(false);
  });

  it('tracks pairs, not jti values alone', async () => {
    const { adapter } = setup();
    expect(await adapter.claimJti('a', 'j1', 1000)).toBe(true);
    expect(await adapter.claimJti('b', 'j1', 1000)).toBe(true);
  });

  it('does not confuse pairs whose concatenations match', async () => {
    const { adapter } = setup();
    expect(await adapter.claimJti('ab', 'c', 1000)).toBe(true);
    expect(await adapter.claimJti('a', 'bc', 1000)).toBe(true);
  });

  it('accepts a pair again after its ttl', async () => {
    const { adapter, advance } = setup();
    await adapter.claimJti('iss', 'j1', 1000);
    advance(999);
    expect(await adapter.claimJti('iss', 'j1', 1000)).toBe(false);
    advance(1);
    expect(await adapter.claimJti('iss', 'j1', 1000)).toBe(true);
  });

  it('sweeps expired pairs once per interval', async () => {
    const { adapter, advance } = setup();
    await adapter.claimJti('iss', 'short', 1000);
    await adapter.claimJti('iss', 'long', 120_000);
    advance(59_999);
    await adapter.claimJti('iss', 'other', 1000);
    expect(adapter.trackedJtis).toBe(3);
    advance(1);
    await adapter.claimJti('iss', 'last', 1000);
    expect(adapter.trackedJtis).toBe(3);
    expect(await adapter.claimJti('iss', 'long', 1000)).toBe(false);
  });
});

const alice = { appId: 'notes', userId: 'alice', deviceId: 'd1' };
const bob = { appId: 'notes', userId: 'bob', deviceId: 'd1' };

describe('InMemoryCoordinationAdapter device connections', () => {
  it('returns the connection a claim replaces', async () => {
    const { adapter } = setup();
    expect(await adapter.claimDeviceConnection(alice, 'c1')).toBeUndefined();
    expect(await adapter.claimDeviceConnection(alice, 'c2')).toBe('c1');
    expect(await adapter.claimDeviceConnection(alice, 'c2')).toBeUndefined();
    expect(await adapter.claimDeviceConnection(bob, 'c3')).toBeUndefined();
  });

  it('ignores a release by a stale holder', async () => {
    const { adapter } = setup();
    await adapter.claimDeviceConnection(alice, 'c1');
    await adapter.claimDeviceConnection(alice, 'c2');
    await adapter.releaseDeviceConnection(alice, 'c1');
    expect(await adapter.claimDeviceConnection(alice, 'c3')).toBe('c2');
    await adapter.releaseDeviceConnection(alice, 'c3');
    await adapter.releaseDeviceConnection(alice, 'c3');
    expect(await adapter.claimDeviceConnection(alice, 'c4')).toBeUndefined();
  });
});

describe('InMemoryCoordinationAdapter presence', () => {
  it('lists live leases per namespace, one per device', async () => {
    const { adapter } = setup();
    await adapter.acquirePresence('notes:a', alice, 'c1', 1000);
    await adapter.acquirePresence('notes:a', alice, 'c1', 1000);
    await adapter.acquirePresence('notes:a', bob, 'c2', 1000);
    await adapter.acquirePresence('notes:b', bob, 'c2', 1000);
    expect(await adapter.listPresence('notes:a')).toEqual([alice, bob]);
    expect(await adapter.listPresence('notes:b')).toEqual([bob]);
    expect(await adapter.listPresence('notes:c')).toEqual([]);
  });

  it('expires a lease unless renewed', async () => {
    const { adapter, advance } = setup();
    await adapter.acquirePresence('notes:a', alice, 'c1', 1000);
    await adapter.acquirePresence('notes:a', bob, 'c2', 1000);
    advance(600);
    await adapter.acquirePresence('notes:a', bob, 'c2', 1000);
    advance(400);
    expect(await adapter.listPresence('notes:a')).toEqual([bob]);
  });

  it('releases a lease only for its holder', async () => {
    const { adapter } = setup();
    await adapter.acquirePresence('notes:a', alice, 'c1', 1000);
    await adapter.acquirePresence('notes:a', alice, 'c2', 1000);
    await adapter.releasePresence('notes:a', alice, 'c1');
    await adapter.releasePresence('notes:b', alice, 'c2');
    expect(await adapter.listPresence('notes:a')).toEqual([alice]);
    await adapter.releasePresence('notes:a', alice, 'c2');
    expect(await adapter.listPresence('notes:a')).toEqual([]);
    expect(adapter.trackedLeases).toBe(0);
  });

  it('sweeps expired leases once per interval', async () => {
    const { adapter, advance } = setup();
    await adapter.acquirePresence('notes:a', alice, 'c1', 1000);
    await adapter.acquirePresence('notes:b', bob, 'c2', 120_000);
    advance(60_000);
    await adapter.acquirePresence('notes:c', bob, 'c2', 1000);
    expect(adapter.trackedLeases).toBe(2);
    expect(await adapter.listPresence('notes:b')).toEqual([bob]);
  });
});

describe('InMemoryCoordinationAdapter publish and subscribe', () => {
  it('delivers an event to every subscriber of its topic only', async () => {
    const { adapter } = setup();
    const a: unknown[] = [];
    const b: unknown[] = [];
    await adapter.subscribe('t1', (event) => a.push(event));
    await adapter.subscribe('t1', (event) => b.push(event));
    await adapter.subscribe('t2', (event) => b.push(['t2', event]));
    await adapter.publish('t1', 1);
    await adapter.publish('t3', 2);
    expect(a).toEqual([1]);
    expect(b).toEqual([1]);
  });

  it('unsubscribes one subscription at a time, and twice harmlessly', async () => {
    const { adapter } = setup();
    const seen: unknown[] = [];
    const handler = (event: unknown) => seen.push(event);
    const first = await adapter.subscribe('t1', handler);
    const second = await adapter.subscribe('t1', handler);
    await first();
    await adapter.publish('t1', 1);
    await second();
    await second();
    await adapter.publish('t1', 2);
    expect(seen).toEqual([1]);
    expect(adapter.subscribedTopics).toBe(0);
  });

  it('keeps a later subscription when an old unsubscribe runs again', async () => {
    const { adapter } = setup();
    const seen: unknown[] = [];
    const old = await adapter.subscribe('t1', () => seen.push('old'));
    await old();
    await adapter.subscribe('t1', (event) => seen.push(event));
    await old();
    await adapter.publish('t1', 'new');
    expect(seen).toEqual(['new']);
  });

  it('still delivers to the next subscriber when one unsubscribes during delivery', async () => {
    const { adapter } = setup();
    const seen: string[] = [];
    const unsubscribe = await adapter.subscribe('t1', () => {
      seen.push('first');
      void unsubscribe();
    });
    await adapter.subscribe('t1', () => seen.push('second'));
    await adapter.publish('t1', null);
    await adapter.publish('t1', null);
    expect(seen).toEqual(['first', 'second', 'second']);
  });
});
