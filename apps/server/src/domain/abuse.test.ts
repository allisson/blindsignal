import { describe, expect, it } from 'vitest';
import { AbuseMonitor } from './abuse.ts';

const monitor = (threshold: number, windowMs = 1000) => {
  let now = 0;
  const abuse = new AbuseMonitor({ threshold, windowMs }, () => now);
  const record = (times: number, appId = 'notes') =>
    Array.from({ length: times }, () => abuse.record(appId));
  return { record, advance: (ms: number) => (now += ms) };
};

describe('AbuseMonitor', () => {
  it('alerts once per window, when the count reaches the threshold', () => {
    const { record } = monitor(3);
    expect(record(5)).toEqual([false, false, true, false, false]);
  });

  it('starts a new window once the previous one ends', () => {
    const { record, advance } = monitor(2);
    expect(record(1)).toEqual([false]);
    advance(999);
    expect(record(1)).toEqual([true]);
    advance(1);
    expect(record(2)).toEqual([false, true]);
  });

  it('counts each application apart', () => {
    const { record } = monitor(2);
    expect(record(1, 'notes')).toEqual([false]);
    expect(record(1, 'chat')).toEqual([false]);
    expect(record(1, 'notes')).toEqual([true]);
  });

  it('never alerts with a threshold of 0', () => {
    expect(monitor(0).record(3)).toEqual([false, false, false]);
  });

  it('alerts on the first rejection with a threshold of 1', () => {
    expect(monitor(1).record(2)).toEqual([true, false]);
  });
});
