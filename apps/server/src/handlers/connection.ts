import type {
  ApplicationRateLimit,
  ApplicationRecord,
  ConnectionContext,
  CoordinationAdapter,
  DeviceIdentity,
  DeviceRepository,
  RateLimitPolicy,
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
import { unavailability, type TokenVerifier } from '../domain/auth.ts';
import { applicationLimits, type Limits } from '../domain/limits.ts';
import type { Participant, Session, SessionRegistry } from '../domain/sessions.ts';
import type { Logger, Metrics } from '../telemetry.ts';

/** What a handler needs from the transport. */
export interface ConnectionPort {
  /** Keys the authentication-attempt rate limit (ADR 0011). */
  readonly clientIp: string;
  send(message: ServerMessage): void;
  close(code: number): void;
  /** The connection authenticated: it no longer counts as unauthenticated (spec §8.4). */
  authenticated?(): void;
  /** Bytes sent but not yet written to the network (ADR 0013). */
  readonly bufferedBytes?: number;
  /** Stops reading frames, and starts again: backpressure on the client (ADR 0013). */
  pause?(): void;
  resume?(): void;
}

/** Close code for a connection that missed the authentication deadline (RFC 6455). */
export const POLICY_VIOLATION = 1008;

/** Close code for a connection whose queue or send buffer is full (RFC 6455; ADR 0013). */
export const TRY_AGAIN_LATER = 1013;

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
    | 'consumeRateLimit'
    | 'acquireSlots'
    | 'releaseSlots'
  >;
  readonly iceServers: Payload<'rtc.ice_config'>['iceServers'];
  readonly clockSkewSeconds: number;
  /** A connection not authenticated this long after it opened is closed (spec §8.4). */
  readonly authenticationTimeoutMs: number;
  /** `auth.authenticate` and `auth.refresh` attempts per client IP. */
  readonly authenticationAttempts: RateLimitPolicy;
  /** A device record not seen for this long stops counting toward the device quota. */
  readonly deviceTtlMs: number;
  /** Server defaults; an application's registry entry overrides each limit it sets (ADR 0011). */
  readonly limits: Limits;
  /** Renewed on every heartbeat, so it outlives a few missed ones. */
  readonly presenceLeaseMs: number;
  /** Shared by every connection of the process. */
  readonly sessions: SessionRegistry;
  /** How long a session may stay `pending` (docs/protocol.md §7). */
  readonly negotiationTimeoutMs: number;
  readonly maxMessageBytes?: number;
  /** Frames and events waiting on one connection; reading pauses at half (ADR 0013). */
  readonly maxQueuedMessages: number;
  /** Bytes waiting in one connection's send buffer (ADR 0013). */
  readonly maxBufferedBytes: number;
  readonly metrics: Pick<Metrics, 'count'>;
  readonly logger: Logger;
}

/** Each connection receives events on its own topic, from any instance (ADR 0010). */
export const connectionTopic = (connectionId: string) => `connection:${connectionId}`;

/** Joined connections receive the namespace's `presence.changed` events on it. */
export const presenceTopic = (namespace: string) => `presence:${namespace}`;

/** Each authenticated connection holds one slot of its application's connection quota. */
const connectionSlot = (appId: string) => `connections:${appId}`;

/**
 * A session holds a slot of its application's session quota and one of each device's, from
 * creation to its end (ADR 0011): the application's, the requester's, and the target's keys.
 */
const sessionSlots = (requester: DeviceIdentity, target: DeviceIdentity) =>
  [
    `sessions:${requester.appId}`,
    `device_sessions:${JSON.stringify([requester.appId, requester.userId, requester.deviceId])}`,
    `device_sessions:${JSON.stringify([target.appId, target.userId, target.deviceId])}`,
  ] as const;

const SUPERSEDED = { type: 'superseded' } as const;

type Outbound = Omit<ServerMessage, 'version'>;

/** A message for another connection, sent through its topic. */
const deliver = (message: Outbound) => ({ type: 'deliver', message }) as const;

type PresenceChanged = Payload<'presence.changed'>;
type TerminationReason = Payload<'session.terminated'>['reason'];
type SessionMessage = ClientMessage & {
  type: 'session.accept' | 'session.reject' | 'session.close';
};
type RtcMessage = ClientMessage & { type: 'rtc.offer' | 'rtc.answer' | 'rtc.ice_candidate' };

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
  #queue: Promise<void> = Promise.resolve();
  /** Tasks in the queue, the running one included; bounded by `maxQueuedMessages`. */
  #pending = 0;
  #paused = false;
  #closed = false;
  /** What the other participants of this connection's sessions are told when it ends. */
  #endReason: TerminationReason = 'peer_disconnected';
  #context: ConnectionContext | undefined;
  /** The connection-quota key this connection holds a slot under, once it took one. */
  #slot: string | undefined;
  /** The application's limits, read from the registry at each authentication and refresh. */
  #limits: Limits;
  #expiryTimer: ReturnType<typeof setTimeout> | undefined;
  readonly #deadline: ReturnType<typeof setTimeout>;
  #unsubscribe: (() => Promise<void>) | undefined;
  /** Joined namespaces, each with its presence topic's unsubscribe. */
  readonly #joined = new Map<string, () => Promise<void>>();

  constructor(port: ConnectionPort, deps: ConnectionDependencies, id = crypto.randomUUID()) {
    this.id = id;
    this.#port = port;
    this.#deps = deps;
    this.#limits = deps.limits;
    // Queued, so an authentication in flight finishes first.
    this.#deadline = setTimeout(
      () => void this.#enqueue(() => Promise.resolve(this.#missedDeadline())),
      deps.authenticationTimeoutMs,
    );
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
    clearTimeout(this.#deadline);
    return (this.#queue = this.#queue.then(() => this.#release()));
  }

  /**
   * A registry reload changed the applications: closes the connection when its application or
   * device is no longer available (ADR 0005). Queued, so an authentication in flight is checked.
   */
  enforce(applications: readonly ApplicationRecord[]): Promise<void> {
    return this.#enqueue(() => {
      const context = this.#context;
      if (context === undefined) return Promise.resolve();
      const application = applications.find((app) => app.appId === context.appId);
      const code = unavailability(application, context);
      // A revoked device's peers learn why their sessions end (spec §6.4); an unavailable
      // application closes every connection, so no peer is left to tell (docs/protocol.md §7).
      if (code === 'device_revoked') this.#endReason = 'peer_revoked';
      if (code !== undefined) this.#error(code, undefined, true);
      return Promise.resolve();
    });
  }

  /** The transport saw the client alive: renews the presence leases (docs/protocol.md §8). */
  heartbeat(): Promise<void> {
    return this.#enqueue(async () => {
      for (const namespace of this.#joined.keys()) await this.#acquirePresence(namespace);
    });
  }

  #enqueue(task: () => Promise<void>): Promise<void> {
    if (this.#pending >= this.#deps.maxQueuedMessages) {
      this.#overloaded('queued_messages');
      return this.#queue;
    }
    this.#pending++;
    this.#backpressure();
    return (this.#queue = this.#queue
      .then(() => (this.#closed ? undefined : task()))
      .finally(() => {
        this.#pending--;
        this.#backpressure();
      }));
  }

  /**
   * Stops reading frames while half the queue is taken, so a fast client waits; frames already
   * read and events still fill the other half (ADR 0013).
   */
  #backpressure(): void {
    const full = this.#pending >= this.#deps.maxQueuedMessages / 2;
    if (full === this.#paused) return;
    this.#paused = full;
    if (full) this.#port.pause?.();
    else this.#port.resume?.();
  }

  /** Closed without `error`, which would wait behind the backlog (ADR 0013). */
  #overloaded(limit: 'queued_messages' | 'buffered_bytes'): void {
    if (this.#closed) return;
    this.#deps.logger.log('warn', 'connection.overloaded', {
      connectionId: this.id,
      appId: this.#context?.appId,
      limit,
    });
    this.#deps.metrics.count('blindsignal_overloaded_connections_total', { limit });
    this.#port.close(TRY_AGAIN_LATER);
    this.#closed = true;
    clearTimeout(this.#expiryTimer);
  }

  async #release(): Promise<void> {
    const device = this.#context === undefined ? undefined : identityOf(this.#context);
    // Unregistered in the same tick as the session scan, so no new session can slip in between.
    if (device !== undefined) this.#deps.sessions.unregister(device, this.id);
    for (const session of this.#deps.sessions.of(this.id)) {
      await this.#terminate(session, this.#endReason);
    }
    for (const namespace of [...this.#joined.keys()]) await this.#leave(namespace);
    const unsubscribe = this.#unsubscribe;
    this.#unsubscribe = undefined;
    await unsubscribe?.();
    if (device !== undefined) {
      await this.#deps.coordination.releaseDeviceConnection(device, this.id);
    }
    if (this.#slot !== undefined) await this.#deps.coordination.releaseSlots(this.id, [this.#slot]);
  }

  async #handleFrame(text: string): Promise<void> {
    const parsed = parseClientMessage(text, { maxBytes: this.#deps.maxMessageBytes });
    // Every frame takes a signaling token, malformed ones too (ADR 0011).
    const requestId = parsed.ok ? parsed.message.requestId : parsed.requestId;
    if (!(await this.#limit('signaling', this.id, requestId))) return;
    if (!parsed.ok) return this.#error(parsed.code, parsed.requestId);
    const message = parsed.message;
    this.#deps.metrics.count('blindsignal_messages_total', { type: message.type });
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
      case 'session.create':
        return this.#createSession(message);
      case 'session.accept':
      case 'session.reject':
      case 'session.close':
        return this.#answerSession(message);
      case 'rtc.offer':
      case 'rtc.answer':
      case 'rtc.ice_candidate':
        return this.#relay(message);
      case 'connection.ping':
        return this.#send({ type: 'connection.pong', requestId: message.requestId, payload: {} });
      default: {
        // Deny by default: a type with no handler is never authorized.
        const unhandled: never = message;
        return this.#error('not_authorized', (unhandled as ClientMessage).requestId);
      }
    }
  }

  async #authenticate(message: ClientMessage & { type: 'auth.authenticate' }): Promise<void> {
    const { requestId } = message;
    if (!(await this.#allowAuthentication(requestId))) return;
    const verified = await this.#deps.verifier.verify(message.payload.token);
    if (!verified.ok) return this.#rejectAuthentication(verified.code, requestId);
    const { application, context } = verified.token;
    // Released with the connection, whether or not the authentication completes.
    this.#slot = connectionSlot(context.appId);
    this.#limits = applicationLimits(this.#deps.limits, application);
    const limit = this.#limits.quotas.connections;
    if (
      !(await this.#deps.coordination.acquireSlots(this.id, [{ key: this.#slot, limit }])) ||
      !(await this.#touch(context))
    ) {
      return this.#rejectAuthentication('quota_exceeded', requestId);
    }
    this.#deps.metrics.count('blindsignal_authentications_total', { result: 'ok' });

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
    this.#deps.sessions.register(identityOf(context), this.id);
    clearTimeout(this.#deadline);
    this.#port.authenticated?.();
    this.#accept({ ...context, protocolVersion: message.version }, requestId);
    this.#deps.logger.log('info', 'connection.authenticated', {
      connectionId: this.id,
      appId: context.appId,
    });
  }

  /** Closed without `error`, like a shutdown: the client reconnects with backoff (§9). */
  #missedDeadline(): void {
    if (this.#context !== undefined) return;
    this.#deps.logger.log('info', 'connection.authentication_timeout', { connectionId: this.id });
    this.#port.close(POLICY_VIOLATION);
    this.#closed = true;
  }

  /** Takes a token from the client IP's authentication bucket, before the token is verified. */
  #allowAuthentication(requestId: string): Promise<boolean> {
    const key = `authentication:${this.#port.clientIp}`;
    return this.#allow(key, this.#deps.authenticationAttempts, requestId);
  }

  /** Takes a token from the application's bucket for the category, keyed by `id`. */
  #limit(category: ApplicationRateLimit, id: string, requestId?: string): Promise<boolean> {
    return this.#allow(`${category}:${id}`, this.#limits.rateLimits[category], requestId);
  }

  /**
   * Takes a token from the bucket; when none is left, answers `rate_limited`, drops the message,
   * and keeps the connection (ADR 0011).
   */
  async #allow(key: string, policy: RateLimitPolicy, requestId?: string): Promise<boolean> {
    const decision = await this.#deps.coordination.consumeRateLimit(key, policy);
    if (decision.allowed) return true;
    const { retryAfterMs } = decision;
    this.#send({
      type: 'error',
      ...(requestId === undefined ? {} : { requestId }),
      payload: { code: 'rate_limited', retryAfterMs },
    });
    this.#deps.metrics.count('blindsignal_errors_total', { code: 'rate_limited' });
    return false;
  }

  /** Every rejection closes: the connection has nothing to keep. */
  #rejectAuthentication(code: ErrorCode, requestId: string): void {
    this.#deps.metrics.count('blindsignal_authentications_total', { result: code });
    this.#error(code, requestId, true);
  }

  async #refresh(message: ClientMessage & { type: 'auth.refresh' }): Promise<void> {
    const { requestId } = message;
    const current = this.#context as ConnectionContext;
    if (!(await this.#allowAuthentication(requestId))) return;
    // A rejected refresh keeps the current token; only terminal codes close (docs/protocol.md §9).
    const verified = await this.#deps.verifier.verify(message.payload.token);
    if (!verified.ok) return this.#error(verified.code, requestId);
    const { application, context } = verified.token;
    if (!sameDevice(context, current)) return this.#error('identity_mismatch', requestId);
    this.#limits = applicationLimits(this.#deps.limits, application);
    if (!(await this.#touch(context))) {
      return this.#error('quota_exceeded', requestId);
    }
    this.#accept({ ...context, protocolVersion: current.protocolVersion }, requestId);
    // The new token replaces the authorized set: end and leave what it no longer lists (ADR 0007).
    for (const session of this.#deps.sessions.of(this.id)) {
      if (!this.#authorized(session.namespace)) {
        await this.#terminate(session, 'namespace_unauthorized', true);
      }
    }
    for (const namespace of [...this.#joined.keys()]) {
      if (!this.#authorized(namespace)) await this.#leave(namespace);
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
    // One connection per device (ADR 0008), so its joined namespaces are the device's.
    if (joining && this.#joined.size >= this.#limits.quotas.namespacesPerDevice) {
      return this.#error('quota_exceeded', requestId);
    }
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
    if (!(await this.#limit('discovery', this.id, requestId))) return;
    if (!this.#authorized(namespace)) return this.#error('not_authorized', requestId);
    if (!this.#joined.has(namespace)) return this.#error('not_joined', requestId);
    const present = await this.#deps.coordination.listPresence(namespace);
    const devices = present
      .filter((device) => !this.#isSelf(device))
      .map(({ userId, deviceId }) => ({ userId, deviceId }));
    this.#send({ type: 'discovery.result', requestId, payload: { namespace, devices } });
  }

  async #createSession(message: ClientMessage & { type: 'session.create' }): Promise<void> {
    const { requestId, payload } = message;
    const { namespace, userId, deviceId } = payload;
    if (!(await this.#limit('session_create', this.id, requestId))) return;
    if (!this.#authorized(namespace)) return this.#error('not_authorized', requestId);
    const self = this.#context as ConnectionContext;
    const target = { appId: self.appId, userId, deviceId };
    // Joining requires authorization, so a present target is authorized in the namespace.
    // Every unreachable target looks the same, so devices cannot be enumerated (§7).
    const present = await this.#deps.coordination.listPresence(namespace);
    const targetId = this.#deps.sessions.connectionOf(target);
    if (
      this.#isSelf(target) ||
      targetId === undefined ||
      !present.some((d) => sameDevice(d, target))
    ) {
      return this.#error('peer_unavailable', requestId);
    }
    const requester: Participant = { connectionId: this.id, device: identityOf(self) };
    const sessionId = crypto.randomUUID();
    const [app, own, peer] = sessionSlots(requester.device, target);
    const { sessions, sessionsPerDevice } = this.#limits.quotas;
    const { coordination } = this.#deps;
    const ownSlots = [
      { key: app, limit: sessions },
      { key: own, limit: sessionsPerDevice },
    ];
    if (!(await coordination.acquireSlots(sessionId, ownSlots))) {
      return this.#error('quota_exceeded', requestId);
    }
    // A busy target looks unreachable, so its load is not revealed.
    if (!(await coordination.acquireSlots(sessionId, [{ key: peer, limit: sessionsPerDevice }]))) {
      await coordination.releaseSlots(sessionId, [app, own]);
      return this.#error('peer_unavailable', requestId);
    }
    this.#deps.sessions.create(
      namespace,
      requester,
      { connectionId: targetId, device: target },
      this.#deps.negotiationTimeoutMs,
      (expired) => void this.#enqueue(() => this.#terminate(expired, 'timeout', true)),
      sessionId,
    );
    this.#deps.metrics.count('blindsignal_sessions_created_total');
    this.#send({ type: 'session.created', requestId, payload: { sessionId } });
    await this.#publish(targetId, {
      type: 'session.request',
      payload: { sessionId, namespace, userId: self.userId, deviceId: self.deviceId },
    });
  }

  /** `session.accept` and `session.reject` from the target; `session.close` from either side. */
  async #answerSession(message: SessionMessage): Promise<void> {
    const { requestId, type } = message;
    const { sessionId } = message.payload;
    const session = this.#deps.sessions.get(sessionId);
    const allowed =
      session !== undefined &&
      (type === 'session.close'
        ? this.#participates(session)
        : session.state === 'pending' && session.target.connectionId === this.id);
    if (!allowed) return this.#error('session_unavailable', requestId);
    this.#ack(requestId);
    if (type === 'session.close') return this.#terminate(session, 'closed_by_peer');
    if (type === 'session.accept') {
      // The accepting connection's limits: both devices belong to the same application.
      this.#deps.sessions.activate(sessionId, this.#limits.quotas.sessionDurationSeconds * 1000);
      return this.#publish(session.requester.connectionId, {
        type: 'session.accepted',
        payload: { sessionId },
      });
    }
    await this.#end(session);
    await this.#publish(session.requester.connectionId, {
      type: 'session.rejected',
      payload: { sessionId },
    });
  }

  /** Rebuilds an `rtc.*` message for the other participant of an active session (§7). */
  async #relay(message: RtcMessage): Promise<void> {
    const { requestId, type, payload } = message;
    const session = this.#deps.sessions.get(payload.sessionId);
    if (session?.state !== 'active' || !this.#participates(session)) {
      return this.#error('session_unavailable', requestId);
    }
    // Keyed by session, after the check, so only an active session's participants make buckets.
    const category = type === 'rtc.ice_candidate' ? 'rtc_ice_candidate' : 'rtc';
    if (!(await this.#limit(category, session.id, requestId))) return;
    // The parsed payload holds only the schema's fields: no requestId, no sender, no extra keys.
    await this.#publish(this.#peerOf(session), { type, payload });
  }

  /** Ends the session; tells the other participant, and this one too when `both` is set. */
  async #terminate(session: Session, reason: TerminationReason, both = false): Promise<void> {
    if (!(await this.#end(session))) return;
    this.#deps.metrics.count('blindsignal_sessions_terminated_total', { reason });
    const terminated = { type: 'session.terminated', payload: { sessionId: session.id, reason } };
    if (both) this.#send(terminated as Outbound);
    await this.#publish(this.#peerOf(session), terminated as Outbound);
  }

  /** Removes the session and frees its quota slots; true for the one caller that ended it. */
  async #end(session: Session): Promise<boolean> {
    if (!this.#deps.sessions.end(session.id)) return false;
    const slots = sessionSlots(session.requester.device, session.target.device);
    await this.#deps.coordination.releaseSlots(session.id, slots);
    return true;
  }

  #participates(session: Session): boolean {
    return session.requester.connectionId === this.id || session.target.connectionId === this.id;
  }

  #peerOf(session: Session): string {
    return session.requester.connectionId === this.id
      ? session.target.connectionId
      : session.requester.connectionId;
  }

  #publish(connectionId: string, message: Outbound): Promise<void> {
    return this.#deps.coordination.publish(connectionTopic(connectionId), deliver(message));
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

  async #touch(device: DeviceIdentity): Promise<boolean> {
    const result = await this.#deps.devices.touch(identityOf(device), new Date(), {
      ttlMs: this.#deps.deviceTtlMs,
      maxDevices: this.#limits.quotas.devices,
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
    const type = (event as { type?: unknown } | null)?.type;
    if (type === SUPERSEDED.type) {
      void this.#enqueue(() => Promise.resolve(this.#error('superseded', undefined, true)));
    } else if (type === 'deliver') {
      const { message } = event as ReturnType<typeof deliver>;
      void this.#enqueue(() => Promise.resolve(this.#send(message)));
    }
  }

  #send(message: Outbound): void {
    if (this.#closed) return;
    this.#port.send({ version: PROTOCOL_VERSION, ...message } as ServerMessage);
    if ((this.#port.bufferedBytes ?? 0) > this.#deps.maxBufferedBytes) {
      this.#overloaded('buffered_bytes');
    }
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
    this.#deps.metrics.count('blindsignal_errors_total', { code });
    // Already closed, by this error's own send overflowing the buffer, for one.
    if (this.#closed || (!close && errorClasses[code] === 'retryable')) return;
    // Only closing errors are logged; the counter covers the rest. No `sub` or `device_id` (Q12).
    this.#deps.logger.log('info', 'connection.error', {
      connectionId: this.id,
      appId: this.#context?.appId,
      code,
    });
    this.#port.close(closeCodeFor(code));
    this.#closed = true;
    clearTimeout(this.#expiryTimer);
  }
}
