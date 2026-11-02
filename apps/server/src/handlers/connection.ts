import type {
  ConnectionContext,
  CoordinationAdapter,
  DeviceIdentity,
  DeviceRepository,
} from '@blindsignal/core';
import {
  closeCodeFor,
  errorClasses,
  parseClientMessage,
  PROTOCOL_VERSION,
  type ClientMessage,
  type ErrorCode,
  type Payload,
  type ServerMessage,
} from '@blindsignal/protocol';
import type { TokenVerifier } from '../domain/auth.ts';

/** What a handler needs from the transport. */
export interface ConnectionPort {
  send(message: ServerMessage): void;
  close(code: number): void;
}

export interface ConnectionDependencies {
  readonly verifier: Pick<TokenVerifier, 'verify'>;
  readonly devices: Pick<DeviceRepository, 'touch'>;
  readonly coordination: Pick<
    CoordinationAdapter,
    | 'claimDeviceConnection'
    | 'releaseDeviceConnection'
    | 'acquirePresence'
    | 'releasePresence'
    | 'listPresence'
    | 'publish'
    | 'subscribe'
  >;
  readonly iceServers: Payload<'rtc.ice_config'>['iceServers'];
  readonly clockSkewSeconds: number;
  /** Server-wide device quota, unless the application sets its own (ADR 0011). */
  readonly deviceLimits: { readonly ttlMs: number; readonly maxDevices: number };
  /** Renewed on every heartbeat, so it outlives a few missed ones. */
  readonly presenceLeaseMs: number;
  readonly maxMessageBytes?: number;
}

/** Each connection receives events on its own topic, from any instance (ADR 0010). */
export const connectionTopic = (connectionId: string) => `connection:${connectionId}`;

/** Joined connections receive the namespace's `presence.changed` events on it. */
export const presenceTopic = (namespace: string) => `presence:${namespace}`;

const SUPERSEDED = { type: 'superseded' } as const;

type PresenceChanged = Payload<'presence.changed'>;

/** Only the identity leaves the handler: adapters never see a token's namespaces or expiry. */
const identityOf = ({ appId, userId, deviceId }: DeviceIdentity): DeviceIdentity => ({
  appId,
  userId,
  deviceId,
});

const sameDevice = (a: DeviceIdentity, b: DeviceIdentity) =>
  a.appId === b.appId && a.userId === b.userId && a.deviceId === b.deviceId;

/**
 * One WebSocket connection's protocol state, independent of the transport (docs/protocol.md).
 * Frames and events are handled one at a time, in arrival order.
 */
export class Connection {
  readonly id: string;
  readonly #port: ConnectionPort;
  readonly #deps: ConnectionDependencies;
  // shortcut: unbounded per-connection queue; Phase 6 bounds it with the message rate limits.
  #queue: Promise<void> = Promise.resolve();
  #closed = false;
  #context: ConnectionContext | undefined;
  #expiryTimer: ReturnType<typeof setTimeout> | undefined;
  #unsubscribe: (() => Promise<void>) | undefined;
  /** Joined namespaces, each with its presence topic's unsubscribe. */
  readonly #joined = new Map<string, () => Promise<void>>();

  constructor(port: ConnectionPort, deps: ConnectionDependencies, id = crypto.randomUUID()) {
    this.id = id;
    this.#port = port;
    this.#deps = deps;
  }

  /** The authenticated context, or undefined before `auth.authenticate` succeeds. */
  get context(): ConnectionContext | undefined {
    return this.#context;
  }

  /** Resolves once this frame, and every one before it, has been handled. */
  receive(text: string): Promise<void> {
    return this.#enqueue(() => this.#handleFrame(text));
  }

  /** The transport reports the socket closed; releases what the connection holds. */
  closed(): Promise<void> {
    this.#closed = true;
    clearTimeout(this.#expiryTimer);
    return (this.#queue = this.#queue.then(() => this.#release()));
  }

  /** The transport saw the client alive: renews the presence leases (docs/protocol.md §8). */
  heartbeat(): Promise<void> {
    return this.#enqueue(async () => {
      for (const namespace of this.#joined.keys()) await this.#acquirePresence(namespace);
    });
  }

  #enqueue(task: () => Promise<void>): Promise<void> {
    return (this.#queue = this.#queue.then(() => (this.#closed ? undefined : task())));
  }

  async #release(): Promise<void> {
    for (const namespace of [...this.#joined.keys()]) await this.#leave(namespace);
    const unsubscribe = this.#unsubscribe;
    this.#unsubscribe = undefined;
    await unsubscribe?.();
    if (this.#context !== undefined) {
      await this.#deps.coordination.releaseDeviceConnection(identityOf(this.#context), this.id);
    }
  }

  async #handleFrame(text: string): Promise<void> {
    const parsed = parseClientMessage(text, { maxBytes: this.#deps.maxMessageBytes });
    if (!parsed.ok) return this.#error(parsed.code, parsed.requestId);
    const message = parsed.message;
    if (this.#context === undefined && message.type !== 'auth.authenticate') {
      return this.#error('not_authenticated', message.requestId);
    }
    switch (message.type) {
      case 'auth.authenticate':
        // A connection authenticates once; auth.refresh renews it.
        if (this.#context !== undefined) return this.#error('invalid_message', message.requestId);
        return this.#authenticate(message);
      case 'auth.refresh':
        return this.#refresh(message);
      case 'namespace.join':
        return this.#join(message);
      case 'namespace.leave':
        await this.#leave(message.payload.namespace);
        return this.#ack(message.requestId);
      case 'discovery.request':
        return this.#discover(message);
      case 'connection.ping':
        return this.#send({ type: 'connection.pong', requestId: message.requestId, payload: {} });
      default:
        // Deny by default: a type with no handler is never authorized.
        return this.#error('not_authorized', message.requestId);
    }
  }

  async #authenticate(message: ClientMessage & { type: 'auth.authenticate' }): Promise<void> {
    const { requestId } = message;
    const verified = await this.#deps.verifier.verify(message.payload.token);
    // Every rejection closes: the connection has nothing to keep.
    if (!verified.ok) return this.#error(verified.code, requestId, true);
    const { application, context } = verified.token;
    if (!(await this.#touch(context, application.quotas.devices))) {
      return this.#error('quota_exceeded', requestId, true);
    }

    // Subscribed before the claim, so a newer connection's `superseded` is never missed.
    this.#unsubscribe = await this.#deps.coordination.subscribe(connectionTopic(this.id), (event) =>
      this.#onEvent(event),
    );
    const previous = await this.#deps.coordination.claimDeviceConnection(
      identityOf(context),
      this.id,
    );
    if (previous !== undefined) {
      await this.#deps.coordination.publish(connectionTopic(previous), SUPERSEDED);
    }
    this.#accept({ ...context, protocolVersion: message.version }, requestId);
  }

  async #refresh(message: ClientMessage & { type: 'auth.refresh' }): Promise<void> {
    const { requestId } = message;
    const current = this.#context as ConnectionContext;
    // A rejected refresh keeps the current token; only terminal codes close (docs/protocol.md §9).
    const verified = await this.#deps.verifier.verify(message.payload.token);
    if (!verified.ok) return this.#error(verified.code, requestId);
    const { application, context } = verified.token;
    if (!sameDevice(context, current)) return this.#error('identity_mismatch', requestId);
    if (!(await this.#touch(context, application.quotas.devices))) {
      return this.#error('quota_exceeded', requestId);
    }
    this.#accept({ ...context, protocolVersion: current.protocolVersion }, requestId);
    // The new token replaces the authorized set: leave what it no longer lists (ADR 0007).
    for (const namespace of [...this.#joined.keys()]) {
      if (!context.namespaces.includes(namespace)) await this.#leave(namespace);
    }
  }

  /** The current token authorizes the namespace (docs/protocol.md §5). */
  #authorized(namespace: string): boolean {
    return (this.#context as ConnectionContext).namespaces.includes(namespace);
  }

  async #join(message: ClientMessage & { type: 'namespace.join' }): Promise<void> {
    const { requestId, payload } = message;
    const { namespace } = payload;
    // Unauthorized and nonexistent namespaces look the same, so none can be enumerated.
    if (!this.#authorized(namespace)) return this.#error('not_authorized', requestId);
    const joining = !this.#joined.has(namespace);
    if (joining) {
      const unsubscribe = await this.#deps.coordination.subscribe(
        presenceTopic(namespace),
        (event) => this.#onPresence(event as PresenceChanged),
      );
      this.#joined.set(namespace, unsubscribe);
    }
    await this.#acquirePresence(namespace);
    if (joining) await this.#publishPresence(namespace, true);
    this.#ack(requestId);
  }

  /** Leaves a joined namespace; leaving one not joined has no effect. */
  async #leave(namespace: string): Promise<void> {
    const unsubscribe = this.#joined.get(namespace);
    if (unsubscribe === undefined) return;
    this.#joined.delete(namespace);
    await unsubscribe();
    const device = identityOf(this.#context as ConnectionContext);
    // A superseded connection's lease already belongs to its replacement: announce nothing.
    if (await this.#deps.coordination.releasePresence(namespace, device, this.id)) {
      await this.#publishPresence(namespace, false);
    }
  }

  async #discover(message: ClientMessage & { type: 'discovery.request' }): Promise<void> {
    const { requestId, payload } = message;
    const { namespace } = payload;
    if (!this.#authorized(namespace)) return this.#error('not_authorized', requestId);
    if (!this.#joined.has(namespace)) return this.#error('not_joined', requestId);
    const present = await this.#deps.coordination.listPresence(namespace);
    const devices = present
      .filter((device) => !this.#isSelf(device))
      .map(({ userId, deviceId }) => ({ userId, deviceId }));
    this.#send({ type: 'discovery.result', requestId, payload: { namespace, devices } });
  }

  #acquirePresence(namespace: string): Promise<void> {
    const device = identityOf(this.#context as ConnectionContext);
    return this.#deps.coordination.acquirePresence(
      namespace,
      device,
      this.id,
      this.#deps.presenceLeaseMs,
    );
  }

  #publishPresence(namespace: string, present: boolean): Promise<void> {
    const { userId, deviceId } = this.#context as ConnectionContext;
    const event: PresenceChanged = { namespace, userId, deviceId, present };
    return this.#deps.coordination.publish(presenceTopic(namespace), event);
  }

  #onPresence(event: PresenceChanged): void {
    void this.#enqueue(() => {
      // An event queued before a leave is dropped; a device never hears about itself.
      if (this.#joined.has(event.namespace) && !this.#isSelf(event)) {
        this.#send({ type: 'presence.changed', payload: event });
      }
      return Promise.resolve();
    });
  }

  #isSelf(device: Pick<DeviceIdentity, 'userId' | 'deviceId'>): boolean {
    const context = this.#context as ConnectionContext;
    return device.userId === context.userId && device.deviceId === context.deviceId;
  }

  #ack(requestId: string): void {
    this.#send({ type: 'ack', requestId, payload: {} });
  }

  async #touch(device: DeviceIdentity, appMaxDevices: number | undefined): Promise<boolean> {
    const { ttlMs, maxDevices } = this.#deps.deviceLimits;
    const result = await this.#deps.devices.touch(identityOf(device), new Date(), {
      ttlMs,
      maxDevices: appMaxDevices ?? maxDevices,
    });
    return result.ok;
  }

  /** Installs the context, replies, sends the ICE configuration, and arms the expiry. */
  #accept(context: ConnectionContext, requestId: string): void {
    this.#context = context;
    const expiresInMs = Math.max(0, context.tokenExpiresAt.getTime() - Date.now());
    this.#send({
      type: 'auth.result',
      requestId,
      payload: { userId: context.userId, deviceId: context.deviceId, expiresInMs },
    });
    this.#send({ type: 'rtc.ice_config', payload: { iceServers: [...this.#deps.iceServers] } });
    clearTimeout(this.#expiryTimer);
    this.#expiryTimer = setTimeout(
      () =>
        void this.#enqueue(() => Promise.resolve(this.#error('token_expired', undefined, true))),
      expiresInMs + this.#deps.clockSkewSeconds * 1000,
    );
  }

  #onEvent(event: unknown): void {
    if ((event as { type?: unknown } | null)?.type === SUPERSEDED.type) {
      void this.#enqueue(() => Promise.resolve(this.#error('superseded', undefined, true)));
    }
  }

  #send(message: Omit<ServerMessage, 'version'>): void {
    if (!this.#closed) this.#port.send({ version: PROTOCOL_VERSION, ...message } as ServerMessage);
  }

  /**
   * Sends `error`, then closes with the code's class when `close` is set or the code is terminal
   * (docs/protocol.md §9).
   */
  #error(code: ErrorCode, requestId?: string, close = false): void {
    this.#send({
      type: 'error',
      ...(requestId === undefined ? {} : { requestId }),
      payload: { code },
    });
    if (!close && errorClasses[code] === 'retryable') return;
    this.#port.close(closeCodeFor(code));
    this.#closed = true;
    clearTimeout(this.#expiryTimer);
  }
}
