import { calculateJwkThumbprint, EmbeddedJWK, jwtVerify, type JWK } from 'jose';
import type { Participant } from './sessions.ts';

const APPROVAL_TYPE = 'blindsignal-pairing+jwt';

/** A pairing request, as each connection taking part keeps it (ADR 0042). */
export interface Pairing {
  readonly id: string;
  readonly namespace: string;
  readonly requester: Participant;
  /** The requester's `cnf.jkt`: the key an approval binds. */
  readonly keyThumbprint: string;
}

/**
 * The approval is a JWT signed by the approving device's key, `approverJkt`, that names this
 * pairing, its requester, and the requester's key. Its `exp` bounds how long a backend accepts it.
 */
export async function approves(
  approval: string,
  pairing: Pairing,
  approverJkt: string,
): Promise<boolean> {
  try {
    // EmbeddedJWK refuses a private or symmetric key in the header.
    const { payload, protectedHeader } = await jwtVerify(approval, EmbeddedJWK, {
      typ: APPROVAL_TYPE,
      algorithms: ['ES256', 'EdDSA'],
      requiredClaims: ['exp'],
    });
    const { userId, deviceId } = pairing.requester.device;
    return (
      payload.pairing_id === pairing.id &&
      payload.namespace === pairing.namespace &&
      payload.sub === userId &&
      payload.device_id === deviceId &&
      payload.jkt === pairing.keyThumbprint &&
      (await calculateJwkThumbprint(protectedHeader.jwk as JWK, 'sha256')) === approverJkt
    );
  } catch {
    return false;
  }
}

/** Pending pairings of one connection, by ID, each ending on its own after a timeout. */
export class PendingPairings<T> {
  readonly #entries = new Map<string, { value: T; timer: ReturnType<typeof setTimeout> }>();

  add(id: string, value: T, timeoutMs: number, onTimeout: (value: T) => void): void {
    const timer = setTimeout(() => {
      this.#entries.delete(id);
      onTimeout(value);
    }, timeoutMs);
    this.#entries.set(id, { value, timer });
  }

  get(id: string): T | undefined {
    return this.#entries.get(id)?.value;
  }

  /** Removes the pairing; its value when it was pending, so only one caller ends it. */
  take(id: string): T | undefined {
    const entry = this.#entries.get(id);
    if (entry === undefined) return undefined;
    clearTimeout(entry.timer);
    this.#entries.delete(id);
    return entry.value;
  }

  /** Removes every pairing, for a connection that closes. */
  takeAll(): T[] {
    return [...this.#entries.keys()].map((id) => this.take(id) as T);
  }
}
