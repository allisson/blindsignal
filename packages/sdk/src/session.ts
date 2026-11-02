import type { Payload, RelayedMessage } from '@blindsignal/protocol';
import { Emitter } from './emitter.ts';
import type { ChannelData, PeerLink } from './webrtc/peer.ts';

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
  /** Signaling for the session ended; an open DataChannel may outlive it (see `close`). */
  ended: { reason: SessionEndReason };
  /** The DataChannel opened: send() works from now on. */
  open: undefined;
  data: string | ArrayBuffer;
  /** The DataChannel closed, or the connection failed before it opened. */
  close: undefined;
}

/** Signaling ends but an open DataChannel stays: only the signaling path was lost (spec §6.4). */
const keepsChannel = new Set<SessionEndReason>(['peer_disconnected', 'disconnected']);

/** One session with a peer (docs/protocol.md §7) and its DataChannel. */
export class Session extends Emitter<SessionEvents> {
  readonly id: string;
  readonly peer: Peer;
  readonly role: 'requester' | 'target';
  #state: SessionState;
  readonly #link: PeerLink;
  readonly #onClose: () => void;

  /** @internal Created by BlindSignalClient. */
  constructor(
    init: { id: string; peer: Peer; role: Session['role']; state: SessionState },
    link: PeerLink,
    onClose: () => void,
  ) {
    super();
    this.id = init.id;
    this.peer = init.peer;
    this.role = init.role;
    this.#state = init.state;
    this.#link = link;
    this.#onClose = onClose;
    link.on('open', () => this.emit('open', undefined));
    link.on('data', (data) => this.emit('data', data));
    link.on('close', () => this.emit('close', undefined));
  }

  get state(): SessionState {
    return this.#state;
  }

  /** Sends on the DataChannel; throws `InvalidStateError` unless it is open. */
  send(data: ChannelData): void {
    this.#link.send(data);
  }

  /**
   * Ends the session, telling the server when connected (the peer gets `closed_by_peer`), and
   * closes the DataChannel.
   */
  close(): void {
    if (this.#state !== 'ended') {
      this.#onClose();
      this.end('closed');
    }
    this.#link.close();
  }

  /** @internal Only a requester's session starts `pending`; it sends the offer. */
  activate(): void {
    if (this.#state !== 'pending') return;
    this.#state = 'active';
    this.emit('accepted', undefined);
    this.#link.offer();
  }

  /** @internal */
  receive(message: RelayedMessage): void {
    this.#link.receive(message);
  }

  /** @internal Called once: the client forgets a session as it ends it. */
  end(reason: SessionEndReason): void {
    this.#state = 'ended';
    this.emit('ended', { reason });
    if (!(keepsChannel.has(reason) && this.#link.open)) this.#link.close();
  }
}
