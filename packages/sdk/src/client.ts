import { closeCodes, errorClasses, type Payload, type ServerMessage } from '@blindsignal/protocol';
import { backoffDelay, defaultBackoff, type BackoffOptions } from './backoff.ts';
import type { DeviceKey } from './device-key.ts';
import { Emitter } from './emitter.ts';
import { BlindSignalError } from './errors.ts';
import { Session, type Peer } from './session.ts';
import { Signaling, type SocketFactory } from './signaling.ts';
import { signalingUrl } from './url.ts';
import { PeerLink, type PeerConnectionFactory } from './webrtc/peer.ts';

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
  /**
   * Proves on every authentication that this device holds the key its tokens are bound to
   * (ADR 0041): the backend puts `deviceKey.thumbprint` in each token's `cnf.jkt`. The client then
   * waits up to `heartbeat.timeoutMs` for the server's challenge before authenticating.
   */
  deviceKey?: DeviceKey;
  /** How long before the token expires `auth.refresh` is sent. Defaults to 60 s. */
  refreshMarginMs?: number;
  /** Retry delays for reconnects and failed refreshes. Defaults to 1 s doubling up to 30 s. */
  backoff?: BackoffOptions;
  /** How long a connection stays authenticated before the reconnect count resets. Defaults to 30 s. */
  backoffResetMs?: number;
  /** Defaults to a ping every 25 s and a 10 s pong timeout. */
  heartbeat?: HeartbeatOptions;
  /** STUN servers only; TURN servers and credentials come from the server (spec §12.3). */
  iceServers?: RTCIceServer[];
  /** `relay` uses TURN candidates only, hiding this device's addresses from peers. Defaults to `all`. */
  iceTransportPolicy?: RTCIceTransportPolicy;
  /** ICE restarts the requester tries in a row before a failed connection closes. Defaults to 3. */
  maxIceRestarts?: number;
  /** Time a connection has to connect after each offer/answer exchange before it counts as failed. Defaults to 30 s. */
  connectTimeoutMs?: number;
  /** Creates the WebSocket; tests replace it. */
  createSocket?: SocketFactory;
  /** Creates each session's RTCPeerConnection; tests replace it. */
  createPeerConnection?: PeerConnectionFactory;
}

export interface Identity {
  userId: string;
  deviceId: string;
}

/** `connecting` covers the first attempt and every reconnect, backoff waits included. */
export type ConnectionState = 'disconnected' | 'connecting' | 'connected';

export type Presence = Payload<'presence.changed'>;

export type Device = Payload<'discovery.result'>['devices'][number];

/**
 * A new device of this user asks to be paired into a namespace (ADR 0042). approve() signs the
 * approval with this client's device key. Unanswered, it ends with `pairingEnded`.
 */
export interface PairingRequest {
  readonly pairingId: string;
  readonly namespace: string;
  readonly userId: string;
  readonly deviceId: string;
  /** The new device's key thumbprint, which the approval binds. */
  readonly jkt: string;
  approve(): Promise<void>;
  reject(): Promise<void>;
}

/** How a pairing request ended for the device that asked; `approval` goes to its backend. */
export type PairingResult =
  { status: 'approved'; approval: string } | { status: 'rejected' } | { status: 'timeout' };

/** A peer asks for a session; answer with accept() or reject(). Unanswered, it times out. */
export interface SessionRequest extends Peer {
  readonly sessionId: string;
  accept(): Promise<Session>;
  reject(): Promise<void>;
}

export interface ClientEvents extends Record<string, unknown> {
  /** `error` says why the client stopped: a terminal or superseded code (docs/protocol.md §9). */
  state: { state: ConnectionState; error?: BlindSignalError['code'] };
  /** Another device appeared in or left a joined namespace. */
  presence: Presence;
  /** A namespace could not be joined again after a reconnect, and is no longer joined. */
  rejoinFailed: { namespace: string; error: BlindSignalError['code'] };
  sessionRequest: SessionRequest;
  pairingRequest: PairingRequest;
  /** A pairing request this device was asked ended unanswered by it. */
  pairingEnded: Payload<'pairing.ended'>;
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
  /** Sessions not yet ended, by ID. They end when the connection drops (ADR 0004). */
  readonly #sessions = new Map<string, Session>();
  /** Every RTCPeerConnection not yet closed, its session ended or not. */
  readonly #links = new Set<PeerLink>();
  /** The STUN servers of the options, checked and copied once (spec §11). */
  readonly #iceServers: RTCIceServer[];
  /** Pairings this device asked for and awaits, by ID. They fail when the connection drops. */
  readonly #pairings = new Map<string, PromiseWithResolvers<PairingResult>>();
  /** Bumped by close(), so an attempt in flight discards its result. */
  #generation = 0;
  #attempts = 0;
  #connectedAt = 0;
  /** When the connection's current token expires; a refresh that changes it supersedes older retries. */
  #expiresAt = 0;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #refreshTimer: ReturnType<typeof setTimeout> | undefined;
  #pingTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: BlindSignalClientOptions) {
    super();
    signalingUrl(options.serverUrl);
    // Copied, so a change to the caller's array after this check cannot add TURN or a credential.
    this.#iceServers = (options.iceServers ?? []).map((server) => {
      const { urls } = server;
      if (
        ![urls].flat().every((url) => /^stuns?:/i.test(url)) ||
        'username' in server ||
        'credential' in server
      ) {
        throw new TypeError(
          'iceServers accepts STUN URLs only, without credentials; TURN comes from rtc.ice_config',
        );
      }
      return { urls: Array.isArray(urls) ? [...urls] : urls };
    });
    this.#options = options;
  }

  get state(): ConnectionState {
    return this.#state;
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

  /** Asks a device for a session; the result is `pending` until the target accepts. */
  async createSession({ namespace, userId, deviceId }: Peer): Promise<Session> {
    const peer = { namespace, userId, deviceId };
    const signaling = this.#current();
    const created = await signaling.request('session.create', peer);
    if (this.#signaling !== signaling) throw new BlindSignalError('connection_closed');
    return this.#track(created.payload.sessionId, peer, 'requester', 'pending');
  }

  /**
   * Asks this user's devices present in `namespace` to approve this one (ADR 0042). Needs a
   * `deviceKey`, and a token listing the namespace in its `pairing` claim.
   */
  async requestPairing(namespace: string): Promise<PairingResult> {
    if (this.#options.deviceKey === undefined) {
      throw new TypeError('pairing needs a deviceKey');
    }
    const signaling = this.#current();
    const created = await signaling.request('pairing.create', { namespace });
    if (this.#signaling !== signaling) throw new BlindSignalError('connection_closed');
    const pending = Promise.withResolvers<PairingResult>();
    this.#pairings.set(created.payload.pairingId, pending);
    return pending.promise;
  }

  /**
   * Sends `auth.refresh` now with a new token from the provider, for when the backend changed what
   * the token grants, such as a namespace after a pairing. Rejects with a `BlindSignalError`, and the
   * connection stays on its current token; the scheduled refresh goes on.
   */
  async refresh(): Promise<void> {
    await this.#renew(this.#current());
  }

  /** Closes the connection and stops reconnecting. Open DataChannels stay open until their sessions close. */
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
      opened.on('message', (message) => this.#receive(message));
      opened.on('close', ({ code, error }) => this.#lost(opened, code, error));
      const proof = await this.#prove(opened, token);
      if (generation !== this.#generation) return;
      const result = await opened.request('auth.authenticate', { token, ...proof });
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
        this.#stop(
          error.code,
          errorClasses[error.code as keyof typeof errorClasses] === 'terminal',
        );
      } else this.#reconnect(retryAfter(error));
    } finally {
      // An attempt that did not become the connection never keeps its socket.
      signaling?.close();
    }
  }

  /** With a device key, the proof for `token` on this connection, once its challenge arrives. */
  async #prove(signaling: Signaling, token: string): Promise<{ proof?: string }> {
    const key = this.#options.deviceKey;
    if (key === undefined) return {};
    const { timeoutMs } = this.#options.heartbeat ?? defaultHeartbeat;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new BlindSignalError('connection_closed')), timeoutMs);
    });
    try {
      return { proof: await key.proof(token, await Promise.race([signaling.challenge, timeout])) };
    } finally {
      clearTimeout(timer);
    }
  }

  #receive(message: ServerMessage): void {
    switch (message.type) {
      case 'rtc.ice_config':
        this.#iceConfig = message.payload;
        return;
      case 'presence.changed':
        this.emit('presence', message.payload);
        return;
      case 'session.request':
        this.emit('sessionRequest', this.#sessionRequest(message.payload));
        return;
      case 'session.accepted':
        this.#sessions.get(message.payload.sessionId)?.activate();
        return;
      case 'session.rejected':
        this.#end(message.payload.sessionId, 'rejected');
        return;
      case 'session.terminated':
        this.#end(message.payload.sessionId, message.payload.reason);
        return;
      case 'pairing.request':
        this.emit('pairingRequest', this.#pairingRequest(message.payload));
        return;
      case 'pairing.approved':
        return this.#settle(message.payload.pairingId, {
          status: 'approved',
          approval: message.payload.approval,
        });
      case 'pairing.rejected':
        return this.#settle(message.payload.pairingId, { status: 'rejected' });
      case 'pairing.ended': {
        // The device that asked hears only of its timeout, or of a refresh that withdrew the
        // namespace; an asked one, of any end.
        const { pairingId, reason } = message.payload;
        const pending = this.#pairings.get(pairingId);
        if (pending !== undefined) {
          this.#pairings.delete(pairingId);
          if (reason === 'namespace_unauthorized') {
            return pending.reject(new BlindSignalError('not_authorized'));
          }
          return pending.resolve({ status: 'timeout' });
        }
        this.emit('pairingEnded', message.payload);
        return;
      }
      case 'rtc.offer':
      case 'rtc.answer':
      case 'rtc.ice_candidate':
        this.#sessions.get(message.payload.sessionId)?.receive(message);
        return;
    }
  }

  #sessionRequest({ sessionId, ...peer }: Payload<'session.request'>): SessionRequest {
    return {
      sessionId,
      ...peer,
      accept: async () => {
        const signaling = this.#current();
        await signaling.request('session.accept', { sessionId });
        if (this.#signaling !== signaling) throw new BlindSignalError('connection_closed');
        return this.#track(sessionId, peer, 'target', 'active');
      },
      reject: async () => {
        await this.#current().request('session.reject', { sessionId });
      },
    };
  }

  #pairingRequest(asked: Payload<'pairing.request'>): PairingRequest {
    const { pairingId } = asked;
    return {
      ...asked,
      approve: async () => {
        const key = this.#options.deviceKey;
        // The server asks only devices whose tokens are bound, and those need the key.
        if (key === undefined) throw new TypeError('pairing needs a deviceKey');
        const signaling = this.#current();
        await signaling.request('pairing.approve', {
          pairingId,
          approval: await key.approval(asked),
        });
      },
      reject: async () => {
        await this.#current().request('pairing.reject', { pairingId });
      },
    };
  }

  #settle(pairingId: string, result: PairingResult): void {
    this.#pairings.get(pairingId)?.resolve(result);
    this.#pairings.delete(pairingId);
  }

  #track(id: string, peer: Peer, role: Session['role'], state: 'pending' | 'active'): Session {
    // Only while the session lasts: after it ends, the server has no session to relay through.
    const signaling = (): boolean => this.#sessions.get(id) === session;
    const link = new PeerLink({
      sessionId: id,
      role,
      configuration: () => ({
        iceServers: [...this.#iceServers, ...(this.#iceConfig?.iceServers ?? [])],
        ...(this.#options.iceTransportPolicy && {
          iceTransportPolicy: this.#options.iceTransportPolicy,
        }),
      }),
      // A relay the server refuses gets an `error` that nothing waits for; session.terminated follows.
      relay: (type, payload) => {
        if (signaling()) this.#signaling?.relay(type, payload);
      },
      signaling,
      maxIceRestarts: this.#options.maxIceRestarts ?? 3,
      connectTimeoutMs: this.#options.connectTimeoutMs ?? 30_000,
      createPeerConnection:
        this.#options.createPeerConnection ??
        ((configuration) => new RTCPeerConnection(configuration)),
    });
    this.#links.add(link);
    link.on('close', () => this.#links.delete(link));
    const session: Session = new Session({ id, peer, role, state }, link, () => {
      this.#sessions.delete(id);
      // Best effort: a session the server already ended answers session_unavailable.
      this.#signaling?.request('session.close', { sessionId: id }).catch(() => undefined);
    });
    this.#sessions.set(id, session);
    return session;
  }

  #end(id: string, reason: Parameters<Session['end']>[0]): void {
    const session = this.#sessions.get(id);
    this.#sessions.delete(id);
    session?.end(reason);
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
    if (code === 1009) return this.#stop('message_too_large', true);
    if (code === closeCodes.terminal || code === closeCodes.superseded) {
      return this.#stop(error ?? 'connection_closed', code === closeCodes.terminal);
    }
    const resetMs = this.#options.backoffResetMs ?? 30_000;
    if (Date.now() - this.#connectedAt >= resetMs) this.#attempts = 0;
    this.#reconnect(0);
  }

  /** Stops reconnecting; a terminal stop also closes every DataChannel (spec §6.4). */
  #stop(error: BlindSignalError['code'], terminal: boolean): void {
    if (terminal) for (const link of [...this.#links]) link.close();
    this.#setState('disconnected', error);
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
    for (const id of [...this.#sessions.keys()]) this.#end(id, 'disconnected');
    for (const pending of this.#pairings.values()) {
      pending.reject(new BlindSignalError('connection_closed'));
    }
    this.#pairings.clear();
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
    clearTimeout(this.#refreshTimer);
    this.#expiresAt = Date.now() + expiresInMs;
    const margin = this.#options.refreshMarginMs ?? 60_000;
    this.#refreshTimer = setTimeout(() => void this.#refresh(0), expiresInMs - margin);
  }

  async #renew(signaling: Signaling): Promise<void> {
    const token = await this.#options.accessTokenProvider();
    const proof = await this.#prove(signaling, token);
    const result = await signaling.request('auth.refresh', { token, ...proof });
    if (this.#signaling !== signaling) throw new BlindSignalError('connection_closed');
    this.#scheduleRefresh(result.payload.expiresInMs);
  }

  /** Retries with backoff until the token expires; then the server closes with `token_expired`. */
  async #refresh(attempt: number): Promise<void> {
    const signaling = this.#signaling;
    if (signaling === undefined) return;
    const expiresAt = this.#expiresAt;
    try {
      await this.#renew(signaling);
    } catch (error) {
      // Dropped, or a refresh() renewed the token meanwhile and scheduled the next one.
      if (this.#signaling !== signaling || this.#expiresAt !== expiresAt) return;
      const backoff = this.#options.backoff ?? defaultBackoff;
      const delay = Math.max(backoffDelay(attempt, backoff), retryAfter(error));
      if (Date.now() + delay >= expiresAt) return;
      this.#refreshTimer = setTimeout(() => void this.#refresh(attempt + 1), delay);
    }
  }
}
