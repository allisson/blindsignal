import type { DeviceIdentity } from '@blindsignal/core';

export interface Participant {
  readonly connectionId: string;
  readonly device: DeviceIdentity;
}

export interface Session {
  readonly id: string;
  readonly namespace: string;
  readonly requester: Participant;
  readonly target: Participant;
  readonly state: 'pending' | 'active';
}

interface Entry extends Session {
  state: 'pending' | 'active';
  timer: ReturnType<typeof setTimeout> | undefined;
  readonly createdAt: number;
  readonly onTimeout: (session: Session) => void;
}

/**
 * One connection's copy of the sessions it participates in (ADRs 0003, 0004). The other
 * participant's connection, on this instance or another, keeps its own copy, and the two stay in
 * step through events on each connection's topic (ADR 0023).
 */
export class SessionRegistry {
  readonly #sessions = new Map<string, Entry>();

  /**
   * Creates a `pending` session; `onTimeout` runs if it is still pending after `timeoutMs`, or
   * active past the duration `activate` sets.
   */
  create(
    namespace: string,
    requester: Participant,
    target: Participant,
    timeoutMs: number,
    onTimeout: (session: Session) => void,
    id: string = crypto.randomUUID(),
  ): Session {
    const entry: Entry = {
      id,
      namespace,
      requester,
      target,
      state: 'pending',
      timer: undefined,
      createdAt: performance.now(),
      onTimeout,
    };
    entry.timer = setTimeout(() => onTimeout(entry), timeoutMs);
    this.#sessions.set(entry.id, entry);
    return entry;
  }

  get(sessionId: string): Session | undefined {
    return this.#sessions.get(sessionId);
  }

  /**
   * Moves a `pending` session to `active` and disarms its negotiation timeout; a `durationMs`
   * above 0 arms the maximum session duration (ADR 0014). Returns how long it was pending, in
   * milliseconds, or undefined when it was not pending.
   */
  activate(sessionId: string, durationMs = 0): number | undefined {
    const entry = this.#sessions.get(sessionId);
    if (entry?.state !== 'pending') return undefined;
    entry.state = 'active';
    clearTimeout(entry.timer);
    entry.timer = durationMs > 0 ? setTimeout(() => entry.onTimeout(entry), durationMs) : undefined;
    return performance.now() - entry.createdAt;
  }

  /** Removes the session; true when it existed, so only one caller ends it. */
  end(sessionId: string): boolean {
    const entry = this.#sessions.get(sessionId);
    if (entry === undefined) return false;
    clearTimeout(entry.timer);
    return this.#sessions.delete(sessionId);
  }

  /** Sessions pending or active. */
  all(): Session[] {
    return [...this.#sessions.values()];
  }
}
