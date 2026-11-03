import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionRegistry } from './sessions.ts';

const alice = { appId: 'notes', userId: 'u1', deviceId: 'd1' };
const bob = { appId: 'notes', userId: 'u2', deviceId: 'd2' };

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('SessionRegistry', () => {
  it('times out a pending session, but not an active or ended one', () => {
    const registry = new SessionRegistry();
    const onTimeout = vi.fn();
    const requester = { connectionId: 'c1', device: alice };
    const target = { connectionId: 'c2', device: bob };
    const pending = registry.create('notes:a', requester, target, 1_000, onTimeout);
    const accepted = registry.create('notes:a', requester, target, 1_000, onTimeout);
    const ended = registry.create('notes:a', requester, target, 1_000, onTimeout);
    expect(registry.activate(accepted.id)).toBe(true);
    expect(registry.activate(accepted.id)).toBe(false);
    expect(registry.end(ended.id)).toBe(true);
    expect(registry.end(ended.id)).toBe(false);
    expect(registry.activate(ended.id)).toBe(false);
    vi.advanceTimersByTime(1_000);
    expect(onTimeout.mock.calls).toEqual([[pending]]);
    expect(registry.get(accepted.id)?.state).toBe('active');
    expect(registry.get(ended.id)).toBeUndefined();
    expect(registry.all().map((s) => s.id)).toEqual([pending.id, accepted.id]);
  });

  it('times out an active session past its duration, when one is set', () => {
    const registry = new SessionRegistry();
    const onTimeout = vi.fn();
    const requester = { connectionId: 'c1', device: alice };
    const target = { connectionId: 'c2', device: bob };
    const limited = registry.create('notes:a', requester, target, 1_000, onTimeout);
    const unlimited = registry.create('notes:a', requester, target, 1_000, onTimeout);
    vi.advanceTimersByTime(999);
    registry.activate(limited.id, 5_000);
    registry.activate(unlimited.id);
    vi.advanceTimersByTime(4_999);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onTimeout.mock.calls).toEqual([[limited]]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
