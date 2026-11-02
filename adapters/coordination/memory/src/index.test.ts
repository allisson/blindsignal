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
