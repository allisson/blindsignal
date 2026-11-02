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
}

const deviceKey = ({ appId, userId, deviceId }: DeviceIdentity) =>
  JSON.stringify([appId, userId, deviceId]);

/**
 * The process's sessions and the connection of each authenticated device (ADRs 0003, 0004).
 * shortcut: process-local, so sessions only reach devices on the same instance; Phase 9 moves
 * this state behind the coordination adapter for multi-instance deployments.
 */
export class SessionRegistry {
  readonly #sessions = new Map<string, Entry>();
  readonly #connections = new Map<string, string>();

  /** Makes the connection the device's current one, replacing any older one (ADR 0008). */
  register(device: DeviceIdentity, connectionId: string): void {
    this.#connections.set(deviceKey(device), connectionId);
  }

  /** Removes the device's connection only while `connectionId` is still the current one. */
  unregister(device: DeviceIdentity, connectionId: string): void {
    const key = deviceKey(device);
    if (this.#connections.get(key) === connectionId) this.#connections.delete(key);
  }

  connectionOf(device: DeviceIdentity): string | undefined {
    return this.#connections.get(deviceKey(device));
  }

  /** Creates a `pending` session; `onTimeout` runs if it is still pending after `timeoutMs`. */
  create(
    namespace: string,
    requester: Participant,
    target: Participant,
    timeoutMs: number,
    onTimeout: (session: Session) => void,
  ): Session {
    const entry: Entry = {
      id: crypto.randomUUID(),
      namespace,
      requester,
      target,
      state: 'pending',
      timer: undefined,
    };
    entry.timer = setTimeout(() => onTimeout(entry), timeoutMs);
    this.#sessions.set(entry.id, entry);
    return entry;
  }

  /** Sessions pending or active. */
  get size(): number {
    return this.#sessions.size;
  }

  get(sessionId: string): Session | undefined {
    return this.#sessions.get(sessionId);
  }

  /** Moves a `pending` session to `active` and disarms its negotiation timeout. */
  activate(sessionId: string): void {
    const entry = this.#sessions.get(sessionId);
    if (entry === undefined) return;
    entry.state = 'active';
    clearTimeout(entry.timer);
  }

  /** Removes the session; true when it existed, so only one caller ends it. */
  end(sessionId: string): boolean {
    const entry = this.#sessions.get(sessionId);
    if (entry === undefined) return false;
    clearTimeout(entry.timer);
    return this.#sessions.delete(sessionId);
  }

  /** The sessions the connection participates in. */
  of(connectionId: string): Session[] {
    return [...this.#sessions.values()].filter(
      (s) => s.requester.connectionId === connectionId || s.target.connectionId === connectionId,
    );
  }
}
