import type { Payload } from '@blindsignal/protocol';
import { Emitter } from './emitter.ts';

export type TerminationReason = Payload<'session.terminated'>['reason'];

/**
 * Why the server-side session ended: a `session.terminated` reason, `rejected` by the target,
 * `closed` by this side, or `disconnected` when this client's own connection dropped (ADR 0004).
 */
export type SessionEndReason = TerminationReason | 'rejected' | 'closed' | 'disconnected';

export type SessionState = 'pending' | 'active' | 'ended';

export interface Peer {
  namespace: string;
  userId: string;
  deviceId: string;
}

export interface SessionEvents extends Record<string, unknown> {
  /** The target accepted; only a requester's session emits it. */
  accepted: undefined;
  ended: { reason: SessionEndReason };
}

/** One signaling session with a peer (docs/protocol.md §7). */
export class Session extends Emitter<SessionEvents> {
  readonly id: string;
  readonly peer: Peer;
  readonly role: 'requester' | 'target';
  #state: SessionState;
  readonly #onClose: () => void;

  /** @internal Created by BlindSignalClient. */
  constructor(
    init: { id: string; peer: Peer; role: Session['role']; state: SessionState },
    onClose: () => void,
  ) {
    super();
    this.id = init.id;
    this.peer = init.peer;
    this.role = init.role;
    this.#state = init.state;
    this.#onClose = onClose;
  }

  get state(): SessionState {
    return this.#state;
  }

  /** Ends the session, telling the server when connected; the peer gets `closed_by_peer`. */
  close(): void {
    if (this.#state === 'ended') return;
    this.#onClose();
    this.end('closed');
  }

  /** @internal */
  activate(): void {
    if (this.#state !== 'pending') return;
    this.#state = 'active';
    this.emit('accepted', undefined);
  }

  /** @internal Called once: the client forgets a session as it ends it. */
  end(reason: SessionEndReason): void {
    this.#state = 'ended';
    this.emit('ended', { reason });
  }
}
