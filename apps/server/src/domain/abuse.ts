/** When an application's rejections become an abuse alert (ADR 0016). */
export interface AbuseAlertPolicy {
  /** Rejections within one window that raise an alert; 0 turns alerts off. */
  readonly threshold: number;
  readonly windowMs: number;
}

/**
 * Counts each application's `rate_limited` and `quota_exceeded` rejections in fixed windows, so
 * an operator learns of abnormal usage (spec §8.3). It only alerts: suspension stays with the
 * operator, through the registry (ADR 0005).
 */
export class AbuseMonitor {
  readonly #policy: AbuseAlertPolicy;
  readonly #now: () => number;
  // One entry per application seen, so its size is bounded by the registry.
  readonly #windows = new Map<string, { start: number; count: number }>();

  constructor(policy: AbuseAlertPolicy, now: () => number = Date.now) {
    this.#policy = policy;
    this.#now = now;
  }

  /** Records one rejection; true once per window, when the count reaches the threshold. */
  record(appId: string): boolean {
    const { threshold, windowMs } = this.#policy;
    if (threshold === 0) return false;
    const now = this.#now();
    let window = this.#windows.get(appId);
    if (window === undefined || now - window.start >= windowMs) {
      window = { start: now, count: 0 };
      this.#windows.set(appId, window);
    }
    window.count++;
    return window.count === threshold;
  }
}
