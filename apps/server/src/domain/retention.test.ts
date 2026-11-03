import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sweepDevices } from './retention.ts';

describe('sweepDevices', () => {
  beforeEach(() => vi.useFakeTimers({ now: 10_000 }));
  afterEach(() => vi.useRealTimers());

  it('deletes expired records on every interval, logs failures, and stops', async () => {
    const results = [2, new Error('down'), 0];
    const deleteExpired = vi.fn<(now: Date, ttlMs: number) => Promise<number>>(() => {
      const next = results.shift();
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next as number);
    });
    const logs: object[] = [];
    const stop = sweepDevices(
      { deleteExpired },
      { intervalMs: 1000, ttlMs: 500 },
      { log: (level, event, fields) => logs.push({ level, event, ...fields }) },
    );

    await vi.advanceTimersByTimeAsync(999);
    expect(deleteExpired).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3000);
    expect(deleteExpired.mock.calls).toEqual([
      [new Date(11_000), 500],
      [new Date(12_000), 500],
      [new Date(13_000), 500],
    ]);
    expect(logs).toEqual([
      { level: 'info', event: 'devices.expired', deleted: 2 },
      { level: 'warn', event: 'devices.sweep_failed' },
    ]);

    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(deleteExpired).toHaveBeenCalledTimes(3);
  });
});
