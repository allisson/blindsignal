import { closeCodes, errorClasses, type Payload } from '@blindsignal/protocol';
import { backoffDelay, defaultBackoff, type BackoffOptions } from './backoff.ts';
import { Emitter } from './emitter.ts';
import { BlindSignalError } from './errors.ts';
import { Signaling, type SocketFactory } from './signaling.ts';
import { signalingUrl } from './url.ts';

export interface HeartbeatOptions {
  /** Time between `connection.ping`s. */
  intervalMs: number;
  /** Time without `connection.pong` after which the connection is dead. */
  timeoutMs: number;
}

export interface BlindSignalClientOptions {
  /** `wss://`, or `ws://` on a loopback host. */
  serverUrl: string | URL;
  /** Returns a new access token from the application backend; called for every authentication. */
  accessTokenProvider: () => Promise<string>;
  /** How long before the token expires `auth.refresh` is sent. Defaults to 60 s. */
  refreshMarginMs?: number;
  /** Retry delays for reconnects and failed refreshes. Defaults to 1 s doubling up to 30 s. */
  backoff?: BackoffOptions;
  /** How long a connection stays authenticated before the reconnect count resets. Defaults to 30 s. */
  backoffResetMs?: number;
  /** Defaults to a ping every 25 s and a 10 s pong timeout. */
  heartbeat?: HeartbeatOptions;
  /** Creates the WebSocket; tests replace it. */
  createSocket?: SocketFactory;
}

export interface Identity {
  userId: string;
  deviceId: string;
}

/** `connecting` covers the first attempt and every reconnect, backoff waits included. */
export type ConnectionState = 'disconnected' | 'connecting' | 'connected';

export type Presence = Payload<'presence.changed'>;

export type Device = Payload<'discovery.result'>['devices'][number];

export interface ClientEvents extends Record<string, unknown> {
  /** `error` says why the client stopped: a terminal or superseded code (docs/protocol.md §9). */
  state: { state: ConnectionState; error?: BlindSignalError['code'] };
  /** Another device appeared in or left a joined namespace. */
  presence: Presence;
  /** A namespace could not be joined again after a reconnect, and is no longer joined. */
  rejoinFailed: { namespace: string; error: BlindSignalError['code'] };
}

type IceConfig = Payload<'rtc.ice_config'>;

const defaultHeartbeat: HeartbeatOptions = { intervalMs: 25_000, timeoutMs: 10_000 };

/** Whether an error code stops reconnecting: terminal and superseded classes (docs/protocol.md §9). */
function stops(code: BlindSignalError['code']): boolean {
  return code in errorClasses && errorClasses[code as keyof typeof errorClasses] !== 'retryable';
}

function retryAfter(error: unknown): number {
  return (error instanceof BlindSignalError && error.retryAfterMs) || 0;
}

/**
 * The application's handle on BlindSignal: one authenticated signaling connection, kept alive with
 * heartbeats, refreshed before its token expires, and reopened with backoff when it drops.
 */
export class BlindSignalClient extends Emitter<ClientEvents> {
  readonly #options: BlindSignalClientOptions;
  #state: ConnectionState = 'disconnected';
  #identity: Identity | undefined;
  #signaling: Signaling | undefined;
  #iceConfig: IceConfig | undefined;
  /** Namespaces the application joined and has not left, joined again after a reconnect. */
  readonly #namespaces = new Set<string>();
  /** Bumped by close(), so an attempt in flight discards its result. */
  #generation = 0;
  #attempts = 0;
  #connectedAt = 0;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #refreshTimer: ReturnType<typeof setTimeout> | undefined;
  #pingTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: BlindSignalClientOptions) {
    super();
    signalingUrl(options.serverUrl);
    this.#options = options;
  }

  get state(): ConnectionState {
    return this.#state;
  }

  /** The last `rtc.ice_config` received, for the WebRTC layer. Never exposes it elsewhere. */
  get iceConfig(): IceConfig | undefined {
    return this.#iceConfig;
  }

  /**
   * Connects, retrying with backoff, and resolves once authenticated. Rejects when the client
   * stops: a terminal or superseded error, or close().
   */
  connect(): Promise<Identity> {
    if (this.#state === 'connected') return Promise.resolve(this.#identity!);
    const settled = new Promise<Identity>((resolve, reject) => {
      const off = this.on('state', ({ state, error }) => {
        if (state === 'connected') resolve(this.#identity!);
        else if (state === 'disconnected')
          reject(new BlindSignalError(error ?? 'connection_closed'));
        else return;
        off();
      });
    });
    if (this.#state === 'disconnected') {
      this.#attempts = 0;
      this.#setState('connecting');
      void this.#open();
    }
    return settled;
  }

  /** Joins a namespace: presence there, its `presence` events, and discovery. */
  async join(namespace: string): Promise<void> {
    await this.#current().request('namespace.join', { namespace });
    this.#namespaces.add(namespace);
  }

  async leave(namespace: string): Promise<void> {
    this.#namespaces.delete(namespace);
    await this.#signaling?.request('namespace.leave', { namespace });
  }

  /** The other devices present in a joined namespace. */
  async discover(namespace: string): Promise<Device[]> {
    const result = await this.#current().request('discovery.request', { namespace });
    return result.payload.devices;
  }

  /** Closes the connection and stops reconnecting. */
  close(): void {
    this.#generation++;
    clearTimeout(this.#reconnectTimer);
    this.#teardown();
    if (this.#state !== 'disconnected') this.#setState('disconnected');
  }

  #current(): Signaling {
    if (this.#signaling === undefined) throw new BlindSignalError('connection_closed');
    return this.#signaling;
  }

  #setState(state: ConnectionState, error?: BlindSignalError['code']): void {
    this.#state = state;
    this.emit('state', error === undefined ? { state } : { state, error });
  }

  async #open(): Promise<void> {
    const generation = this.#generation;
    let signaling: Signaling | undefined;
    try {
      const token = await this.#options.accessTokenProvider();
      if (generation !== this.#generation) return;
      const opened = await Signaling.open(
        signalingUrl(this.#options.serverUrl),
        this.#options.createSocket,
      );
      signaling = opened;
      if (generation !== this.#generation) return;
      opened.on('message', (message) => {
        if (message.type === 'rtc.ice_config') this.#iceConfig = message.payload;
        else if (message.type === 'presence.changed') this.emit('presence', message.payload);
      });
      opened.on('close', ({ code, error }) => this.#lost(opened, code, error));
      const result = await opened.request('auth.authenticate', { token });
      if (generation !== this.#generation) return;
      signaling = undefined;
      this.#signaling = opened;
      this.#identity = { userId: result.payload.userId, deviceId: result.payload.deviceId };
      this.#connectedAt = Date.now();
      this.#scheduleRefresh(result.payload.expiresInMs);
      this.#heartbeat(opened);
      await Promise.all([...this.#namespaces].map((namespace) => this.#rejoin(opened, namespace)));
      // Dropped or closed while rejoining: #lost or close() already moved on.
      if (this.#signaling !== opened) return;
      this.#setState('connected');
    } catch (error) {
      if (generation !== this.#generation) return;
      if (error instanceof BlindSignalError && stops(error.code)) {
        this.#setState('disconnected', error.code);
      } else this.#reconnect(retryAfter(error));
    } finally {
      // An attempt that did not become the connection never keeps its socket.
      signaling?.close();
    }
  }

  async #rejoin(signaling: Signaling, namespace: string): Promise<void> {
    try {
      await signaling.request('namespace.join', { namespace });
    } catch (error) {
      const code = (error as BlindSignalError).code;
      if (code === 'connection_closed') return;
      this.#namespaces.delete(namespace);
      this.emit('rejoinFailed', { namespace, error: code });
    }
  }

  /** The current connection closed, or missed a pong. */
  #lost(signaling: Signaling, code: number, error: BlindSignalError['code'] | undefined): void {
    if (signaling !== this.#signaling) return;
    this.#teardown();
    if (code === 1009) return this.#setState('disconnected', 'message_too_large');
    if (code === closeCodes.terminal || code === closeCodes.superseded) {
      return this.#setState('disconnected', error ?? 'connection_closed');
    }
    const resetMs = this.#options.backoffResetMs ?? 30_000;
    if (Date.now() - this.#connectedAt >= resetMs) this.#attempts = 0;
    this.#reconnect(0);
  }

  #reconnect(retryAfterMs: number): void {
    const backoff = this.#options.backoff ?? defaultBackoff;
    const delay = Math.max(backoffDelay(this.#attempts++, backoff), retryAfterMs);
    if (this.#state !== 'connecting') this.#setState('connecting');
    this.#reconnectTimer = setTimeout(() => void this.#open(), delay);
  }

  #teardown(): void {
    clearTimeout(this.#refreshTimer);
    clearTimeout(this.#pingTimer);
    this.#signaling?.close();
    this.#signaling = undefined;
  }

  #heartbeat(signaling: Signaling): void {
    const { intervalMs, timeoutMs } = this.#options.heartbeat ?? defaultHeartbeat;
    this.#pingTimer = setTimeout(() => {
      const dead = setTimeout(() => this.#lost(signaling, 1006, undefined), timeoutMs);
      // Any reply, `error` included, shows the server is alive.
      void signaling
        .request('connection.ping', {})
        .catch(() => undefined)
        .then(() => {
          clearTimeout(dead);
          if (this.#signaling === signaling) this.#heartbeat(signaling);
        });
    }, intervalMs);
  }

  #scheduleRefresh(expiresInMs: number): void {
    const expiresAt = Date.now() + expiresInMs;
    const margin = this.#options.refreshMarginMs ?? 60_000;
    this.#refreshTimer = setTimeout(() => void this.#refresh(expiresAt, 0), expiresInMs - margin);
  }

  /** Retries with backoff until the token expires; then the server closes with `token_expired`. */
  async #refresh(expiresAt: number, attempt: number): Promise<void> {
    const signaling = this.#signaling;
    if (signaling === undefined) return;
    try {
      const token = await this.#options.accessTokenProvider();
      const result = await signaling.request('auth.refresh', { token });
      if (this.#signaling === signaling) this.#scheduleRefresh(result.payload.expiresInMs);
    } catch (error) {
      if (this.#signaling !== signaling) return;
      const backoff = this.#options.backoff ?? defaultBackoff;
      const delay = Math.max(backoffDelay(attempt, backoff), retryAfter(error));
      if (Date.now() + delay >= expiresAt) return;
      this.#refreshTimer = setTimeout(() => void this.#refresh(expiresAt, attempt + 1), delay);
    }
  }
}
