import { describe, expect, it } from 'vitest';
import { applicationLimits, type Limits } from './limits.ts';

const policy = (ratePerSecond: number, burst: number) => ({ ratePerSecond, burst });

const defaults: Limits = {
  quotas: {
    connections: 10,
    devices: 20,
    sessions: 30,
    sessionsPerDevice: 4,
    namespacesPerDevice: 5,
  },
  rateLimits: {
    discovery: policy(1, 2),
    session_create: policy(1, 3),
    signaling: policy(10, 20),
    rtc: policy(5, 10),
    rtc_ice_candidate: policy(5, 15),
  },
};

describe('applicationLimits', () => {
  it('takes the server defaults where the application sets nothing', () => {
    expect(applicationLimits(defaults, { quotas: {}, rateLimits: {} })).toEqual(defaults);
  });

  it('takes each limit the application sets, and only those', () => {
    const limits = applicationLimits(defaults, {
      quotas: { sessions: 300, devices: 2 },
      rateLimits: { rtc: policy(50, 100) },
    });
    expect(limits).toEqual({
      quotas: { ...defaults.quotas, sessions: 300, devices: 2 },
      rateLimits: { ...defaults.rateLimits, rtc: policy(50, 100) },
    });
    expect(defaults.quotas.sessions).toBe(30);
  });
});
