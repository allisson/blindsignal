import { describe, expect, it, vi } from 'vitest';
import { Emitter } from './emitter.ts';

class Bus extends Emitter<{ tick: number }> {
  fire(value: number) {
    this.emit('tick', value);
  }
}

describe('Emitter', () => {
  it('calls listeners until they are removed', () => {
    const bus = new Bus();
    const seen: number[] = [];
    const off = bus.on('tick', (n) => seen.push(n));
    bus.on('tick', (n) => seen.push(n * 10));
    bus.fire(1);
    off();
    bus.fire(2);
    expect(seen).toEqual([1, 10, 20]);
  });

  it('keeps calling listeners after one throws, and rethrows asynchronously', () => {
    const rethrown: (() => void)[] = [];
    const spy = vi
      .spyOn(globalThis, 'queueMicrotask')
      .mockImplementation((fn) => rethrown.push(fn));
    const bus = new Bus();
    const seen: number[] = [];
    bus.on('tick', () => {
      throw new Error('listener failed');
    });
    bus.on('tick', (n) => seen.push(n));
    bus.fire(1);
    spy.mockRestore();
    expect(seen).toEqual([1]);
    expect(rethrown).toHaveLength(1);
    expect(() => rethrown[0]?.()).toThrow('listener failed');
  });
});
