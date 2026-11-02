import {
  closeCodes,
  messages,
  parseServerMessage,
  PROTOCOL_VERSION,
  type ErrorCode,
  type Message,
  type MessageType,
  type Payload,
  type ServerMessage,
} from '@blindsignal/protocol';
import { Emitter } from './emitter.ts';
import { BlindSignalError } from './errors.ts';

type Catalog = typeof messages;

/** Client-sent types that get a reply (docs/protocol.md §3). */
export type RequestType = {
  [K in MessageType]: Catalog[K] extends { reply: string } ? K : never;
}[MessageType];

export type RelayType = {
  [K in MessageType]: Catalog[K]['direction'] extends 'relay' ? K : never;
}[MessageType];

export type ReplyTo<T extends RequestType> = Catalog[T] extends {
  reply: infer R extends MessageType;
}
  ? Message<R>
  : never;

export interface SignalingEvents extends Record<string, unknown> {
  /** A server event, a relayed message, or a reply to no pending request (a relay failure). */
  message: ServerMessage;
  /** `error` is the last error code received, when the close code is a protocol class code. */
  close: { code: number; error?: ErrorCode };
}

export type SocketFactory = (url: URL) => WebSocket;

interface Pending {
  reply: MessageType;
  resolve: (message: ServerMessage) => void;
  reject: (error: BlindSignalError) => void;
}

const classCloseCodes = new Set<number>(Object.values(closeCodes));

/** One WebSocket connection: framing, request/reply correlation, and inbound validation. */
export class Signaling extends Emitter<SignalingEvents> {
  readonly #socket: WebSocket;
  readonly #pending = new Map<string, Pending>();
  #nextId = 0;
  #closed = false;
  #lastError: ErrorCode | undefined;

  private constructor(socket: WebSocket) {
    super();
    this.#socket = socket;
    socket.addEventListener('message', (event) => this.#receive(event.data));
    socket.addEventListener('close', (event) => this.#onClose(event.code), { once: true });
  }

  /** Opens a connection; rejects with `connection_closed` if it closes before opening. */
  static open(url: URL, createSocket: SocketFactory = (u) => new WebSocket(u)): Promise<Signaling> {
    const socket = createSocket(url);
    return new Promise((resolve, reject) => {
      const onClose = () => reject(new BlindSignalError('connection_closed'));
      socket.addEventListener('close', onClose, { once: true });
      socket.addEventListener(
        'open',
        () => {
          socket.removeEventListener('close', onClose);
          resolve(new Signaling(socket));
        },
        { once: true },
      );
    });
  }

  /** Sends a request; resolves to its reply, or rejects with the `error` the server sent. */
  request<T extends RequestType>(type: T, payload: Payload<T>): Promise<ReplyTo<T>> {
    if (this.#closed) return Promise.reject(new BlindSignalError('connection_closed'));
    const requestId = this.#send(type, payload);
    return new Promise((resolve, reject) => {
      this.#pending.set(requestId, {
        reply: messages[type].reply,
        resolve: resolve as (message: ServerMessage) => void,
        reject,
      });
    });
  }

  /**
   * Sends a relayed message and returns its `requestId`. Success gets no reply; a failure arrives
   * as a `message` event carrying that `requestId`.
   */
  relay<T extends RelayType>(type: T, payload: Payload<T>): string {
    if (this.#closed) throw new BlindSignalError('connection_closed');
    return this.#send(type, payload);
  }

  close(): void {
    this.#socket.close(1000);
  }

  #send(type: MessageType, payload: object): string {
    const requestId = `r${++this.#nextId}`;
    this.#socket.send(JSON.stringify({ version: PROTOCOL_VERSION, type, requestId, payload }));
    return requestId;
  }

  #receive(data: unknown): void {
    // The server sends only text frames; anything invalid is not processed (ADR 0002).
    if (typeof data !== 'string') return;
    const parsed = parseServerMessage(data);
    if (!parsed.ok) return;
    const message = parsed.message;
    if (message.type === 'error') this.#lastError = message.payload.code;
    const id = message.requestId;
    const pending = id === undefined ? undefined : this.#pending.get(id);
    if (id === undefined || pending === undefined) {
      this.emit('message', message);
      return;
    }
    this.#pending.delete(id);
    if (message.type === 'error') {
      pending.reject(new BlindSignalError(message.payload.code, message.payload.retryAfterMs));
    } else if (message.type === pending.reply) {
      pending.resolve(message);
    } else {
      pending.reject(new BlindSignalError('protocol_error'));
    }
  }

  #onClose(code: number): void {
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      pending.reject(new BlindSignalError('connection_closed'));
    }
    const error = classCloseCodes.has(code) ? this.#lastError : undefined;
    this.emit('close', error === undefined ? { code } : { code, error });
  }
}
