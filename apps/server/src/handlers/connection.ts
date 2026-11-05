import type {
  ApplicationRateLimit,
  ApplicationRecord,
  ConnectionContext,
  CoordinationAdapter,
  DeviceIdentity,
  DeviceRepository,
  Permission,
  RateLimitPolicy,
  Slot,
} from '@blindsignal/core';
import {
  closeCodeFor,
  errorClasses,
  MAX_MESSAGE_BYTES,
  parseClientMessage,
  PROTOCOL_VERSION,
  type ClientMessage,
  type ErrorCode,
  type Payload,
  type ServerMessage,
  type TerminationReason,
} from '@blindsignal/protocol';
import type { AbuseMonitor } from '../domain/abuse.ts';
import { unavailability, type TokenVerifier } from '../domain/auth.ts';
import { applicationLimits, type Limits } from '../domain/limits.ts';
import { approves, PendingPairings, type Pairing } from '../domain/pairings.ts';
import { SessionRegistry, type Participant, type Session } from '../domain/sessions.ts';
import { turnServer, type TurnPolicy } from '../domain/turn.ts';
import type { Logger, Metrics } from '../telemetry.ts';
import { connectionEvent, presenceEvent, type ConnectionEvent } from './events.ts';

/** What a handler needs from the transport. */
export interface ConnectionPort {
  /** Keys the authentication-attempt rate limit: IPv6 is cut to its prefix (ADR 0011). */
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
    | 'renewDeviceConnection'
    | 'releaseDeviceConnection'
    | 'connectionOf'
    | 'acquirePresence'
    | 'releasePresence'
    | 'listPresence'
    | 'isPresent'
    | 'publish'
    | 'subscribe'
    | 'consumeRateLimit'
    | 'acquireSlots'
    | 'releaseSlots'
  >;
  readonly iceServers: Payload<'rtc.ice_config'>['iceServers'];
  /** Mints a TURN credential for every `rtc.ice_config` when present (ADR 0017). */
  readonly turn?: TurnPolicy;
  readonly clockSkewSeconds: number;
  /** A connection not authenticated this long after it opened is closed (spec §8.4). */
  readonly authenticationTimeoutMs: number;
  /** `auth.authenticate` attempts per client IP; `auth.refresh` takes the `refresh` bucket. */
  readonly authenticationAttempts: RateLimitPolicy;
  /** A device record not seen for this long stops counting toward the device quota. */
  readonly deviceTtlMs: number;
  /** Server defaults; an application's registry entry overrides each limit it sets (ADR 0011). */
  readonly limits: Limits;
  /** Presence leases and quota slots last this long, renewed on every heartbeat (ADR 0022). */
  readonly presenceLeaseMs: number;
  /** How long a session may stay `pending` (docs/protocol.md §7). */
  readonly negotiationTimeoutMs: number;
  readonly maxMessageBytes?: number;
  /** Frames and events waiting on one connection; reading pauses at half (ADR 0013). */
  readonly maxQueuedMessages: number;
  /** Bytes waiting in one connection's send buffer (ADR 0013). */
  readonly maxBufferedBytes: number;
  /** Shared by every connection of the process; alerts on an application's rejections (ADR 0016). */
  readonly abuse: Pick<AbuseMonitor, 'record'>;
  readonly metrics: Pick<Metrics, 'count' | 'observe'>;
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
const sessionSlots = (
  requester: DeviceIdentity,
  target: DeviceIdentity,
  { sessions, sessionsPerDevice }: Limits['quotas'],
) =>
  [
    { key: `sessions:${requester.appId}`, limit: sessions },
    {
      key: `device_sessions:${JSON.stringify([requester.appId, requester.userId, requester.deviceId])}`,
      limit: sessionsPerDevice,
    },
    {
      key: `device_sessions:${JSON.stringify([target.appId, target.userId, target.deviceId])}`,
      limit: sessionsPerDevice,
    },
  ] as const;

/**
 * One pending session per requester and target, so a single device cannot hold every session slot
 * of a target with requests it never lets finish (ADR 0011).
 */
const pendingSlot = (requester: DeviceIdentity, target: DeviceIdentity): Slot => ({
  key: `pending_sessions:${JSON.stringify([requester.appId, requester.userId, requester.deviceId, target.userId, target.deviceId])}`,
  limit: 1,
});

type Outbound = Omit<ServerMessage, 'version'>;

/**
 * The devices of a `discovery.result` that fit in the protocol's maximum message size, which the
 * SDK enforces: the rest are left out, and `truncated` says so (ADR 0011).
 */
export function fitting(
  namespace: string,
  devices: readonly { userId: string; deviceId: string }[],
): Payload<'discovery.result'> {
  const message = { version: PROTOCOL_VERSION, type: 'discovery.result', requestId: '' };
  // The longest `requestId` and the `truncated` flag, which the message may still need.
  const reserved = 64 + ',"truncated":true'.length;
  let size = Buffer.byteLength(JSON.stringify({ ...message, payload: { namespace, devices: [] } }));
  for (const [index, device] of devices.entries()) {
    size += Buffer.byteLength(JSON.stringify(device)) + (index === 0 ? 0 : 1);
    if (size + reserved > MAX_MESSAGE_BYTES) {
      return { namespace, devices: devices.slice(0, index), truncated: true };
    }
  }
  return { namespace, devices: [...devices] };
}

type PresenceChanged = Payload<'presence.changed'>;

/**
 * What one participant's connection tells the other's, on any instance, so both copies of a
 * session stay in step (ADR 0023).
 */
type SessionEvent = Extract<ConnectionEvent, { type: `session.${string}` }>;
/** What the connections taking part in a pairing tell each other, on any instance (ADR 0042). */
type PairingEvent = Extract<ConnectionEvent, { type: `pairing.${string}` }>;
/** An `rtc.*` message for the other participant of a session, sent through its topic. */
type Deliver = Extract<ConnectionEvent, { type: 'deliver' }>;
/** An event as its publisher writes it; `#notify` adds `from`. */
type Unsent<E> = E extends unknown ? Omit<E, 'from'> : never;
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
  /** The application of a verified token, before the authentication completes too (ADR 0015). */
  #appId: string | undefined;
  /** The application's limits, read from the registry at each authentication and refresh. */
  #limits: Limits;
  #expiryTimer: ReturnType<typeof setTimeout> | undefined;
  readonly #deadline: ReturnType<typeof setTimeout>;
  #unsubscribe: (() => Promise<void>) | undefined;
  /** Joined namespaces, each with its presence topic's unsubscribe. */
  readonly #joined = new Map<string, () => Promise<void>>();
  /** This connection's copy of its sessions; the peer's connection keeps its own. */
  readonly #sessions = new SessionRegistry();
  /** Pairings this connection requested, each with the connections asked to approve it. */
  readonly #pairings = new PendingPairings<{ pairing: Pairing; approvers: readonly string[] }>();
  /** Pairing requests this connection may answer. */
  readonly #pairingRequests = new PendingPairings<Pairing>();
  /** What a proof of possession signs on this connection (ADR 0041). */
  readonly #nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');

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

  /** Sends the nonce a proof of possession signs; the transport calls it once, on open. */
  challenge(): void {
    this.#send({ type: 'auth.challenge', payload: { nonce: this.#nonce } });
  }

  /** The authenticated context, or undefined before `auth.authenticate` succeeds. */
  get context(): ConnectionContext | undefined {
    return this.#context;
  }

  /**
   * The sessions pending or active that this connection requested: each session is counted once,
   * by its requester's instance (ADR 0015, ADR 0023).
   */
  get requestedSessions(): readonly Session[] {
    return this.#sessions.all().filter((session) => this.#requested(session));
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
    // What a failure leaves expires with its lease, or the next claim replaces it (ADR 0026).
    return (this.#queue = this.#queue
      .then(() => this.#release())
      .catch((error: unknown) => this.#failed(error)));
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

  /**
   * The transport saw the client alive: renews the presence leases (docs/protocol.md §8) and the
   * quota slots of the connection and its sessions (ADR 0022). A slot that expired meanwhile and
   * was taken is not renewed: the quota counts the newer holder, so the connection closes with
   * `quota_exceeded`, or the session ends with `timeout`. A session whose peer's connection no
   * longer holds its device's claim ends, as when the peer's instance fails (ADR 0026).
   */
  heartbeat(): Promise<void> {
    return this.#enqueue(async () => {
      if (this.#context === undefined) return;
      // Another connection took the claim: this one was superseded, and its event lost.
      const device = identityOf(this.#context);
      const ttlMs = this.#deps.presenceLeaseMs;
      if (!(await this.#deps.coordination.renewDeviceConnection(device, this.id, ttlMs))) {
        return this.#error('superseded', undefined, true);
      }
      for (const namespace of this.#joined.keys()) await this.#acquirePresence(namespace);
      if (!(await this.#acquireConnectionSlot())) {
        return this.#error('quota_exceeded', undefined, true);
      }
      for (const session of this.#sessions.all()) {
        const peer = this.#requested(session) ? session.target : session.requester;
        if ((await this.#deps.coordination.connectionOf(peer.device)) !== peer.connectionId) {
          await this.#terminate(session, 'peer_disconnected', true);
          continue;
        }
        const { requester, target } = session;
        const slots = sessionSlots(requester.device, target.device, this.#limits.quotas);
        const pending =
          session.state === 'pending' ? [pendingSlot(requester.device, target.device)] : [];
        if (!(await this.#acquireSessionSlots(session.id, [...slots, ...pending]))) {
          await this.#terminate(session, 'timeout', true);
        }
      }
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
      .catch((error: unknown) => this.#failed(error))
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
    // Released first, so a new session finds this connection gone; a request already on its way
    // finds the connection closed and times out on the requester's side.
    if (device !== undefined) {
      await this.#deps.coordination.releaseDeviceConnection(device, this.id);
    }
    for (const session of this.#sessions.all()) await this.#terminate(session, this.#endReason);
    for (const { pairing, approvers } of this.#pairings.takeAll()) {
      const ended = {
        type: 'pairing.ended',
        pairingId: pairing.id,
        reason: 'requester_gone',
      } as const;
      for (const approver of approvers) await this.#notify(approver, ended);
    }
    for (const namespace of [...this.#joined.keys()]) await this.#leave(namespace);
    const unsubscribe = this.#unsubscribe;
    this.#unsubscribe = undefined;
    await unsubscribe?.();
    if (this.#slot !== undefined) await this.#deps.coordination.releaseSlots(this.id, [this.#slot]);
  }

  async #handleFrame(text: string): Promise<void> {
    const parsed = parseClientMessage(text, { maxBytes: this.#deps.maxMessageBytes });
    // Every frame takes a signaling token, malformed ones too (ADR 0011).
    const requestId = parsed.ok ? parsed.message.requestId : parsed.requestId;
    if (!(await this.#limit('signaling', requestId))) return;
    if (!parsed.ok) return this.#error(parsed.code, parsed.requestId);
    const message = parsed.message;
    this.#deps.metrics.count('blindsignal_messages_total', { type: message.type });
    if (this.#context !== undefined) {
      const labels = { app_id: this.#context.appId };
      this.#deps.metrics.count('blindsignal_application_messages_total', labels);
    }
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
        // Only a leave that changes presence takes a token, as only it fans out.
        if (
          this.#joined.has(message.payload.namespace) &&
          !(await this.#limit('presence', message.requestId))
        ) {
          return;
        }
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
      case 'pairing.create':
        return this.#createPairing(message);
      case 'pairing.approve':
      case 'pairing.reject':
        return this.#answerPairing(message);
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
    const started = performance.now();
    if (!(await this.#allowAuthentication(requestId))) return;
    const verified = await this.#deps.verifier.verify(
      message.payload.token,
      this.#possession(message),
    );
    if (!verified.ok) return this.#rejectAuthentication(verified.code, requestId, started);
    const { application, context } = verified.token;
    this.#appId = context.appId;
    // Released with the connection, whether or not the authentication completes.
    this.#slot = connectionSlot(context.appId);
    this.#limits = applicationLimits(this.#deps.limits, application);
    if (!(await this.#acquireConnectionSlot()) || !(await this.#touch(context))) {
      return this.#rejectAuthentication('quota_exceeded', requestId, started);
    }
    this.#deps.metrics.count('blindsignal_authentications_total', { result: 'ok' });

    // Subscribed before the claim, so a newer connection's `superseded` is never missed.
    this.#unsubscribe = await this.#deps.coordination.subscribe(connectionTopic(this.id), (event) =>
      this.#onEvent(event),
    );
    const previous = await this.#deps.coordination.claimDeviceConnection(
      identityOf(context),
      this.id,
      this.#deps.presenceLeaseMs,
    );
    if (previous !== undefined) await this.#notify(previous, { type: 'superseded' });
    clearTimeout(this.#deadline);
    this.#port.authenticated?.();
    this.#accept({ ...context, protocolVersion: message.version }, requestId);
    this.#observeAuthentication('ok', started);
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

  /**
   * Takes a token from the application's bucket for the category: per device once authenticated,
   * so a reconnection starts no new bucket, and per connection before (ADR 0011). `sessionId`
   * gives each participant of a session a bucket of its own.
   */
  #limit(category: ApplicationRateLimit, requestId?: string, sessionId?: string): Promise<boolean> {
    const context = this.#context;
    const owner =
      context === undefined
        ? this.id
        : JSON.stringify([
            ...(sessionId === undefined ? [] : [sessionId]),
            context.appId,
            context.userId,
            context.deviceId,
          ]);
    return this.#allow(`${category}:${owner}`, this.#limits.rateLimits[category], requestId);
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
    this.#countError('rate_limited');
    return false;
  }

  /** Every rejection closes: the connection has nothing to keep. */
  #rejectAuthentication(code: ErrorCode, requestId: string, started: number): void {
    this.#deps.metrics.count('blindsignal_authentications_total', { result: code });
    this.#error(code, requestId, true);
    this.#observeAuthentication(code, started);
  }

  /** From the message's receipt to the reply sent, by the same result the counter has. */
  #observeAuthentication(result: string, started: number): void {
    const seconds = (performance.now() - started) / 1000;
    this.#deps.metrics.observe('blindsignal_authentication_duration_seconds', seconds, { result });
  }

  async #refresh(message: ClientMessage & { type: 'auth.refresh' }): Promise<void> {
    const { requestId } = message;
    const current = this.#context as ConnectionContext;
    // Per device, not per IP: a connected client never spends the bucket of others behind its IP.
    if (!(await this.#limit('refresh', requestId))) return;
    // A rejected refresh keeps the current token; only terminal codes close (docs/protocol.md §9).
    const verified = await this.#deps.verifier.verify(
      message.payload.token,
      this.#possession(message),
    );
    if (!verified.ok) return this.#error(verified.code, requestId);
    const { application, context } = verified.token;
    // The device key is part of the identity: a refresh keeps it, or its absence (ADR 0041).
    if (!sameDevice(context, current) || context.keyThumbprint !== current.keyThumbprint) {
      return this.#error('identity_mismatch', requestId);
    }
    this.#limits = applicationLimits(this.#deps.limits, application);
    if (!(await this.#touch(context))) {
      return this.#error('quota_exceeded', requestId);
    }
    this.#accept({ ...context, protocolVersion: current.protocolVersion }, requestId);
    // The new token replaces the authorized set: end and leave what it no longer lists (ADR 0007).
    for (const session of this.#sessions.all()) {
      if (!this.#authorized(session.namespace)) {
        await this.#terminate(session, 'namespace_unauthorized', true);
      }
    }
    for (const namespace of [...this.#joined.keys()]) {
      if (!this.#authorized(namespace)) await this.#leave(namespace);
    }
    // A lower quota keeps the namespaces joined first.
    const { namespacesPerDevice } = this.#limits.quotas;
    for (const namespace of [...this.#joined.keys()].slice(namespacesPerDevice)) {
      await this.#leave(namespace);
    }
    // And the pairing requests it no longer lets this device make (ADR 0042).
    const pairable = context.pairing ?? [];
    const withdrawn = this.#pairings.takeAll(
      ({ pairing }) => !pairable.includes(pairing.namespace),
    );
    for (const { pairing, approvers } of withdrawn) {
      const reason = 'namespace_unauthorized';
      for (const approver of approvers) {
        await this.#notify(approver, { type: 'pairing.ended', pairingId: pairing.id, reason });
      }
      this.#send({ type: 'pairing.ended', payload: { pairingId: pairing.id, reason } });
    }
  }

  #possession({ payload }: ClientMessage & { type: 'auth.authenticate' | 'auth.refresh' }) {
    return { nonce: this.#nonce, proof: payload.proof };
  }

  /** The current token authorizes the namespace (docs/protocol.md §5). */
  #authorized(namespace: string): boolean {
    return (this.#context as ConnectionContext).namespaces.includes(namespace);
  }

  /** The current token grants the session permission there: all of them unless it lists some. */
  #permits(namespace: string, permission: Permission): boolean {
    const listed = (this.#context as ConnectionContext).permissions?.[namespace];
    return this.#authorized(namespace) && (listed === undefined || listed.includes(permission));
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
    // A join fans out to every device of the namespace; a repeated one renews the lease only.
    if (joining && !(await this.#limit('presence', requestId))) return;
    if (joining) {
      const unsubscribe = await this.#deps.coordination.subscribe(
        presenceTopic(namespace),
        (event) => this.#onPresence(event),
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
    if (!(await this.#limit('discovery', requestId))) return;
    if (!this.#authorized(namespace)) return this.#error('not_authorized', requestId);
    if (!this.#joined.has(namespace)) return this.#error('not_joined', requestId);
    const present = await this.#deps.coordination.listPresence(namespace);
    const devices = present
      .filter((device) => !this.#isSelf(device))
      .map(({ userId, deviceId }) => ({ userId, deviceId }));
    this.#send({ type: 'discovery.result', requestId, payload: fitting(namespace, devices) });
  }

  async #createSession(message: ClientMessage & { type: 'session.create' }): Promise<void> {
    const { requestId, payload } = message;
    const { namespace, userId, deviceId } = payload;
    if (!(await this.#limit('session_create', requestId))) return;
    if (!this.#permits(namespace, 'session.create'))
      return this.#error('not_authorized', requestId);
    const self = this.#context as ConnectionContext;
    const target = { appId: self.appId, userId, deviceId };
    // Joining requires authorization, so a present target is authorized in the namespace.
    // Every unreachable target looks the same, so devices cannot be enumerated (§7).
    if (this.#isSelf(target) || !(await this.#deps.coordination.isPresent(namespace, target))) {
      return this.#error('peer_unavailable', requestId);
    }
    const targetId = await this.#deps.coordination.connectionOf(target);
    if (targetId === undefined) return this.#error('peer_unavailable', requestId);
    const requester: Participant = { connectionId: this.id, device: identityOf(self) };
    const sessionId = crypto.randomUUID();
    const [app, own, peer] = sessionSlots(requester.device, target, this.#limits.quotas);
    const pending = pendingSlot(requester.device, target);
    if (!(await this.#acquireSessionSlots(sessionId, [app, own, pending]))) {
      return this.#error('quota_exceeded', requestId);
    }
    // A busy target looks unreachable, so its load is not revealed; the operator still learns of
    // it, as of a quota refused (ADR 0016).
    if (!(await this.#acquireSessionSlots(sessionId, [peer]))) {
      await this.#deps.coordination.releaseSlots(sessionId, [app.key, own.key, pending.key]);
      this.#suspectAbuse();
      return this.#error('peer_unavailable', requestId);
    }
    const session = {
      id: sessionId,
      namespace,
      requester,
      target: { connectionId: targetId, device: target },
      durationMs: this.#durationMs(),
    };
    this.#open(session);
    this.#deps.metrics.count('blindsignal_sessions_created_total');
    this.#deps.metrics.count('blindsignal_application_sessions_created_total', {
      app_id: self.appId,
    });
    this.#send({ type: 'session.created', requestId, payload: { sessionId } });
    await this.#notify(targetId, { type: 'session.request', session });
  }

  /** Keeps this connection's copy of a new session, which times out while still pending. */
  #open(session: Omit<Session, 'state'>): void {
    this.#sessions.create(
      session,
      this.#deps.negotiationTimeoutMs,
      (expired) => void this.#enqueue(() => this.#terminate(expired, 'timeout', true)),
    );
  }

  #durationMs(): number {
    return this.#limits.quotas.sessionDurationSeconds * 1000;
  }

  /** The other participant's connection changed the session; updates this copy to match. */
  async #onSessionEvent(event: SessionEvent): Promise<void> {
    const self = this.#context as ConnectionContext;
    if (event.type === 'session.request') {
      const { session } = event;
      // Only a requester of the same application asks, and only of this connection.
      if (
        event.from !== session.requester.connectionId ||
        session.requester.device.appId !== self.appId ||
        session.target.connectionId !== this.id ||
        !sameDevice(session.target.device, self) ||
        this.#sessions.get(session.id) !== undefined
      ) {
        return this.#dropped('stale');
      }
      // Answered as a rejection, so the requester cannot tell a refusal from a policy (ADR 0040).
      if (!this.#permits(session.namespace, 'session.accept')) {
        const rejected = { type: 'session.rejected', sessionId: session.id } as const;
        return this.#notify(session.requester.connectionId, rejected);
      }
      this.#open({ ...session, durationMs: session.durationMs ?? this.#durationMs() });
      const { userId, deviceId } = session.requester.device;
      const payload = { sessionId: session.id, namespace: session.namespace, userId, deviceId };
      return this.#send({ type: 'session.request', payload });
    }
    const { sessionId } = event;
    const session = this.#sessions.get(sessionId);
    // Gone already: this side ended it too, and the two ends crossed. Or not from the peer.
    if (session === undefined || event.from !== this.#peerOf(session)) {
      return this.#dropped('stale');
    }
    // Only the target answers a request, while it is pending.
    const answer = event.type === 'session.accepted' || event.type === 'session.rejected';
    if (answer && (!this.#requested(session) || session.state !== 'pending')) {
      return this.#dropped('stale');
    }
    if (event.type === 'session.accepted') {
      const pendingMs = this.#sessions.activate(sessionId) as number;
      await this.#releasePending(session);
      // Only the requester receives the event, so each session is observed once (ADR 0038).
      this.#deps.metrics.observe('blindsignal_session_acceptance_seconds', pendingMs / 1000);
      this.#send({ type: 'session.accepted', payload: { sessionId } });
      return;
    }
    await this.#end(session);
    if (event.type === 'session.rejected') {
      return this.#send({ type: 'session.rejected', payload: { sessionId } });
    }
    this.#countTermination(session, event.reason);
    this.#send({ type: 'session.terminated', payload: { sessionId, reason: event.reason } });
  }

  /** `session.accept` and `session.reject` from the target; `session.close` from either side. */
  async #answerSession(message: SessionMessage): Promise<void> {
    const { requestId, type } = message;
    const { sessionId } = message.payload;
    const session = this.#sessions.get(sessionId);
    const allowed =
      session !== undefined &&
      (type === 'session.close'
        ? this.#participates(session)
        : session.state === 'pending' && session.target.connectionId === this.id);
    if (!allowed) return this.#error('session_unavailable', requestId);
    // A refresh may have withdrawn the permission since the request arrived.
    if (type === 'session.accept' && !this.#permits(session.namespace, 'session.accept')) {
      return this.#error('not_authorized', requestId);
    }
    this.#ack(requestId);
    if (type === 'session.close') return this.#terminate(session, 'closed_by_peer');
    if (type === 'session.accept') {
      this.#sessions.activate(sessionId);
      await this.#releasePending(session);
      return this.#notify(session.requester.connectionId, { type: 'session.accepted', sessionId });
    }
    await this.#end(session);
    await this.#notify(session.requester.connectionId, { type: 'session.rejected', sessionId });
  }

  /**
   * Asks the user's other devices present in the namespace to approve this one (ADR 0042). Only a
   * device whose token is bound to a key may ask: the approval binds that key.
   */
  async #createPairing(message: ClientMessage & { type: 'pairing.create' }): Promise<void> {
    const { requestId, payload } = message;
    const { namespace } = payload;
    if (!(await this.#limit('pairing', requestId))) return;
    const self = this.#context as ConnectionContext;
    if (!self.pairing?.includes(namespace) || self.keyThumbprint === undefined) {
      return this.#error('not_authorized', requestId);
    }
    // The user's own devices only, up to the quota: a backend invites other users.
    const approvers: string[] = [];
    const present = await this.#deps.coordination.listPresence(namespace, { userId: self.userId });
    for (const device of present) {
      if (approvers.length >= this.#limits.quotas.pairingApprovers) break;
      if (this.#isSelf(device)) continue;
      const connectionId = await this.#deps.coordination.connectionOf(device);
      if (connectionId !== undefined) approvers.push(connectionId);
    }
    if (approvers.length === 0) return this.#error('peer_unavailable', requestId);
    const pairing: Pairing = {
      id: crypto.randomUUID(),
      namespace,
      requester: { connectionId: this.id, device: identityOf(self) },
      keyThumbprint: self.keyThumbprint,
    };
    this.#pairings.add(pairing.id, { pairing, approvers }, this.#deps.negotiationTimeoutMs, () => {
      void this.#enqueue(() => {
        this.#concludePairing(pairing.id, 'timeout');
        const payload = { pairingId: pairing.id, reason: 'timeout' } as const;
        // Each asked device's own timeout ends its copy.
        this.#send({ type: 'pairing.ended', payload });
        return Promise.resolve();
      });
    });
    this.#send({ type: 'pairing.created', requestId, payload: { pairingId: pairing.id } });
    this.#deps.logger.log('info', 'pairing.requested', {
      appId: self.appId,
      pairingId: pairing.id,
    });
    for (const approver of approvers) {
      await this.#notify(approver, { type: 'pairing.request', pairing });
    }
  }

  /** `pairing.approve` and `pairing.reject`, from a device the request reached. */
  async #answerPairing(
    message: ClientMessage & { type: 'pairing.approve' | 'pairing.reject' },
  ): Promise<void> {
    const { requestId, type, payload } = message;
    const pairing = this.#pairingRequests.get(payload.pairingId);
    if (pairing === undefined) return this.#error('pairing_unavailable', requestId);
    let answer: Unsent<PairingEvent> = { type: 'pairing.rejected', pairingId: pairing.id };
    if (type === 'pairing.approve') {
      // A refresh may have withdrawn the permission since the request arrived.
      if (!this.#permits(pairing.namespace, 'pairing.approve')) {
        return this.#error('not_authorized', requestId);
      }
      // The request reached only connections bound to a key, which a refresh keeps (ADR 0041).
      const key = (this.#context as ConnectionContext).keyThumbprint as string;
      const { approval } = message.payload;
      if (!(await approves(approval, pairing, key))) {
        return this.#error('invalid_message', requestId);
      }
      answer = { type: 'pairing.approved', pairingId: pairing.id, approval };
    }
    this.#pairingRequests.take(pairing.id);
    this.#ack(requestId);
    await this.#notify(pairing.requester.connectionId, answer);
  }

  /** A connection taking part in a pairing changed it; this one updates its copy. */
  async #onPairingEvent(event: PairingEvent): Promise<void> {
    if (event.type === 'pairing.request') {
      const { pairing } = event;
      const self = this.#context as ConnectionContext;
      const requester = pairing.requester.device;
      // Only the requester asks, and only its user's other devices.
      if (
        event.from !== pairing.requester.connectionId ||
        requester.appId !== self.appId ||
        requester.userId !== self.userId ||
        this.#isSelf(requester) ||
        this.#pairingRequests.get(pairing.id) !== undefined
      ) {
        return this.#dropped('stale');
      }
      // A device that may not approve never hears of the request.
      if (
        this.#context?.keyThumbprint === undefined ||
        !this.#permits(pairing.namespace, 'pairing.approve')
      ) {
        return;
      }
      const pairingId = pairing.id;
      this.#pairingRequests.add(pairingId, pairing, this.#deps.negotiationTimeoutMs, () => {
        // In case the requester's instance is gone and its own timeout never comes.
        const payload = { pairingId, reason: 'timeout' } as const;
        void this.#enqueue(() => Promise.resolve(this.#send({ type: 'pairing.ended', payload })));
      });
      const { userId, deviceId } = pairing.requester.device;
      const { namespace, keyThumbprint: jkt } = pairing;
      const payload = { pairingId, namespace, userId, deviceId, jkt };
      return this.#send({ type: 'pairing.request', payload });
    }
    const { pairingId } = event;
    if (event.type === 'pairing.ended') {
      // Only the requester ends a request.
      if (this.#pairingRequests.get(pairingId)?.requester.connectionId !== event.from) {
        return this.#dropped('stale');
      }
      this.#pairingRequests.take(pairingId);
      return this.#send({ type: 'pairing.ended', payload: { pairingId, reason: event.reason } });
    }
    // Gone already: it timed out, or another device answered first. Or from no device asked.
    if (!this.#pairings.get(pairingId)?.approvers.includes(event.from)) {
      return this.#dropped('stale');
    }
    const entry = this.#pairings.take(pairingId) as { approvers: readonly string[] };
    // The device that answered has no copy left, and ignores it.
    const ended = { type: 'pairing.ended', pairingId, reason: 'answered' } as const;
    for (const approver of entry.approvers) await this.#notify(approver, ended);
    if (event.type === 'pairing.approved') {
      this.#concludePairing(pairingId, 'approved');
      this.#send({ type: 'pairing.approved', payload: { pairingId, approval: event.approval } });
    } else {
      this.#concludePairing(pairingId, 'rejected');
      this.#send({ type: 'pairing.rejected', payload: { pairingId } });
    }
  }

  /** Counted and logged by the requester's connection, so each pairing is audited once. */
  #concludePairing(pairingId: string, result: 'approved' | 'rejected' | 'timeout'): void {
    this.#deps.metrics.count('blindsignal_pairings_total', { result });
    const event = result === 'timeout' ? 'pairing.expired' : `pairing.${result}`;
    this.#deps.logger.log('info', event, { appId: this.#context?.appId, pairingId });
  }

  /** Rebuilds an `rtc.*` message for the other participant of an active session (§7). */
  async #relay(message: RtcMessage): Promise<void> {
    const { requestId, type, payload } = message;
    const session = this.#sessions.get(payload.sessionId);
    if (session?.state !== 'active' || !this.#participates(session)) {
      return this.#error('session_unavailable', requestId);
    }
    // Keyed by session, after the check, so only an active session's participants make buckets.
    const category = type === 'rtc.ice_candidate' ? 'rtc_ice_candidate' : 'rtc';
    if (!(await this.#limit(category, requestId, session.id))) return;
    // The parsed payload holds only the schema's fields: no requestId, no sender, no extra keys.
    const relayed = { type, payload } as Deliver['message'];
    await this.#notify(this.#peerOf(session), { type: 'deliver', message: relayed });
  }

  /** Ends the session; tells the other participant, and this one too when `both` is set. */
  async #terminate(session: Session, reason: TerminationReason, both = false): Promise<void> {
    if (!(await this.#end(session))) return;
    this.#countTermination(session, reason);
    const sessionId = session.id;
    if (both) this.#send({ type: 'session.terminated', payload: { sessionId, reason } });
    await this.#notify(this.#peerOf(session), { type: 'session.terminated', sessionId, reason });
  }

  /** Counted by the requester's connection, so a session ended on both sides counts once. */
  #countTermination(session: Session, reason: TerminationReason): void {
    if (this.#requested(session)) {
      this.#deps.metrics.count('blindsignal_sessions_terminated_total', { reason });
    }
  }

  #requested(session: Session): boolean {
    return session.requester.connectionId === this.id;
  }

  /**
   * Removes this copy of the session and frees its quota slots; true when the copy existed. Both
   * sides release, harmlessly twice.
   */
  async #end(session: Session): Promise<boolean> {
    if (!this.#sessions.end(session.id)) return false;
    const { requester, target } = session;
    const slots = [
      ...sessionSlots(requester.device, target.device, this.#limits.quotas),
      pendingSlot(requester.device, target.device),
    ];
    await this.#deps.coordination.releaseSlots(
      session.id,
      slots.map(({ key }) => key),
    );
    return true;
  }

  /** An accepted session no longer counts as its requester's pending one for the target. */
  #releasePending({ id, requester, target }: Session): Promise<void> {
    const { key } = pendingSlot(requester.device, target.device);
    return this.#deps.coordination.releaseSlots(id, [key]);
  }

  #participates(session: Session): boolean {
    return session.requester.connectionId === this.id || session.target.connectionId === this.id;
  }

  #peerOf(session: Session): string {
    return session.requester.connectionId === this.id
      ? session.target.connectionId
      : session.requester.connectionId;
  }

  /** Publishes on the connection's topic, signed with this connection's ID for the receiver. */
  #notify(connectionId: string, event: Unsent<ConnectionEvent>): Promise<void> {
    const signed = { ...event, from: this.id };
    return this.#deps.coordination.publish(connectionTopic(connectionId), signed);
  }

  #acquireConnectionSlot(): Promise<boolean> {
    const slot = { key: this.#slot as string, limit: this.#limits.quotas.connections };
    return this.#deps.coordination.acquireSlots(this.id, [slot], this.#deps.presenceLeaseMs);
  }

  #acquireSessionSlots(sessionId: string, slots: readonly Slot[]): Promise<boolean> {
    return this.#deps.coordination.acquireSlots(sessionId, slots, this.#deps.presenceLeaseMs);
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

  #onPresence(received: unknown): void {
    const parsed = presenceEvent.safeParse(received);
    if (!parsed.success) return this.#dropped('invalid');
    const event: PresenceChanged = parsed.data;
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
      maxDevicesPerUser: this.#limits.quotas.devicesPerUser,
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
    const { iceServers, turn, metrics } = this.#deps;
    if (turn === undefined) {
      this.#send({ type: 'rtc.ice_config', payload: { iceServers: [...iceServers] } });
    } else {
      const server = turnServer(turn, context.appId, new Date());
      this.#send({ type: 'rtc.ice_config', payload: { iceServers: [...iceServers, server] } });
      metrics.count('blindsignal_turn_credentials_issued_total', { app_id: context.appId });
    }
    clearTimeout(this.#expiryTimer);
    this.#expiryTimer = setTimeout(
      () =>
        void this.#enqueue(() => Promise.resolve(this.#error('token_expired', undefined, true))),
      expiresInMs + this.#deps.clockSkewSeconds * 1000,
    );
  }

  /** Parsed before it is queued; checked against this connection's copy once its turn comes. */
  #onEvent(received: unknown): void {
    const parsed = connectionEvent.safeParse(received);
    if (!parsed.success) return this.#dropped('invalid');
    const event = parsed.data;
    if (event.type === 'superseded') {
      void this.#enqueue(() => this.#onSuperseded());
    } else if (event.type === 'deliver') {
      void this.#enqueue(() => Promise.resolve(this.#onDeliver(event)));
    } else if (event.type.startsWith('session.')) {
      void this.#enqueue(() => this.#onSessionEvent(event as SessionEvent));
    } else {
      void this.#enqueue(() => this.#onPairingEvent(event as PairingEvent));
    }
  }

  /** A newer connection took the claim; an event older than this connection's own claim is not. */
  async #onSuperseded(): Promise<void> {
    const device = identityOf(this.#context as ConnectionContext);
    if ((await this.#deps.coordination.connectionOf(device)) === this.id) {
      return this.#dropped('stale');
    }
    this.#error('superseded', undefined, true);
  }

  /**
   * Relayed only within an active session, from its other participant (§7). Dropped while this
   * connection's send buffer is half full, so a peer that floods its session loses its own
   * negotiation instead of closing this connection (ADR 0013).
   */
  #onDeliver({ from, message }: Deliver): void {
    const session = this.#sessions.get(message.payload.sessionId);
    if (session?.state !== 'active' || from !== this.#peerOf(session)) {
      return this.#dropped('stale');
    }
    if ((this.#port.bufferedBytes ?? 0) > this.#deps.maxBufferedBytes / 2) {
      return this.#dropped('overloaded');
    }
    this.#send(message);
  }

  /**
   * An event that matches no schema, or no longer matches this connection's copy, or that came
   * from a connection other than the one the copy names (ADR 0023).
   */
  #dropped(reason: 'invalid' | 'stale' | 'overloaded'): void {
    this.#deps.metrics.count('blindsignal_coordination_events_dropped_total', { reason });
    // Never the event: it may hold what a peer sent (ADR 0037).
    if (reason === 'invalid') {
      this.#deps.logger.log('warn', 'coordination.invalid_event', {
        connectionId: this.id,
        appId: this.#context?.appId,
      });
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
   * Counts an `error` sent, and by application once a token is verified (ADR 0015); an
   * application's `rate_limited` and `quota_exceeded` may raise an abuse alert (ADR 0016).
   */
  #countError(code: ErrorCode): void {
    this.#deps.metrics.count('blindsignal_errors_total', { code });
    const appId = this.#appId;
    if (appId === undefined) return;
    this.#deps.metrics.count('blindsignal_application_errors_total', { app_id: appId, code });
    if (code === 'rate_limited' || code === 'quota_exceeded') this.#suspectAbuse();
  }

  /**
   * Records one rejection of the application, which may raise an abuse alert naming the
   * connection whose rejection reached the threshold (ADR 0016).
   */
  #suspectAbuse(): void {
    const appId = this.#appId;
    if (appId === undefined || !this.#deps.abuse.record(appId)) return;
    this.#deps.logger.log('warn', 'application.abuse_suspected', { connectionId: this.id, appId });
    this.#deps.metrics.count('blindsignal_abuse_alerts_total', { app_id: appId });
  }

  /**
   * A task rejected, such as when storage is unreachable: the connection closes with
   * `server_error`, and the queue keeps running for the tasks already in it (ADR 0021).
   */
  #failed(error: unknown): void {
    // The SQLSTATE or the error's name only: a driver's message may quote values.
    const code = (error as { code?: unknown } | undefined)?.code;
    this.#deps.logger.log('error', 'connection.failed', {
      connectionId: this.id,
      appId: this.#context?.appId,
      reason: typeof code === 'string' ? code : error instanceof Error ? error.name : 'unknown',
    });
    if (!this.#closed) this.#error('server_error', undefined, true);
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
    this.#countError(code);
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
