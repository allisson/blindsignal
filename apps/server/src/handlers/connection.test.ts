import { InMemoryCoordinationAdapter } from '@blindsignal/coordination-memory';
import { devApplication, mintDevToken } from '@blindsignal/dev-issuer';
import type { ApplicationRecord } from '@blindsignal/core';
import type { ServerMessage } from '@blindsignal/protocol';
import {
  InMemoryApplicationRepository,
  InMemoryDeviceRepository,
} from '@blindsignal/storage-memory';
import { createHash } from 'node:crypto';
import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config.ts';
import { AbuseMonitor } from '../domain/abuse.ts';
import { TokenVerifier } from '../domain/auth.ts';
import type { Limits } from '../domain/limits.ts';
import { parseRegistry } from '../domain/registry.ts';
import { Metrics } from '../telemetry.ts';
import {
  Connection,
  connectionTopic,
  POLICY_VIOLATION,
  presenceTopic,
  TRY_AGAIN_LATER,
  type ConnectionDependencies,
} from './connection.ts';

const START = new Date('2026-11-02T00:00:00Z');
const SKEW_MS = 60_000;
const LIFETIME_MS = 300_000;
const LEASE_MS = 90_000;
const NEGOTIATION_MS = 30_000;
const AUTH_MS = 10_000;
const ICE = [{ urls: ['stun:stun.example:3478'] }];
const defaults = loadConfig({
  BLINDSIGNAL_ENV: 'development',
  BLINDSIGNAL_REGISTRY_PATH: 'unused',
});
if (!defaults.ok) throw new Error(defaults.error);
const { maxQueuedMessages, maxBufferedBytes, abuseAlerts } = defaults.config;
/** The server defaults, with a device quota. */
const limits = (devices: number): Limits => ({
  ...defaults.config.limits,
  quotas: { ...defaults.config.limits.quotas, devices },
});
const d1 = { app_id: 'notes', sub: 'u1', device_id: 'd1' };
/** The notes application with its own rate limits. */
const limited = (rateLimits: object) => [{ ...devApplication('notes'), rateLimits }];
const ONE_PER_SECOND = { ratePerSecond: 1, burst: 1 };
const rateLimited = (requestId?: string) => ({
  version: 1,
  type: 'error',
  ...(requestId === undefined ? {} : { requestId }),
  payload: { code: 'rate_limited', retryAfterMs: 1000 },
});

beforeEach(() => {
  vi.useFakeTimers({ now: START });
});

afterEach(() => {
  vi.useRealTimers();
});

async function setup(
  entries: object[] = [devApplication('notes')],
  options: Partial<ConnectionDependencies> = {},
) {
  const applications = new InMemoryApplicationRepository();
  const coordination = new InMemoryCoordinationAdapter();
  const devices = new InMemoryDeviceRepository();
  const load = async (list: object[]) => {
    const result = parseRegistry(JSON.stringify({ applications: list }), {
      now: START,
      development: true,
    });
    if (!result.ok) throw new Error(result.error);
    await applications.replaceAll(result.registry.applications);
    return result.registry.applications;
  };
  await load(entries);
  const metrics = new Metrics();
  const logs: object[] = [];
  const deps: ConnectionDependencies = {
    verifier: new TokenVerifier({
      applications,
      coordination,
      maxLifetimeSeconds: 600,
      clockSkewSeconds: SKEW_MS / 1000,
      maxNamespaces: 100,
      startedAt: START,
    }),
    devices,
    coordination,
    iceServers: ICE,
    clockSkewSeconds: SKEW_MS / 1000,
    authenticationTimeoutMs: AUTH_MS,
    authenticationAttempts: { ratePerSecond: 100, burst: 100 },
    deviceTtlMs: 86_400_000,
    limits: limits(10),
    presenceLeaseMs: LEASE_MS,
    negotiationTimeoutMs: NEGOTIATION_MS,
    maxQueuedMessages,
    maxBufferedBytes,
    abuse: new AbuseMonitor(abuseAlerts),
    metrics,
    logger: { log: (level, event, fields) => logs.push({ level, event, ...fields }) },
    ...options,
  };

  /** A connection whose transport, like the real one, reports its own close unless told not to. */
  const connect = ({ reportsClose = true, clientIp = '192.0.2.1' } = {}) => {
    const sent: ServerMessage[] = [];
    const closes: number[] = [];
    const flow: string[] = [];
    let buffered = 0;
    let authenticated = 0;
    const connection: Connection = new Connection(
      {
        clientIp,
        send: (message) => sent.push(message),
        authenticated: () => authenticated++,
        get bufferedBytes() {
          return buffered;
        },
        pause: () => flow.push('pause'),
        resume: () => flow.push('resume'),
        close: (code) => {
          closes.push(code);
          if (reportsClose) void connection.closed();
        },
      },
      deps,
    );
    let n = 0;
    const request = (type: string, payload: object = {}, extra: object = {}) =>
      connection.receive(
        JSON.stringify({ version: 1, type, requestId: `r${++n}`, payload, ...extra }),
      );
    const authenticate = async (claims: object = d1) =>
      request('auth.authenticate', {
        token: await mintDevToken({ ...d1, ...claims }, { now: new Date() }),
      });
    const refresh = async (claims: object = d1) =>
      request('auth.refresh', {
        token: await mintDevToken({ ...d1, ...claims }, { now: new Date() }),
      });
    const errors = () =>
      sent.flatMap((message) => (message.type === 'error' ? [message.payload.code] : []));
    const presence = () =>
      sent.flatMap((message) => (message.type === 'presence.changed' ? [message.payload] : []));
    const last = () => sent.at(-1);
    return {
      connection,
      sent,
      closes,
      request,
      authenticate,
      refresh,
      errors,
      presence,
      last,
      flow,
      /** Sets what the transport reports as waiting in its send buffer. */
      buffer: (bytes: number) => (buffered = bytes),
      authenticated: () => authenticated,
    };
  };

  return { connect, load, coordination, devices, deps, metrics, logs };
}

type Connect = Awaited<ReturnType<typeof setup>>['connect'];

/** A device key, and the token claims and auth payload that prove holding it (ADR 0041). */
async function deviceKey() {
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  const jwk = await exportJWK(publicKey);
  const cnf = { jkt: await calculateJwkThumbprint(jwk, 'sha256') };
  /** Mints a token bound to the key and signs its proof for the connection's challenge. */
  const payload = async (client: ReturnType<Connect>, claims: object = {}) => {
    const challenge = client.sent.find((message) => message.type === 'auth.challenge');
    const token = await mintDevToken({ ...d1, cnf, ...claims }, { now: new Date() });
    const ath = createHash('sha256').update(token).digest('base64url');
    const proof = await new SignJWT({ nonce: challenge?.payload.nonce, ath })
      .setProtectedHeader({ alg: 'ES256', typ: 'blindsignal-pop+jwt', jwk })
      .sign(privateKey);
    return { token, proof };
  };
  /** Signs a pairing approval with the key (ADR 0042); `header` overrides the protected header. */
  const approve = (claims: object, header: object = {}) =>
    new SignJWT({ exp: Math.floor(Date.now() / 1000) + 300, ...claims })
      .setProtectedHeader({ alg: 'ES256', typ: 'blindsignal-pairing+jwt', jwk, ...header })
      .sign(privateKey);
  return { cnf, payload, approve };
}

describe('Connection', () => {
  describe('authentication deadline', () => {
    it('closes a connection still unauthenticated at the deadline, with no error', async () => {
      const { connect, logs } = await setup();
      const client = connect();
      await vi.advanceTimersByTimeAsync(AUTH_MS - 1);
      expect(client.closes).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(client.closes).toEqual([POLICY_VIOLATION]);
      expect(client.sent).toEqual([]);
      expect(logs).toEqual([
        {
          level: 'info',
          event: 'connection.authentication_timeout',
          connectionId: client.connection.id,
        },
      ]);
      await client.authenticate();
      expect(client.sent).toEqual([]);
    });

    it('spares an authenticated connection, and reports it authenticated once', async () => {
      const { connect } = await setup();
      const client = connect();
      await client.authenticate();
      await client.refresh();
      await vi.advanceTimersByTimeAsync(AUTH_MS);
      expect(client.closes).toEqual([]);
      expect(client.authenticated()).toBe(1);
    });

    it('lets an authentication in flight at the deadline finish', async () => {
      const { connect } = await setup();
      const client = connect();
      const token = await mintDevToken(d1, { now: new Date() });
      await vi.advanceTimersByTimeAsync(AUTH_MS - 1);
      const authenticating = client.request('auth.authenticate', { token });
      vi.advanceTimersByTime(1);
      await authenticating;
      await vi.advanceTimersByTimeAsync(0);
      expect(client.closes).toEqual([]);
      expect(client.connection.context).toBeDefined();
    });

    it('stops the deadline once the transport reports the close', async () => {
      const { connect, logs } = await setup();
      const client = connect();
      await client.connection.closed();
      await vi.advanceTimersByTimeAsync(AUTH_MS);
      expect(logs).toEqual([]);
    });

    it('does not report a failed authentication as authenticated', async () => {
      const { connect } = await setup();
      const client = connect();
      await client.authenticate({ aud: 'other' });
      expect(client.authenticated()).toBe(0);
    });
  });

  describe('proof of possession (ADR 0041)', () => {
    it('challenges each connection with its own nonce', async () => {
      const { connect } = await setup();
      const [one, two] = [connect(), connect()];
      one.connection.challenge();
      two.connection.challenge();
      const nonces = [one.last(), two.last()].map((message) => {
        expect(message?.type).toBe('auth.challenge');
        return (message as ServerMessage & { type: 'auth.challenge' }).payload.nonce;
      });
      expect(nonces[0]).toMatch(/^[\w-]{43}$/);
      expect(nonces[0]).not.toBe(nonces[1]);
    });

    it('accepts a proof for its own challenge only', async () => {
      const { connect } = await setup();
      const key = await deviceKey();
      const [client, other] = [connect(), connect()];
      client.connection.challenge();
      other.connection.challenge();
      await other.request('auth.authenticate', await key.payload(client));
      expect(other.errors()).toEqual(['invalid_token']);
      await client.request('auth.authenticate', await key.payload(client));
      expect(client.connection.context?.keyThumbprint).toBe(key.cnf.jkt);
    });

    it('refreshes with the same key, and rejects another, a new, or a dropped one', async () => {
      const { connect } = await setup();
      const [key, otherKey] = [await deviceKey(), await deviceKey()];
      const client = connect();
      client.connection.challenge();
      await client.request('auth.authenticate', await key.payload(client));
      await client.request('auth.refresh', await key.payload(client));
      expect(client.last()?.type).toBe('rtc.ice_config');
      await client.request('auth.refresh', await otherKey.payload(client));
      await client.refresh();
      expect(client.errors()).toEqual(['identity_mismatch', 'identity_mismatch']);

      const unbound = connect();
      unbound.connection.challenge();
      await unbound.authenticate({ device_id: 'd2' });
      await unbound.request('auth.refresh', await key.payload(unbound, { device_id: 'd2' }));
      expect(unbound.errors()).toEqual(['identity_mismatch']);
      expect(client.closes).toEqual([]);
    });
  });

  describe('authentication attempts', () => {
    const attempts = { ratePerSecond: 1, burst: 2 };

    it('limits auth.authenticate and auth.refresh per client IP, keeping the connection', async () => {
      const { connect, deps } = await setup(undefined, { authenticationAttempts: attempts });
      const verify = vi.spyOn(deps.verifier, 'verify');
      const first = connect();
      await first.authenticate();
      await first.refresh();
      await first.refresh();
      expect(first.last()).toEqual({
        version: 1,
        type: 'error',
        requestId: 'r3',
        payload: { code: 'rate_limited', retryAfterMs: 1000 },
      });
      const second = connect();
      await second.authenticate({ device_id: 'd2' });
      expect(second.errors()).toEqual(['rate_limited']);
      expect(second.connection.context).toBeUndefined();
      expect([first.closes, second.closes]).toEqual([[], []]);
      expect(verify).toHaveBeenCalledTimes(2);

      await connect({ clientIp: '192.0.2.2' }).authenticate({ device_id: 'd3' });
      expect(verify).toHaveBeenCalledTimes(3);
      vi.advanceTimersByTime(1000);
      await second.authenticate({ device_id: 'd2' });
      expect(second.connection.context?.deviceId).toBe('d2');
    });

    it('counts a rate_limited error', async () => {
      const { connect, metrics } = await setup(undefined, {
        authenticationAttempts: { ratePerSecond: 1, burst: 1 },
      });
      await connect().authenticate();
      await connect().authenticate({ device_id: 'd2' });
      const text = await metrics.render();
      expect(text).toContain('blindsignal_errors_total{code="rate_limited"} 1');
      // A rate-limited attempt is no authentication: neither counted nor timed.
      expect(text).toContain('blindsignal_authentication_duration_seconds_count{result="ok"} 1\n');
      expect(text).not.toContain('result="rate_limited"');
      // Before the token is verified, the application is not known.
      expect(text).not.toContain('blindsignal_application_errors_total{');
    });

    it('counts a rate_limited error by application once authenticated', async () => {
      const { connect, metrics } = await setup(undefined, {
        authenticationAttempts: { ratePerSecond: 1, burst: 1 },
      });
      const client = connect();
      await client.authenticate();
      await client.refresh();
      expect(await metrics.render()).toContain(
        'blindsignal_application_errors_total{app_id="notes",code="rate_limited"} 1\n',
      );
    });
  });

  describe('abuse alerts', () => {
    const alerts = (logs: object[]) =>
      logs.filter((entry) => 'event' in entry && entry.event === 'application.abuse_suspected');
    const abuse = (threshold: number) => new AbuseMonitor({ threshold, windowMs: 60_000 });

    it("alerts once when an application's rate_limited errors reach the threshold", async () => {
      const { connect, logs, metrics } = await setup(undefined, {
        authenticationAttempts: ONE_PER_SECOND,
        abuse: abuse(2),
      });
      const client = connect();
      await client.authenticate();
      await client.refresh();
      expect(alerts(logs)).toEqual([]);
      await client.refresh();
      await client.refresh();
      expect(client.errors()).toEqual(['rate_limited', 'rate_limited', 'rate_limited']);
      expect(alerts(logs)).toEqual([
        { level: 'warn', event: 'application.abuse_suspected', appId: 'notes' },
      ]);
      expect(await metrics.render()).toContain(
        'blindsignal_abuse_alerts_total{app_id="notes"} 1\n',
      );
      expect(client.closes).toEqual([]);
    });

    it('counts quota_exceeded', async () => {
      const { connect, logs } = await setup(
        [{ ...devApplication('notes'), quotas: { namespacesPerDevice: 1 } }],
        { abuse: abuse(1) },
      );
      const client = connect();
      await client.authenticate({ namespaces: ['notes:a', 'notes:b'] });
      await client.request('namespace.join', { namespace: 'notes:a' });
      await client.request('namespace.join', { namespace: 'notes:b' });
      expect(client.errors()).toEqual(['quota_exceeded']);
      expect(alerts(logs)).toHaveLength(1);
    });

    it('ignores other codes, and rejections before the token is verified', async () => {
      const { connect, logs } = await setup(undefined, {
        authenticationAttempts: ONE_PER_SECOND,
        abuse: abuse(1),
      });
      const client = connect();
      await client.authenticate();
      await client.connection.receive('garbage');
      expect(client.errors()).toEqual(['malformed_frame']);
      const other = connect();
      await other.authenticate({ device_id: 'd2' });
      expect(other.errors()).toEqual(['rate_limited']);
      expect(alerts(logs)).toEqual([]);
    });
  });

  describe('signaling rate limit', () => {
    it("limits every frame, malformed ones too, by the application's policy", async () => {
      const { connect } = await setup(limited({ signaling: { ratePerSecond: 1, burst: 3 } }));
      const client = connect();
      await client.authenticate();
      await client.request('connection.ping');
      await client.request('connection.ping');
      await client.request('no.such_type');
      expect(client.errors()).toEqual(['invalid_message']);
      await client.request('connection.ping');
      expect(client.last()).toEqual(rateLimited('r5'));
      await client.request('no.such_type');
      expect(client.last()).toEqual(rateLimited('r6'));
      await client.connection.receive('garbage');
      expect(client.last()).toEqual(rateLimited());
      expect(client.closes).toEqual([]);
      vi.advanceTimersByTime(1000);
      await client.request('connection.ping');
      expect(client.last()?.type).toBe('connection.pong');
    });

    it('limits frames before authentication by the server default, per connection', async () => {
      const signaling = { signaling: ONE_PER_SECOND };
      const { connect, deps } = await setup(undefined, {
        limits: { ...limits(10), rateLimits: { ...limits(10).rateLimits, ...signaling } },
      });
      const verify = vi.spyOn(deps.verifier, 'verify');
      const client = connect();
      await client.request('no.such_type');
      await client.authenticate();
      expect(client.errors()).toEqual(['invalid_message', 'rate_limited']);
      expect(client.last()).toEqual(rateLimited('r2'));
      expect(verify).not.toHaveBeenCalled();
      const other = connect();
      await other.authenticate();
      expect(other.connection.context).toBeDefined();
    });
  });

  describe('backpressure', () => {
    it('pauses reading at half the queue and resumes once it drains', async () => {
      const { connect } = await setup(undefined, { maxQueuedMessages: 4 });
      const client = connect();
      await client.authenticate();
      const first = client.request('connection.ping');
      expect(client.flow).toEqual([]);
      const second = client.request('connection.ping');
      expect(client.flow).toEqual(['pause']);
      await Promise.all([first, second]);
      expect(client.flow).toEqual(['pause', 'resume']);
      expect(client.sent.filter((m) => m.type === 'connection.pong')).toHaveLength(2);
      expect(client.closes).toEqual([]);
    });

    it('closes with 1013 and no error when the queue is full, then releases', async () => {
      const { connect, coordination, logs, metrics } = await setup(undefined, {
        maxQueuedMessages: 4,
      });
      const client = connect();
      await client.authenticate({ namespaces: ['notes:a'] });
      await client.request('namespace.join', { namespace: 'notes:a' });
      const before = client.sent.length;
      const frames = Array.from({ length: 5 }, () => client.request('connection.ping'));
      expect(client.closes).toEqual([TRY_AGAIN_LATER]);
      await Promise.all(frames);
      // The queued frames are dropped with the connection; nothing waits behind the backlog.
      expect(client.sent).toHaveLength(before);
      expect(await coordination.listPresence('notes:a')).toEqual([]);
      expect(logs).toContainEqual({
        level: 'warn',
        event: 'connection.overloaded',
        connectionId: client.connection.id,
        appId: 'notes',
        limit: 'queued_messages',
      });
      expect(await metrics.render()).toContain(
        'blindsignal_overloaded_connections_total{limit="queued_messages"} 1',
      );
    });

    it('counts events toward the queue', async () => {
      const { connect, coordination } = await setup(undefined, { maxQueuedMessages: 2 });
      const client = connect();
      await client.authenticate();
      const topic = connectionTopic(client.connection.id);
      const pong = { type: 'deliver', message: { type: 'connection.pong', payload: {} } };
      await coordination.publish(topic, pong);
      await coordination.publish(topic, pong);
      await coordination.publish(topic, pong);
      expect(client.closes).toEqual([TRY_AGAIN_LATER]);
    });

    it('closes with 1013 once the send buffer passes the limit', async () => {
      const { connect, logs } = await setup(undefined, { maxBufferedBytes: 1000 });
      // The socket is still closing: frames read meanwhile are not handled.
      const client = connect({ reportsClose: false });
      await client.authenticate();
      client.buffer(1000);
      await client.request('connection.ping');
      expect(client.closes).toEqual([]);
      client.buffer(1001);
      await client.request('connection.ping');
      expect(client.closes).toEqual([TRY_AGAIN_LATER]);
      expect(client.sent.filter((m) => m.type === 'connection.pong')).toHaveLength(2);
      expect(logs).toContainEqual(
        expect.objectContaining({ event: 'connection.overloaded', limit: 'buffered_bytes' }),
      );
      await client.request('connection.ping');
      expect(client.sent.filter((m) => m.type === 'connection.pong')).toHaveLength(2);
    });

    it('closes once when an error overflows the buffer', async () => {
      const { connect, logs } = await setup(undefined, { maxBufferedBytes: 1000 });
      const client = connect();
      client.buffer(1001);
      await client.request('namespace.join', { namespace: 'notes:a' });
      expect(client.errors()).toEqual(['not_authenticated']);
      expect(client.closes).toEqual([TRY_AGAIN_LATER]);
      expect(logs.filter((l) => 'event' in l && l.event === 'connection.error')).toEqual([]);
    });
  });

  describe('joined-namespace quota', () => {
    const namespaces = ['notes:a', 'notes:b'];

    it('refuses a new namespace beyond the quota, without closing', async () => {
      const { connect } = await setup([
        { ...devApplication('notes'), quotas: { namespacesPerDevice: 1 } },
      ]);
      const client = connect();
      await client.authenticate({ namespaces });
      await client.request('namespace.join', { namespace: 'notes:a' });
      await client.request('namespace.join', { namespace: 'notes:a' });
      await client.request('namespace.join', { namespace: 'notes:b' });
      expect(client.errors()).toEqual(['quota_exceeded']);
      expect(client.closes).toEqual([]);
      await client.request('namespace.leave', { namespace: 'notes:a' });
      await client.request('namespace.join', { namespace: 'notes:b' });
      expect(client.errors()).toEqual(['quota_exceeded']);
    });

    it('reads the quota from the registry again on auth.refresh', async () => {
      const { connect, load } = await setup();
      const client = connect();
      await client.authenticate({ namespaces });
      await load([{ ...devApplication('notes'), quotas: { namespacesPerDevice: 1 } }]);
      await client.refresh({ namespaces });
      await client.request('namespace.join', { namespace: 'notes:a' });
      await client.request('namespace.join', { namespace: 'notes:b' });
      expect(client.errors()).toEqual(['quota_exceeded']);
    });
  });

  describe('application connection quota', () => {
    const oneConnection = [{ ...devApplication('notes'), quotas: { connections: 1 } }];

    it("refuses a connection beyond the registry entry's quota, until one closes", async () => {
      const { connect } = await setup(oneConnection);
      const first = connect();
      await first.authenticate();
      const second = connect();
      await second.authenticate({ device_id: 'd2' });
      expect(second.errors()).toEqual(['quota_exceeded']);
      expect(second.closes).toEqual([4001]);
      await first.connection.closed();
      const third = connect();
      await third.authenticate({ device_id: 'd2' });
      expect(third.connection.context?.deviceId).toBe('d2');
    });

    it('keeps the slot on auth.refresh', async () => {
      const { connect } = await setup(oneConnection);
      const client = connect();
      await client.authenticate();
      await client.refresh();
      expect(client.errors()).toEqual([]);
    });

    it('releases the slot when the device quota refuses the authentication', async () => {
      const { connect } = await setup(oneConnection, { limits: limits(1) });
      const first = connect();
      await first.authenticate();
      await first.connection.closed();
      const second = connect();
      await second.authenticate({ device_id: 'd2' });
      expect(second.errors()).toEqual(['quota_exceeded']);
      const third = connect();
      await third.authenticate();
      expect(third.errors()).toEqual([]);
    });

    it('renews the slot on every heartbeat, and frees it once heartbeats stop', async () => {
      const { connect } = await setup(oneConnection);
      const first = connect();
      await first.authenticate();
      await vi.advanceTimersByTimeAsync(LEASE_MS - 1_000);
      await first.connection.heartbeat();
      await vi.advanceTimersByTimeAsync(LEASE_MS - 1_000);
      const second = connect();
      await second.authenticate({ device_id: 'd2' });
      expect(second.errors()).toEqual(['quota_exceeded']);
      await vi.advanceTimersByTimeAsync(2_000);
      const third = connect();
      await third.authenticate({ device_id: 'd2' });
      expect(third.errors()).toEqual([]);
    });

    it('takes no slot for a token that fails verification', async () => {
      const { connect } = await setup(oneConnection);
      await connect().authenticate({ aud: 'other' });
      const client = connect();
      await client.authenticate();
      expect(client.errors()).toEqual([]);
    });
  });

  describe('auth.authenticate', () => {
    it('replies auth.result, then rtc.ice_config, and installs the context', async () => {
      const { connect } = await setup();
      const client = connect();
      await client.authenticate({ namespaces: ['notes:a'] });
      expect(client.sent).toEqual([
        {
          version: 1,
          type: 'auth.result',
          requestId: 'r1',
          payload: { userId: 'u1', deviceId: 'd1', expiresInMs: LIFETIME_MS },
        },
        { version: 1, type: 'rtc.ice_config', payload: { iceServers: ICE } },
      ]);
      expect(client.connection.context).toEqual({
        appId: 'notes',
        userId: 'u1',
        deviceId: 'd1',
        namespaces: ['notes:a'],
        tokenExpiresAt: new Date(START.getTime() + LIFETIME_MS),
        protocolVersion: 1,
      });
      expect(client.closes).toEqual([]);
    });

    it('adds a TURN server with a credential for the application, and counts it', async () => {
      const turn = {
        urls: ['turn:turn.example:3478'],
        secret: '0123456789abcdef0123456789abcdef',
        credentialTtlSeconds: 900,
      };
      const { connect, metrics } = await setup(undefined, { turn });
      const client = connect();
      await client.authenticate();
      // Expiry and password as in domain/turn.test.ts, at START plus 900 seconds.
      const minted = {
        urls: turn.urls,
        username: '1793578500:notes',
        credential: 'Lxc4OCwln1z5YNY7jOmDviiIpwU=',
      };
      expect(client.sent[1]).toEqual({
        version: 1,
        type: 'rtc.ice_config',
        payload: { iceServers: [...ICE, minted] },
      });
      await vi.advanceTimersByTimeAsync(100_000);
      await client.refresh();
      expect(client.last()).toEqual({
        version: 1,
        type: 'rtc.ice_config',
        payload: {
          iceServers: [
            ...ICE,
            { ...minted, username: '1793578600:notes', credential: 'rQg22C8gusOPcAH0uUT1NNgMFGU=' },
          ],
        },
      });
      expect(await metrics.render()).toContain(
        'blindsignal_turn_credentials_issued_total{app_id="notes"} 2\n',
      );
    });

    it('issues no TURN credential to a refused authentication or refresh (ADR 0009)', async () => {
      const turn = {
        urls: ['turn:turn.example:3478'],
        secret: '0123456789abcdef0123456789abcdef',
        credentialTtlSeconds: 900,
      };
      const { connect, load } = await setup(
        [{ ...devApplication('notes'), revokedDevices: [{ userId: 'u1', deviceId: 'd1' }] }],
        { turn },
      );
      const revoked = connect();
      await revoked.authenticate();
      expect(revoked.errors()).toEqual(['device_revoked']);
      const client = connect();
      await client.authenticate({ device_id: 'd2' });
      expect(client.sent.filter((m) => m.type === 'rtc.ice_config')).toHaveLength(1);
      await load([{ ...devApplication('notes'), status: 'suspended' }]);
      await client.refresh();
      expect(client.errors()).toEqual(['application_unavailable']);
      expect(client.sent.filter((m) => m.type === 'rtc.ice_config')).toHaveLength(1);
      expect(revoked.sent.filter((m) => m.type === 'rtc.ice_config')).toEqual([]);
    });

    it('counts no TURN credential when none is configured', async () => {
      const { connect, metrics } = await setup();
      await connect().authenticate();
      expect(await metrics.render()).not.toContain('blindsignal_turn_credentials_issued_total{');
    });

    it('sends an empty ICE configuration when none is configured', async () => {
      const { connect } = await setup(undefined, { iceServers: [] });
      const client = connect();
      await client.authenticate();
      expect(client.sent[1]).toEqual({
        version: 1,
        type: 'rtc.ice_config',
        payload: { iceServers: [] },
      });
    });

    it.each([
      ['invalid_token', { aud: 'other' }, 4001],
      ['token_expired', { exp: Math.floor(START.getTime() / 1000) - 120 }, 4001],
    ])('closes on %s', async (code, claims, closeCode) => {
      const { connect } = await setup();
      const client = connect();
      if (code === 'token_expired') {
        await client.request('auth.authenticate', {
          token: await mintDevToken(
            { ...d1, ...claims, iat: Math.floor(START.getTime() / 1000) - 200 },
            { now: START },
          ),
        });
      } else {
        await client.authenticate(claims);
      }
      expect(client.errors()).toEqual([code]);
      expect(client.sent[0]).toMatchObject({ requestId: 'r1' });
      expect(client.closes).toEqual([closeCode]);
      expect(client.connection.context).toBeUndefined();
    });

    it('closes with application_unavailable for a suspended application', async () => {
      const { connect } = await setup([{ ...devApplication('notes'), status: 'suspended' }]);
      const client = connect();
      await client.authenticate();
      expect(client.errors()).toEqual(['application_unavailable']);
      expect(client.closes).toEqual([4002]);
    });

    it('closes with device_revoked for a revoked device', async () => {
      const { connect } = await setup([
        { ...devApplication('notes'), revokedDevices: [{ userId: 'u1', deviceId: 'd1' }] },
      ]);
      const client = connect();
      await client.authenticate();
      expect(client.errors()).toEqual(['device_revoked']);
      expect(client.closes).toEqual([4002]);
    });

    it('creates the device record and refuses a device beyond the quota', async () => {
      const { connect, devices } = await setup(undefined, {
        limits: limits(1),
      });
      await connect().authenticate();
      const second = connect();
      await second.authenticate({ device_id: 'd2' });
      expect(second.errors()).toEqual(['quota_exceeded']);
      expect(second.closes).toEqual([4001]);
      const touched = await devices.touch(
        { appId: 'notes', userId: 'u1', deviceId: 'd1' },
        new Date(),
        { ttlMs: 86_400_000, maxDevices: 1 },
      );
      // The record holds the identity only, never the token's namespaces or expiry.
      expect(touched.ok && touched.record).toEqual({
        appId: 'notes',
        userId: 'u1',
        deviceId: 'd1',
        firstSeenAt: START,
        lastAuthenticatedAt: START,
      });
    });

    it('closes with server_error when storage fails, and logs no detail', async () => {
      const failure = Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:5432'), {
        code: 'ECONNREFUSED',
      });
      const { connect, logs } = await setup(undefined, {
        devices: { touch: () => Promise.reject(failure) },
      });
      const client = connect();
      await client.authenticate();
      expect(client.errors()).toEqual(['server_error']);
      expect(client.closes).toEqual([4001]);
      expect(logs).toContainEqual(
        expect.objectContaining({
          level: 'error',
          event: 'connection.failed',
          reason: 'ECONNREFUSED',
        }),
      );
      expect(JSON.stringify(logs)).not.toContain('10.0.0.5');
    });

    it('logs a release that coordination fails, instead of rejecting (ADR 0026)', async () => {
      const { connect, coordination, logs } = await setup();
      const client = connect();
      await client.authenticate();
      const failure = Object.assign(new Error('The client is closed'), {
        name: 'ClientClosedError',
      });
      vi.spyOn(coordination, 'releaseDeviceConnection').mockRejectedValue(failure);
      await expect(client.connection.closed()).resolves.toBeUndefined();
      expect(logs).toContainEqual(
        expect.objectContaining({
          level: 'error',
          event: 'connection.failed',
          reason: 'ClientClosedError',
        }),
      );
      expect(client.closes).toEqual([]);
    });

    it("takes the application's device quota over the server's", async () => {
      const { connect } = await setup([{ ...devApplication('notes'), quotas: { devices: 1 } }]);
      await connect().authenticate();
      const second = connect();
      await second.authenticate({ device_id: 'd2' });
      expect(second.errors()).toEqual(['quota_exceeded']);
    });

    it('answers a second auth.authenticate with invalid_message and keeps the connection', async () => {
      const { connect } = await setup();
      const client = connect();
      await client.authenticate();
      await client.authenticate({ namespaces: ['notes:b'] });
      expect(client.errors()).toEqual(['invalid_message']);
      expect(client.closes).toEqual([]);
      expect(client.connection.context?.namespaces).toEqual([]);
    });
  });

  describe('before authentication', () => {
    const sessionId = '00000000-0000-4000-8000-000000000000';
    const target = { namespace: 'notes:a', userId: 'u2', deviceId: 'd2' };
    it.each([
      ['connection.ping', {}],
      ['auth.refresh', { token: 'x' }],
      ['namespace.join', { namespace: 'notes:a' }],
      ['namespace.leave', { namespace: 'notes:a' }],
      ['discovery.request', { namespace: 'notes:a' }],
      ['session.create', target],
      ['session.accept', { sessionId }],
      ['session.reject', { sessionId }],
      ['session.close', { sessionId }],
      ['rtc.offer', { sessionId, sdp: 'v=0' }],
      ['rtc.answer', { sessionId, sdp: 'v=0' }],
      ['rtc.ice_candidate', { sessionId, candidate: 'c' }],
    ])('closes on %s with not_authenticated', async (type, payload) => {
      const { connect } = await setup();
      const client = connect();
      await client.request(type, payload);
      expect(client.sent).toEqual([
        { version: 1, type: 'error', requestId: 'r1', payload: { code: 'not_authenticated' } },
      ]);
      expect(client.closes).toEqual([4002]);
    });

    it('answers an invalid message without closing', async () => {
      const { connect } = await setup();
      const client = connect();
      await client.request('auth.authenticate', {});
      expect(client.sent).toEqual([
        { version: 1, type: 'error', requestId: 'r1', payload: { code: 'invalid_message' } },
      ]);
      expect(client.closes).toEqual([]);
    });

    it.each([
      ['malformed_frame', '{'],
      [
        'unsupported_version',
        JSON.stringify({ version: 2, type: 'x', requestId: 'r', payload: {} }),
      ],
      [
        'message_too_large',
        JSON.stringify({
          version: 1,
          type: 'x',
          requestId: 'r',
          payload: { pad: 'x'.repeat(100) },
        }),
      ],
    ])('closes on %s', async (code, frame) => {
      const { connect } = await setup(undefined, { maxMessageBytes: 64 });
      const client = connect();
      await client.connection.receive(frame);
      expect(client.errors()).toEqual([code]);
      expect(client.closes).toEqual([4002]);
    });
  });

  describe('after authentication', () => {
    it('answers connection.ping with connection.pong', async () => {
      const { connect } = await setup();
      const client = connect();
      await client.authenticate();
      await client.request('connection.ping');
      expect(client.sent.at(-1)).toEqual({
        version: 1,
        type: 'connection.pong',
        requestId: 'r2',
        payload: {},
      });
    });

    it('closes on a later message with another version', async () => {
      const { connect } = await setup();
      const client = connect();
      await client.authenticate();
      await client.request('connection.ping', {}, { version: 2 });
      expect(client.errors()).toEqual(['unsupported_version']);
      expect(client.closes).toEqual([4002]);
    });
  });

  it('handles frames one at a time, in arrival order', async () => {
    const { connect } = await setup();
    const client = connect();
    const token = await mintDevToken(d1, { now: new Date() });
    const auth = client.request('auth.authenticate', { token });
    const ping = client.request('connection.ping');
    await Promise.all([auth, ping]);
    expect(client.sent.map((message) => message.type)).toEqual([
      'auth.result',
      'rtc.ice_config',
      'connection.pong',
    ]);
  });

  it('ignores frames after the connection closed', async () => {
    const { connect } = await setup();
    const client = connect();
    await client.request('connection.ping');
    await client.request('connection.ping');
    expect(client.sent).toHaveLength(1);
    expect(client.closes).toEqual([4002]);
  });

  describe('duplicate connections (ADR 0008)', () => {
    it('closes the older connection with superseded once the newer authenticates', async () => {
      const { connect } = await setup();
      const older = connect();
      await older.authenticate();
      const newer = connect();
      await newer.authenticate();
      expect(older.sent.at(-1)).toEqual({
        version: 1,
        type: 'error',
        payload: { code: 'superseded' },
      });
      expect(older.closes).toEqual([4003]);
      expect(newer.errors()).toEqual([]);
      expect(newer.closes).toEqual([]);
    });

    it('never lets an unauthenticated or rejected connection affect the existing one', async () => {
      const { connect } = await setup();
      const existing = connect();
      await existing.authenticate();
      const rejected = connect();
      await rejected.authenticate({ aud: 'other' });
      await connect().request('connection.ping');
      expect(existing.errors()).toEqual([]);
      expect(existing.closes).toEqual([]);
    });

    it('leaves other devices alone', async () => {
      const { connect } = await setup();
      const first = connect();
      await first.authenticate();
      await connect().authenticate({ device_id: 'd2' });
      await connect().authenticate({ sub: 'u2' });
      expect(first.closes).toEqual([]);
    });

    it('keeps the newer claim when the older connection releases', async () => {
      const { connect, coordination } = await setup();
      const older = connect();
      await older.authenticate();
      const newer = connect();
      await newer.authenticate();
      await older.connection.closed();
      const device = { appId: 'notes', userId: 'u1', deviceId: 'd1' };
      expect(await coordination.claimDeviceConnection(device, 'probe')).toBe(newer.connection.id);
    });

    it('releases its claim and topic on close', async () => {
      const { connect, coordination } = await setup();
      const client = connect();
      await client.authenticate();
      expect(coordination.subscribedTopics).toBe(1);
      await client.connection.closed();
      expect(coordination.subscribedTopics).toBe(0);
      const device = { appId: 'notes', userId: 'u1', deviceId: 'd1' };
      expect(await coordination.claimDeviceConnection(device, 'probe')).toBeUndefined();
    });

    it('ignores unknown events on its topic', async () => {
      const { connect, coordination } = await setup();
      const client = connect();
      await client.authenticate();
      await coordination.publish(connectionTopic(client.connection.id), { type: 'other' });
      await coordination.publish(connectionTopic(client.connection.id), null);
      await client.request('connection.ping');
      expect(client.closes).toEqual([]);
    });
  });

  describe('auth.refresh', () => {
    it('replaces the context and sends auth.result and rtc.ice_config again', async () => {
      const { connect } = await setup();
      const client = connect();
      await client.authenticate({ namespaces: ['notes:a'] });
      await vi.advanceTimersByTimeAsync(100_000);
      await client.refresh({ namespaces: ['notes:b'] });
      expect(client.sent.slice(2)).toEqual([
        {
          version: 1,
          type: 'auth.result',
          requestId: 'r2',
          payload: { userId: 'u1', deviceId: 'd1', expiresInMs: LIFETIME_MS },
        },
        { version: 1, type: 'rtc.ice_config', payload: { iceServers: ICE } },
      ]);
      expect(client.connection.context).toMatchObject({
        namespaces: ['notes:b'],
        tokenExpiresAt: new Date(START.getTime() + 100_000 + LIFETIME_MS),
      });
    });

    it('re-arms the expiry', async () => {
      const { connect } = await setup();
      const client = connect();
      await client.authenticate();
      await vi.advanceTimersByTimeAsync(100_000);
      await client.refresh();
      await vi.advanceTimersByTimeAsync(LIFETIME_MS + SKEW_MS - 100_000);
      expect(client.closes).toEqual([]);
      await vi.advanceTimersByTimeAsync(100_000);
      expect(client.errors()).toEqual(['token_expired']);
      expect(client.closes).toEqual([4001]);
    });

    it.each([
      ['sub', { sub: 'u2' }],
      ['device_id', { device_id: 'd2' }],
      ['app_id', { app_id: 'other' }],
    ])('rejects a different %s with identity_mismatch and keeps the token', async (_, claims) => {
      const { connect } = await setup([devApplication('notes'), devApplication('other')]);
      const client = connect();
      await client.authenticate({ namespaces: ['notes:a'] });
      const before = client.connection.context;
      await client.refresh(claims);
      expect(client.sent.at(-1)).toEqual({
        version: 1,
        type: 'error',
        requestId: 'r2',
        payload: { code: 'identity_mismatch' },
      });
      expect(client.closes).toEqual([]);
      expect(client.connection.context).toBe(before);
    });

    it('keeps the connection on a retryable rejection', async () => {
      const { connect } = await setup();
      const client = connect();
      await client.authenticate();
      const before = client.connection.context;
      await client.refresh({ aud: 'other' });
      expect(client.errors()).toEqual(['invalid_token']);
      expect(client.closes).toEqual([]);
      expect(client.connection.context).toBe(before);
    });

    it('stops counting a device not seen for the device TTL', async () => {
      const { connect } = await setup(undefined, { deviceTtlMs: 1_000, limits: limits(1) });
      await connect().authenticate();
      await vi.advanceTimersByTimeAsync(2_000);
      const second = connect();
      await second.authenticate({ sub: 'u2', device_id: 'd2' });
      expect(second.errors()).toEqual([]);
    });

    it('keeps the connection on quota_exceeded', async () => {
      const { connect, devices } = await setup(undefined, {
        deviceTtlMs: 1_000,
        limits: limits(1),
      });
      const client = connect();
      await client.authenticate();
      await vi.advanceTimersByTimeAsync(2_000);
      // d1's record expired and d2 took the only slot.
      await devices.touch({ appId: 'notes', userId: 'u9', deviceId: 'd9' }, new Date(), {
        ttlMs: 1_000,
        maxDevices: 1,
      });
      await client.refresh();
      expect(client.errors()).toEqual(['quota_exceeded']);
      expect(client.closes).toEqual([]);
    });

    it('closes when the application was suspended', async () => {
      const { connect, load } = await setup();
      const client = connect();
      await client.authenticate();
      await load([{ ...devApplication('notes'), status: 'suspended' }]);
      await client.refresh();
      expect(client.errors()).toEqual(['application_unavailable']);
      expect(client.closes).toEqual([4002]);
    });
  });

  describe('namespaces and presence', () => {
    const device = (userId: string, deviceId: string) => ({ appId: 'notes', userId, deviceId });
    const event = (userId: string, deviceId: string, present: boolean, namespace = 'notes:a') => ({
      namespace,
      userId,
      deviceId,
      present,
    });

    async function joined(connect: Connect, claims: object, namespaces = ['notes:a']) {
      const client = connect();
      await client.authenticate({ ...claims, namespaces });
      for (const namespace of namespaces) await client.request('namespace.join', { namespace });
      return client;
    }

    it('acks a join, registers presence, and announces it to the other joined devices', async () => {
      const { connect, coordination } = await setup();
      const alice = await joined(connect, d1);
      expect(alice.last()).toEqual({ version: 1, type: 'ack', requestId: 'r2', payload: {} });
      const bob = await joined(connect, { sub: 'u2', device_id: 'd2' });
      expect(await coordination.listPresence('notes:a')).toEqual([
        device('u1', 'd1'),
        device('u2', 'd2'),
      ]);
      expect(alice.presence()).toEqual([event('u2', 'd2', true)]);
      expect(bob.presence()).toEqual([]);
    });

    it.each(['notes:b', 'other:a'])(
      'refuses %s, outside the token, with not_authorized',
      async (namespace) => {
        const { connect, coordination } = await setup();
        const client = connect();
        await client.authenticate({ namespaces: ['notes:a'] });
        await client.request('namespace.join', { namespace });
        expect(client.errors()).toEqual(['not_authorized']);
        expect(client.closes).toEqual([]);
        expect(await coordination.listPresence(namespace)).toEqual([]);
        expect(coordination.subscribedTopics).toBe(1);
      },
    );

    it('acks a second join without announcing it again', async () => {
      const { connect } = await setup();
      const alice = await joined(connect, d1);
      const bob = await joined(connect, { sub: 'u2', device_id: 'd2' });
      await bob.request('namespace.join', { namespace: 'notes:a' });
      expect(bob.last()).toMatchObject({ type: 'ack' });
      expect(alice.presence()).toEqual([event('u2', 'd2', true)]);
    });

    it('leaves: acks, releases presence, announces it, and stops the events', async () => {
      const { connect, coordination } = await setup();
      const alice = await joined(connect, d1);
      const bob = await joined(connect, { sub: 'u2', device_id: 'd2' });
      await bob.request('namespace.leave', { namespace: 'notes:a' });
      expect(bob.last()).toEqual({ version: 1, type: 'ack', requestId: 'r3', payload: {} });
      expect(alice.presence()).toEqual([event('u2', 'd2', true), event('u2', 'd2', false)]);
      expect(await coordination.listPresence('notes:a')).toEqual([device('u1', 'd1')]);
      await joined(connect, { sub: 'u3', device_id: 'd3' });
      expect(bob.presence()).toEqual([]);
    });

    it('acks leaving a namespace not joined', async () => {
      const { connect } = await setup();
      const client = connect();
      await client.authenticate();
      await client.request('namespace.leave', { namespace: 'notes:a' });
      expect(client.last()).toMatchObject({ type: 'ack' });
    });

    it('drops a presence event queued before a leave', async () => {
      const { connect, coordination } = await setup();
      const alice = await joined(connect, d1);
      const leave = alice.request('namespace.leave', { namespace: 'notes:a' });
      await coordination.publish(presenceTopic('notes:a'), event('u2', 'd2', true));
      await leave;
      expect(alice.presence()).toEqual([]);
    });

    it('never forwards an event about the device itself', async () => {
      const { connect, coordination } = await setup();
      const alice = await joined(connect, d1);
      await coordination.publish(presenceTopic('notes:a'), event('u1', 'd1', false));
      await alice.request('connection.ping');
      expect(alice.presence()).toEqual([]);
    });

    describe('discovery.request', () => {
      it('returns the other devices present', async () => {
        const { connect } = await setup();
        const alice = await joined(connect, d1);
        // Another user's device with the same deviceId is a different device (ADR 0006).
        await joined(connect, { sub: 'u2', device_id: 'd1' });
        await joined(connect, { sub: 'u1', device_id: 'd3' });
        await alice.request('discovery.request', { namespace: 'notes:a' });
        expect(alice.last()).toEqual({
          version: 1,
          type: 'discovery.result',
          requestId: 'r3',
          payload: {
            namespace: 'notes:a',
            devices: [
              { userId: 'u2', deviceId: 'd1' },
              { userId: 'u1', deviceId: 'd3' },
            ],
          },
        });
      });

      it('refuses a namespace outside the token with not_authorized', async () => {
        const { connect } = await setup();
        const alice = await joined(connect, d1);
        await alice.request('discovery.request', { namespace: 'notes:b' });
        expect(alice.errors()).toEqual(['not_authorized']);
      });

      it('limits requests per connection, refused ones too, keeping the connection', async () => {
        const { connect } = await setup(limited({ discovery: ONE_PER_SECOND }));
        const alice = await joined(connect, d1);
        const bob = await joined(connect, { sub: 'u2', device_id: 'd2' });
        await alice.request('discovery.request', { namespace: 'notes:b' });
        await alice.request('discovery.request', { namespace: 'notes:a' });
        expect(alice.last()).toEqual(rateLimited('r4'));
        expect(alice.closes).toEqual([]);
        await bob.request('discovery.request', { namespace: 'notes:a' });
        expect(bob.last()?.type).toBe('discovery.result');
        vi.advanceTimersByTime(1000);
        await alice.request('discovery.request', { namespace: 'notes:a' });
        expect(alice.last()?.type).toBe('discovery.result');
      });

      it('refuses an authorized namespace not joined with not_joined', async () => {
        const { connect } = await setup();
        const alice = await joined(connect, d1, []);
        await alice.refresh({ namespaces: ['notes:a'] });
        await alice.request('discovery.request', { namespace: 'notes:a' });
        expect(alice.errors()).toEqual(['not_joined']);
        expect(alice.closes).toEqual([]);
      });
    });

    it('leaves every namespace when the connection closes', async () => {
      const { connect, coordination } = await setup();
      const alice = await joined(connect, d1);
      const bob = await joined(connect, { sub: 'u2', device_id: 'd2' }, ['notes:a', 'notes:b']);
      await bob.connection.closed();
      expect(alice.presence()).toEqual([event('u2', 'd2', true), event('u2', 'd2', false)]);
      expect(await coordination.listPresence('notes:a')).toEqual([device('u1', 'd1')]);
      expect(await coordination.listPresence('notes:b')).toEqual([]);
      // Alice's own topic and notes:a; Bob's three are gone.
      expect(coordination.subscribedTopics).toBe(2);
    });

    it('never announces a superseded device as gone once its replacement joined', async () => {
      const { connect, coordination } = await setup();
      const observer = await joined(connect, { sub: 'u2', device_id: 'd2' });
      const older = connect({ reportsClose: false });
      await older.authenticate({ namespaces: ['notes:a'] });
      await older.request('namespace.join', { namespace: 'notes:a' });
      const newer = connect();
      await newer.authenticate({ namespaces: ['notes:a'] });
      await newer.request('namespace.join', { namespace: 'notes:a' });
      expect(older.closes).toEqual([4003]);
      await older.connection.closed();
      expect(observer.presence()).toEqual([event('u1', 'd1', true), event('u1', 'd1', true)]);
      expect(await coordination.listPresence('notes:a')).toEqual([
        device('u2', 'd2'),
        device('u1', 'd1'),
      ]);
    });

    it('renews nothing on a heartbeat before authentication', async () => {
      const { connect, coordination } = await setup();
      await connect().connection.heartbeat();
      expect(coordination.heldSlotKeys).toBe(0);
    });

    it('renews the leases on every heartbeat', async () => {
      const { connect, coordination } = await setup();
      const alice = await joined(connect, d1, ['notes:a', 'notes:b']);
      await vi.advanceTimersByTimeAsync(LEASE_MS - 1_000);
      await alice.connection.heartbeat();
      await vi.advanceTimersByTimeAsync(LEASE_MS - 1_000);
      expect(await coordination.listPresence('notes:a')).toEqual([device('u1', 'd1')]);
      expect(await coordination.listPresence('notes:b')).toEqual([device('u1', 'd1')]);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await coordination.listPresence('notes:a')).toEqual([]);
    });

    describe('auth.refresh', () => {
      it('leaves the namespaces the new token drops, and only those', async () => {
        const { connect, coordination } = await setup();
        const observer = await joined(connect, { sub: 'u2', device_id: 'd2' }, [
          'notes:a',
          'notes:b',
        ]);
        const alice = await joined(connect, d1, ['notes:a', 'notes:b']);
        await alice.refresh({ namespaces: ['notes:b', 'notes:c'] });
        expect(alice.sent.slice(-2).map((message) => message.type)).toEqual([
          'auth.result',
          'rtc.ice_config',
        ]);
        expect(observer.presence()).toEqual([
          event('u1', 'd1', true, 'notes:a'),
          event('u1', 'd1', true, 'notes:b'),
          event('u1', 'd1', false, 'notes:a'),
        ]);
        expect(await coordination.listPresence('notes:a')).toEqual([device('u2', 'd2')]);
        expect(await coordination.listPresence('notes:c')).toEqual([]);
        await alice.request('discovery.request', { namespace: 'notes:a' });
        expect(alice.errors()).toEqual(['not_authorized']);
      });

      it('keeps the namespaces on a rejected refresh', async () => {
        const { connect, coordination } = await setup();
        const alice = await joined(connect, d1);
        await alice.refresh({ namespaces: [], aud: 'other' });
        expect(alice.errors()).toEqual(['invalid_token']);
        expect(await coordination.listPresence('notes:a')).toEqual([device('u1', 'd1')]);
      });
    });
  });

  describe('sessions', () => {
    const bobClaims = { sub: 'u2', device_id: 'd2' };
    const bobDevice = { namespace: 'notes:a', userId: 'u2', deviceId: 'd2' };
    // Events cross to another connection's queue; let it drain.
    const settle = () => vi.advanceTimersByTimeAsync(0);

    async function member(connect: Connect, claims: object, namespaces = ['notes:a']) {
      const client = connect();
      await client.authenticate({ ...claims, namespaces });
      for (const namespace of namespaces) await client.request('namespace.join', { namespace });
      return client;
    }

    async function pair(entries?: object[]) {
      const context = await setup(entries);
      const alice = await member(context.connect, d1);
      const bob = await member(context.connect, bobClaims);
      return { ...context, alice, bob };
    }

    type Client = ReturnType<Connect>;

    async function create(alice: Client) {
      await alice.request('session.create', bobDevice);
      await settle();
      const created = alice.last();
      if (created?.type !== 'session.created') throw new Error(`no session: ${created?.type}`);
      return created.payload.sessionId;
    }

    async function active(entries?: object[]) {
      const context = await pair(entries);
      const sessionId = await create(context.alice);
      await context.bob.request('session.accept', { sessionId });
      await settle();
      return { ...context, sessionId };
    }

    const terminated = (sessionId: string, reason: string) => ({
      version: 1,
      type: 'session.terminated',
      payload: { sessionId, reason },
    });
    // A disconnect also announces presence; keep only the session events.
    const sessionEvents = (client: Client) =>
      client.sent.filter((message) => message.type === 'session.terminated');

    it('creates a pending session and asks the target', async () => {
      const { alice, bob } = await pair();
      const sessionId = await create(alice);
      expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(alice.last()).toEqual({
        version: 1,
        type: 'session.created',
        requestId: 'r3',
        payload: { sessionId },
      });
      expect(bob.last()).toEqual({
        version: 1,
        type: 'session.request',
        payload: { sessionId, namespace: 'notes:a', userId: 'u1', deviceId: 'd1' },
      });
    });

    it('allows concurrent sessions between the same devices', async () => {
      const { alice } = await pair();
      expect(await create(alice)).not.toBe(await create(alice));
    });

    describe('session permissions (ADR 0040)', () => {
      const oneSession = [{ ...devApplication('notes'), quotas: { sessionsPerDevice: 1 } }];
      const requests = (client: Client) =>
        client.sent.filter((message) => message.type === 'session.request');

      async function members(alicePermissions?: object, bobPermissions?: object) {
        const context = await setup(oneSession);
        const alice = await member(context.connect, { ...d1, permissions: alicePermissions });
        const bob = await member(context.connect, { ...bobClaims, permissions: bobPermissions });
        return { ...context, alice, bob };
      }

      it('opens a session when both hold the listed permission', async () => {
        const { alice, bob } = await members(
          { 'notes:a': ['session.create'] },
          { 'notes:a': ['session.accept'] },
        );
        const sessionId = await create(alice);
        await bob.request('session.accept', { sessionId });
        await settle();
        expect(alice.last()).toEqual({
          version: 1,
          type: 'session.accepted',
          payload: { sessionId },
        });
      });

      it('refuses session.create without the permission, asking no one', async () => {
        const { alice, bob } = await members({ 'notes:a': ['session.accept'] });
        await alice.request('session.create', bobDevice);
        await settle();
        expect(alice.errors()).toEqual(['not_authorized']);
        expect(requests(bob)).toEqual([]);
      });

      it('refuses session.create when the namespace lists no permission', async () => {
        const { alice } = await members({ 'notes:a': [] });
        await alice.request('session.create', bobDevice);
        expect(alice.errors()).toEqual(['not_authorized']);
      });

      it('applies a namespace list to that namespace only', async () => {
        const context = await setup(oneSession);
        const alice = await member(context.connect, { ...d1, permissions: { 'notes:b': [] } }, [
          'notes:a',
          'notes:b',
        ]);
        await member(context.connect, bobClaims);
        await create(alice);
        expect(alice.errors()).toEqual([]);
      });

      it('rejects for a target without session.accept, which never sees the request', async () => {
        const { alice, bob } = await members(undefined, { 'notes:a': ['session.create'] });
        await alice.request('session.create', bobDevice);
        await settle();
        const [created, rejected] = alice.sent.slice(-2);
        if (created?.type !== 'session.created') throw new Error(`no session: ${created?.type}`);
        const { sessionId } = created.payload;
        expect(rejected).toEqual({ version: 1, type: 'session.rejected', payload: { sessionId } });
        expect(requests(bob)).toEqual([]);
        // The rejection released the slots: the one-session quota allows another.
        await alice.request('session.create', bobDevice);
        await settle();
        expect(alice.errors()).toEqual([]);
        expect(alice.sent.filter((message) => message.type === 'session.created')).toHaveLength(2);
      });

      it('refuses session.accept once a refresh withdrew the permission', async () => {
        const { alice, bob } = await members();
        const sessionId = await create(alice);
        await bob.refresh({
          ...bobClaims,
          namespaces: ['notes:a'],
          permissions: { 'notes:a': ['session.create'] },
        });
        await bob.request('session.accept', { sessionId });
        await settle();
        expect(bob.errors()).toEqual(['not_authorized']);
        expect(alice.sent.some((message) => message.type === 'session.accepted')).toBe(false);
      });
    });

    describe('session quotas', () => {
      const quotas = (q: object) => [{ ...devApplication('notes'), quotas: q }];
      const carolClaims = { sub: 'u3', device_id: 'd3' };
      const to = (userId: string, deviceId: string) => ({ namespace: 'notes:a', userId, deviceId });

      it("refuses the requester's device beyond its quota, until a session ends", async () => {
        const { alice, bob } = await pair(quotas({ sessionsPerDevice: 1 }));
        const sessionId = await create(alice);
        await alice.request('session.create', bobDevice);
        expect(alice.errors()).toEqual(['quota_exceeded']);
        expect(alice.closes).toEqual([]);
        expect(bob.sent.filter((m) => m.type === 'session.request')).toHaveLength(1);
        await alice.request('session.close', { sessionId });
        await create(alice);
      });

      it("answers peer_unavailable when the target's device is full, freeing the requester's slots", async () => {
        const { connect, alice } = await pair(quotas({ sessionsPerDevice: 1, sessions: 2 }));
        const carol = await member(connect, carolClaims);
        await member(connect, { sub: 'u4', device_id: 'd4' });
        await carol.request('session.create', bobDevice);
        await alice.request('session.create', bobDevice);
        expect(alice.errors()).toEqual(['peer_unavailable']);
        await alice.request('session.create', to('u4', 'd4'));
        expect(alice.last()?.type).toBe('session.created');
      });

      it("refuses beyond the application's quota, and frees a slot on reject and timeout", async () => {
        const { connect, alice, bob } = await pair(quotas({ sessions: 1 }));
        await member(connect, carolClaims);
        const first = await create(alice);
        await alice.request('session.create', to('u3', 'd3'));
        expect(alice.errors()).toEqual(['quota_exceeded']);
        await bob.request('session.reject', { sessionId: first });
        await settle();
        await create(alice);
        await vi.advanceTimersByTimeAsync(NEGOTIATION_MS);
        await create(alice);
      });

      it("renews a session's slots on every heartbeat, and frees them once heartbeats stop", async () => {
        const { connect, alice } = await active(quotas({ sessions: 1 }));
        const carol = await member(connect, carolClaims);
        await vi.advanceTimersByTimeAsync(LEASE_MS - 1_000);
        await alice.connection.heartbeat();
        await vi.advanceTimersByTimeAsync(LEASE_MS - 1_000);
        await member(connect, { sub: 'u4', device_id: 'd4' });
        await carol.request('session.create', to('u4', 'd4'));
        expect(carol.errors()).toEqual(['quota_exceeded']);
        await vi.advanceTimersByTimeAsync(2_000);
        await carol.request('session.create', to('u4', 'd4'));
        expect(carol.last()?.type).toBe('session.created');
      });

      it('frees the slots of a session a heartbeat ends for a lost peer (ADR 0026)', async () => {
        const { connect, alice, coordination } = await active(quotas({ sessions: 1 }));
        const carol = await member(connect, carolClaims);
        await coordination.claimDeviceConnection(
          { appId: 'notes', userId: 'u2', deviceId: 'd2' },
          'elsewhere',
        );
        await alice.connection.heartbeat();
        await carol.request('session.create', to('u1', 'd1'));
        expect(carol.last()?.type).toBe('session.created');
      });

      it('frees the slots of the sessions of a connection that closes', async () => {
        const { connect, alice, bob } = await pair(quotas({ sessions: 1 }));
        const carol = await member(connect, carolClaims);
        await create(alice);
        await bob.connection.closed();
        await settle();
        await carol.request('session.create', to('u1', 'd1'));
        expect(carol.last()?.type).toBe('session.created');
      });
    });

    it('limits session.create per connection, refused ones too', async () => {
      const { connect, alice, bob } = await pair(limited({ session_create: ONE_PER_SECOND }));
      await alice.request('session.create', { ...bobDevice, namespace: 'notes:b' });
      await alice.request('session.create', bobDevice);
      await settle();
      expect(alice.last()).toEqual(rateLimited('r4'));
      expect(alice.closes).toEqual([]);
      expect(bob.sent.filter((m) => m.type === 'session.request')).toEqual([]);
      const carol = await member(connect, { sub: 'u3', device_id: 'd3' });
      await carol.request('session.create', bobDevice);
      expect(carol.last()?.type).toBe('session.created');
      vi.advanceTimersByTime(1000);
      await create(alice);
    });

    it('refuses a namespace outside the token with not_authorized', async () => {
      const { alice, bob } = await pair();
      await alice.request('session.create', { ...bobDevice, namespace: 'notes:b' });
      await settle();
      expect(alice.errors()).toEqual(['not_authorized']);
      expect(bob.sent.at(-1)?.type).toBe('ack');
    });

    describe('answers peer_unavailable for any unreachable target', () => {
      it.each([
        ['an unknown device', { userId: 'u9', deviceId: 'd9' }],
        ['the requester itself', { userId: 'u1', deviceId: 'd1' }],
        ['a device of another user with the same deviceId', { userId: 'u3', deviceId: 'd2' }],
      ])('%s', async (_, target) => {
        const { alice } = await pair();
        await alice.request('session.create', { ...bobDevice, ...target });
        expect(alice.errors()).toEqual(['peer_unavailable']);
        expect(alice.closes).toEqual([]);
        // Only the two token expiries: no session was armed.
        expect(vi.getTimerCount()).toBe(2);
      });

      it('a connected device that has not joined the namespace', async () => {
        const { connect } = await setup();
        const alice = await member(connect, d1);
        const bob = connect();
        await bob.authenticate({ ...bobClaims, namespaces: ['notes:a'] });
        await alice.request('session.create', bobDevice);
        await settle();
        expect(alice.errors()).toEqual(['peer_unavailable']);
        expect(bob.sent.map((message) => message.type)).toEqual(['auth.result', 'rtc.ice_config']);
      });

      it('a device present in the namespace with no connection here', async () => {
        const { connect, coordination } = await setup();
        const alice = await member(connect, d1);
        const ghost = { appId: 'notes', userId: 'u2', deviceId: 'd2' };
        await coordination.acquirePresence('notes:a', ghost, 'elsewhere', LEASE_MS);
        await alice.request('session.create', bobDevice);
        expect(alice.errors()).toEqual(['peer_unavailable']);
      });

      it('a device whose connection closed while its lease lives on', async () => {
        const { alice, bob, coordination } = await pair();
        // Another connection took the lease, so Bob's close leaves it in place.
        const device = { appId: 'notes', userId: 'u2', deviceId: 'd2' };
        await coordination.acquirePresence('notes:a', device, 'elsewhere', LEASE_MS);
        await bob.connection.closed();
        await alice.request('session.create', bobDevice);
        expect(alice.errors()).toEqual(['peer_unavailable']);
      });

      it('a device that disconnected', async () => {
        const { alice, bob } = await pair();
        await bob.connection.closed();
        await alice.request('session.create', bobDevice);
        expect(alice.errors()).toEqual(['peer_unavailable']);
      });
    });

    it('accepts: acks the target, tells the requester, and disarms the timeout', async () => {
      const { alice, bob, sessionId } = await active();
      expect(bob.last()).toEqual({ version: 1, type: 'ack', requestId: 'r3', payload: {} });
      expect(alice.last()).toEqual({
        version: 1,
        type: 'session.accepted',
        payload: { sessionId },
      });
      await vi.advanceTimersByTimeAsync(NEGOTIATION_MS);
      expect(alice.last()?.type).toBe('session.accepted');
      expect(bob.last()?.type).toBe('ack');
    });

    it('rejects: acks the target, tells the requester, and ends the session', async () => {
      const { alice, bob } = await pair();
      const sessionId = await create(alice);
      await bob.request('session.reject', { sessionId });
      await settle();
      expect(bob.last()).toEqual({ version: 1, type: 'ack', requestId: 'r3', payload: {} });
      expect(alice.last()).toEqual({
        version: 1,
        type: 'session.rejected',
        payload: { sessionId },
      });
      await bob.request('session.accept', { sessionId });
      expect(bob.errors()).toEqual(['session_unavailable']);
      expect(vi.getTimerCount()).toBe(2);
    });

    it.each([
      ['the requester accepts', 'alice', 'session.accept'],
      ['the requester rejects', 'alice', 'session.reject'],
    ] as const)('refuses with session_unavailable when %s', async (_, who, type) => {
      const context = await pair();
      const sessionId = await create(context.alice);
      await context[who].request(type, { sessionId });
      expect(context[who].errors()).toEqual(['session_unavailable']);
      expect(context[who].closes).toEqual([]);
    });

    it.each(['session.accept', 'session.reject'])(
      'refuses %s of an active session with session_unavailable',
      async (type) => {
        const { bob, sessionId } = await active();
        await bob.request(type, { sessionId });
        expect(bob.errors()).toEqual(['session_unavailable']);
      },
    );

    it.each(['session.accept', 'session.reject', 'session.close'])(
      'refuses %s from a device outside the session, or of an unknown one',
      async (type) => {
        const { connect, sessionId } = await active();
        const carol = await member(connect, { sub: 'u3', device_id: 'd3' });
        await carol.request(type, { sessionId });
        await carol.request(type, { sessionId: crypto.randomUUID() });
        expect(carol.errors()).toEqual(['session_unavailable', 'session_unavailable']);
      },
    );

    it.each(['alice', 'bob'] as const)(
      'closes on session.close from %s: acks and tells the other side',
      async (who) => {
        const context = await active();
        const other = who === 'alice' ? context.bob : context.alice;
        await context[who].request('session.close', { sessionId: context.sessionId });
        await settle();
        expect(context[who].last()).toMatchObject({ type: 'ack' });
        expect(other.last()).toEqual(terminated(context.sessionId, 'closed_by_peer'));
        await other.request('session.close', { sessionId: context.sessionId });
        expect(other.errors()).toEqual(['session_unavailable']);
      },
    );

    it('lets the requester close a pending session', async () => {
      const { alice, bob } = await pair();
      const sessionId = await create(alice);
      await alice.request('session.close', { sessionId });
      await settle();
      expect(bob.last()).toEqual(terminated(sessionId, 'closed_by_peer'));
      expect(vi.getTimerCount()).toBe(2);
    });

    it('ends a pending session at the negotiation timeout, for both sides', async () => {
      const { alice, bob } = await pair();
      const sessionId = await create(alice);
      await vi.advanceTimersByTimeAsync(NEGOTIATION_MS - 1);
      expect(alice.last()?.type).toBe('session.created');
      await vi.advanceTimersByTimeAsync(1);
      expect(alice.last()).toEqual(terminated(sessionId, 'timeout'));
      expect(bob.last()).toEqual(terminated(sessionId, 'timeout'));
      await bob.request('session.accept', { sessionId });
      expect(bob.errors()).toEqual(['session_unavailable']);
    });

    it('ends an active session at the maximum duration, for both sides', async () => {
      const quotas = { sessionDurationSeconds: 60 };
      const { alice, bob, sessionId } = await active([{ ...devApplication('notes'), quotas }]);
      await vi.advanceTimersByTimeAsync(59_999);
      expect(alice.last()?.type).toBe('session.accepted');
      await vi.advanceTimersByTimeAsync(1);
      expect(alice.last()).toEqual(terminated(sessionId, 'timeout'));
      expect(bob.last()).toEqual(terminated(sessionId, 'timeout'));
      await alice.request('rtc.offer', { sessionId, sdp: 'v=0' });
      expect(alice.errors()).toEqual(['session_unavailable']);
    });

    it('keeps an active session with no maximum duration', async () => {
      const { alice, sessionId } = await active();
      await vi.advanceTimersByTimeAsync(NEGOTIATION_MS * 10);
      await alice.request('rtc.offer', { sessionId, sdp: 'v=0' });
      expect(alice.errors()).toEqual([]);
    });

    describe('copies on each side (ADR 0023)', () => {
      const alicePeer = (connectionId: string) => ({
        connectionId,
        device: { appId: 'notes', userId: 'u1', deviceId: 'd1' },
      });
      const [s1, s2] = [crypto.randomUUID(), crypto.randomUUID()];
      /** A request from a requester whose instance never speaks again. */
      const request = (target: string, id = s1) => ({
        type: 'session.request',
        session: {
          id,
          namespace: 'notes:a',
          requester: alicePeer('gone'),
          target: {
            connectionId: target,
            device: { appId: 'notes', userId: 'u2', deviceId: 'd2' },
          },
        },
      });

      it("times out the target's copy when the requester never answers", async () => {
        const { connect, coordination } = await setup();
        const bob = await member(connect, bobClaims);
        await coordination.publish(connectionTopic(bob.connection.id), request(bob.connection.id));
        await settle();
        expect(bob.last()).toEqual({
          version: 1,
          type: 'session.request',
          payload: { sessionId: s1, namespace: 'notes:a', userId: 'u1', deviceId: 'd1' },
        });
        await bob.request('session.accept', { sessionId: s1 });
        await bob.request('session.close', { sessionId: s1 });
        expect(bob.errors()).toEqual([]);
        await coordination.publish(
          connectionTopic(bob.connection.id),
          request(bob.connection.id, s2),
        );
        await settle();
        await vi.advanceTimersByTimeAsync(NEGOTIATION_MS);
        expect(sessionEvents(bob)).toEqual([terminated(s2, 'timeout')]);
      });

      it("ends the requester's copy at the maximum duration when the target's instance is gone", async () => {
        const quotas = { sessionDurationSeconds: 60 };
        const { alice, sessionId, coordination } = await active([
          { ...devApplication('notes'), quotas },
        ]);
        // Nothing reaches alice's connection from now on, as when bob's instance stops.
        const publish = coordination.publish.bind(coordination);
        vi.spyOn(coordination, 'publish').mockImplementation((topic, event) =>
          topic === connectionTopic(alice.connection.id)
            ? Promise.resolve()
            : publish(topic, event),
        );
        await vi.advanceTimersByTimeAsync(60_000);
        expect(alice.last()).toEqual(terminated(sessionId, 'timeout'));
      });

      it('answers a late or repeated event of the peer only once', async () => {
        const { alice, bob, sessionId, coordination } = await active();
        const topic = connectionTopic(alice.connection.id);
        await coordination.publish(topic, { type: 'session.accepted', sessionId });
        await settle();
        expect(alice.sent.filter((m) => m.type === 'session.accepted')).toHaveLength(1);
        await bob.request('session.close', { sessionId });
        await settle();
        await coordination.publish(topic, {
          type: 'session.terminated',
          sessionId,
          reason: 'timeout',
        });
        await coordination.publish(topic, { type: 'session.rejected', sessionId });
        await settle();
        expect(sessionEvents(alice)).toEqual([terminated(sessionId, 'closed_by_peer')]);
        expect(alice.sent.filter((m) => m.type === 'session.rejected')).toEqual([]);
      });
    });

    it('ends each copy once when the timeout races an answer (ADR 0023)', async () => {
      const { alice, bob } = await pair();
      const sessionId = await create(alice);
      vi.advanceTimersByTime(NEGOTIATION_MS - 1);
      // The reject waits on its rate limit: alice's copy times out meanwhile, and bob's copy ends
      // with the reject; each side drops the other's late event.
      const reject = bob.request('session.reject', { sessionId });
      vi.advanceTimersByTime(1);
      await reject;
      await settle();
      const types = (client: Client) =>
        client.sent.map((message) => message.type).filter((type) => type.startsWith('session.'));
      expect(types(alice)).toEqual(['session.created', 'session.terminated']);
      expect(types(bob)).toEqual(['session.request']);
      expect(bob.errors()).toEqual([]);
      expect(bob.last()?.type).toBe('ack');
    });

    it.each(['alice', 'bob'] as const)(
      'ends the session with peer_disconnected when %s disconnects',
      async (who) => {
        const context = await active();
        const other = who === 'alice' ? context.bob : context.alice;
        await context[who].connection.closed();
        await settle();
        expect(sessionEvents(other)).toEqual([terminated(context.sessionId, 'peer_disconnected')]);
        expect(other.closes).toEqual([]);
      },
    );

    it('ends a pending session when the requester disconnects, without a timeout', async () => {
      const { alice, bob } = await pair();
      const sessionId = await create(alice);
      await alice.connection.closed();
      await settle();
      await vi.advanceTimersByTimeAsync(NEGOTIATION_MS);
      expect(sessionEvents(bob)).toEqual([terminated(sessionId, 'peer_disconnected')]);
    });

    it('ends the sessions of a superseded connection with peer_disconnected', async () => {
      const { connect, bob, sessionId } = await active();
      await connect().authenticate({ namespaces: ['notes:a'] });
      await settle();
      expect(sessionEvents(bob)).toEqual([terminated(sessionId, 'peer_disconnected')]);
    });

    it.each(['alice', 'bob'] as const)(
      "ends %s's session on a heartbeat once the peer's claim is gone or taken (ADR 0026)",
      async (who) => {
        const context = await active();
        const [self, peer] =
          who === 'alice' ? (['alice', 'bob'] as const) : (['bob', 'alice'] as const);
        const claims = peer === 'alice' ? d1 : bobClaims;
        await context[self].connection.heartbeat();
        expect(sessionEvents(context[self])).toEqual([]);

        // Stands for the peer's instance failing, and the device reconnecting on another one.
        const device = { appId: 'notes', userId: claims.sub, deviceId: claims.device_id };
        await context.coordination.claimDeviceConnection(device, 'elsewhere');
        await context[self].connection.heartbeat();
        expect(sessionEvents(context[self])).toEqual([
          terminated(context.sessionId, 'peer_disconnected'),
        ]);
        expect(context[self].closes).toEqual([]);
      },
    );

    it("ends a session on a heartbeat once the peer's claim is released", async () => {
      const { alice, bob, coordination, sessionId } = await active();
      await coordination.releaseDeviceConnection(
        { appId: 'notes', userId: 'u2', deviceId: bobClaims.device_id },
        bob.connection.id,
      );
      await alice.connection.heartbeat();
      expect(sessionEvents(alice)).toEqual([terminated(sessionId, 'peer_disconnected')]);
    });

    it.each(['alice', 'bob'] as const)(
      "ends the sessions in a namespace %s's refresh removes, for both sides",
      async (who) => {
        const context = await active();
        const other = who === 'alice' ? context.bob : context.alice;
        const claims = who === 'alice' ? d1 : bobClaims;
        await context[who].refresh({ ...claims, namespaces: ['notes:b'] });
        await settle();
        const reason = terminated(context.sessionId, 'namespace_unauthorized');
        expect(context[who].sent.slice(-3)).toEqual([
          expect.objectContaining({ type: 'auth.result' }),
          expect.objectContaining({ type: 'rtc.ice_config' }),
          reason,
        ]);
        expect(other.sent).toContainEqual(reason);
      },
    );

    it('keeps the sessions in a namespace the refresh keeps', async () => {
      const { alice, bob, sessionId } = await active();
      await alice.refresh({ namespaces: ['notes:a'] });
      await alice.request('rtc.offer', { sessionId, sdp: 'v=0' });
      await settle();
      expect(bob.last()).toMatchObject({ type: 'rtc.offer' });
    });

    describe('rtc relay', () => {
      it.each([
        ['rtc.offer', 'alice', 'bob', { sdp: 'v=0 offer' }],
        ['rtc.answer', 'bob', 'alice', { sdp: 'v=0 answer' }],
        [
          'rtc.ice_candidate',
          'alice',
          'bob',
          { candidate: 'candidate:1 1 udp 1 10.0.0.1 9 typ host' },
        ],
        ['rtc.ice_candidate', 'bob', 'alice', { candidate: 'candidate:2' }],
      ] as const)('rebuilds %s from %s for %s, with no reply', async (type, from, to, fields) => {
        const context = await active();
        const before = context[from].sent.length;
        await context[from].request(type, { sessionId: context.sessionId, ...fields, from: 'x' });
        await settle();
        expect(context[to].last()).toEqual({
          version: 1,
          type,
          payload: { sessionId: context.sessionId, ...fields },
        });
        expect(context[from].sent).toHaveLength(before);
      });

      it('limits rtc.* per session, with rtc.ice_candidate in its own bucket', async () => {
        const policies = { rtc: ONE_PER_SECOND, rtc_ice_candidate: ONE_PER_SECOND };
        const { alice, bob, sessionId } = await active(limited(policies));
        await alice.request('rtc.offer', { sessionId, sdp: 'v=0' });
        await bob.request('rtc.answer', { sessionId, sdp: 'v=0' });
        expect(bob.last()).toEqual(rateLimited('r4'));
        await bob.request('rtc.ice_candidate', { sessionId, candidate: 'c' });
        await alice.request('rtc.ice_candidate', { sessionId, candidate: 'c' });
        await settle();
        expect(alice.last()).toEqual(rateLimited('r5'));
        expect([alice.closes, bob.closes]).toEqual([[], []]);
        const relayed = (client: Client) => client.sent.filter((m) => m.type.startsWith('rtc.'));
        expect(relayed(bob).map((m) => m.type)).toEqual(['rtc.ice_config', 'rtc.offer']);
        expect(relayed(alice).map((m) => m.type)).toEqual(['rtc.ice_config', 'rtc.ice_candidate']);
        vi.advanceTimersByTime(1000);
        await bob.request('rtc.answer', { sessionId, sdp: 'v=0' });
        await settle();
        expect(alice.last()?.type).toBe('rtc.answer');
      });

      it('refuses a pending session with session_unavailable', async () => {
        const { alice, bob } = await pair();
        const sessionId = await create(alice);
        await alice.request('rtc.offer', { sessionId, sdp: 'v=0' });
        await settle();
        expect(alice.last()).toEqual({
          version: 1,
          type: 'error',
          requestId: 'r4',
          payload: { code: 'session_unavailable' },
        });
        expect(bob.last()?.type).toBe('session.request');
      });

      it('refuses a device outside the session, an unknown session, and an ended one', async () => {
        const { connect, alice, bob, sessionId } = await active();
        const carol = await member(connect, { sub: 'u3', device_id: 'd3' });
        await carol.request('rtc.offer', { sessionId, sdp: 'v=0' });
        await alice.request('rtc.offer', { sessionId: crypto.randomUUID(), sdp: 'v=0' });
        await alice.request('session.close', { sessionId });
        await alice.request('rtc.ice_candidate', { sessionId, candidate: 'c' });
        await settle();
        expect(carol.errors()).toEqual(['session_unavailable']);
        expect(alice.errors()).toEqual(['session_unavailable', 'session_unavailable']);
        expect(bob.sent.filter((message) => message.type.startsWith('rtc.'))).toHaveLength(1);
      });
    });

    describe('namespace authorization (ADR 0007)', () => {
      it('answers an unauthorized namespace like a nonexistent one, so none can be enumerated', async () => {
        const { connect } = await setup();
        const bob = await member(connect, bobClaims, ['notes:b']);
        const alice = await member(connect, d1);
        for (const namespace of ['notes:b', 'notes:none']) {
          await alice.request('namespace.join', { namespace });
          await alice.request('discovery.request', { namespace });
          await alice.request('session.create', { ...bobDevice, namespace });
        }
        await settle();
        expect(alice.sent.slice(-6).map(({ type, payload }) => ({ type, payload }))).toEqual(
          Array(6).fill({ type: 'error', payload: { code: 'not_authorized' } }),
        );
        expect(alice.closes).toEqual([]);
        expect(bob.sent.filter((m) => m.type === 'session.request')).toEqual([]);
        await bob.request('namespace.leave', { namespace: 'notes:b' });
        await member(connect, { sub: 'u3', device_id: 'd3' }, ['notes:b']);
        await settle();
        expect(alice.presence()).toEqual([]);
      });

      it('matches namespace IDs exactly, with no prefix or pattern', async () => {
        const { connect } = await setup();
        const client = connect();
        await client.authenticate({ namespaces: ['notes:a', 'notes:*'] });
        for (const namespace of ['notes:ab', 'notes:A', 'notes:a/b', 'notes:b']) {
          await client.request('namespace.join', { namespace });
        }
        expect(client.errors()).toEqual(Array(4).fill('not_authorized'));
        await client.request('namespace.join', { namespace: 'notes:*' });
        expect(client.last()?.type).toBe('ack');
      });

      it('refuses a session with a device no longer authorized in the namespace', async () => {
        const { alice, bob } = await pair();
        await bob.refresh({ ...bobClaims, namespaces: ['notes:b'] });
        await alice.request('session.create', bobDevice);
        await settle();
        expect(alice.errors()).toEqual(['peer_unavailable']);
        expect(bob.sent.filter((m) => m.type === 'session.request')).toEqual([]);
      });

      it('refuses every namespace request the refresh no longer authorizes', async () => {
        const { alice, bob } = await pair();
        await alice.refresh({ namespaces: ['notes:b'] });
        await alice.request('namespace.join', { namespace: 'notes:a' });
        await alice.request('discovery.request', { namespace: 'notes:a' });
        await alice.request('session.create', bobDevice);
        await settle();
        expect(alice.errors()).toEqual(Array(3).fill('not_authorized'));
        expect(bob.sent.filter((m) => m.type === 'session.request')).toEqual([]);
      });

      it('shares no device, namespace, or session across applications for the same sub', async () => {
        const { connect, coordination } = await setup([
          devApplication('notes'),
          devApplication('chat'),
        ]);
        const alice = await member(connect, d1);
        const bob = await member(connect, bobClaims);
        // The same sub and device_id in another application is another device (spec §6.1).
        const twin = await member(connect, { ...d1, app_id: 'chat' }, ['chat:a']);
        await twin.request('namespace.join', { namespace: 'notes:a' });
        await twin.request('discovery.request', { namespace: 'notes:a' });
        await twin.request('session.create', bobDevice);
        await twin.request('session.create', { ...bobDevice, namespace: 'chat:a' });
        await settle();
        expect(twin.errors()).toEqual([
          'not_authorized',
          'not_authorized',
          'not_authorized',
          'peer_unavailable',
        ]);
        expect([alice.closes, bob.closes, twin.closes]).toEqual([[], [], []]);
        expect(alice.presence()).toEqual([
          { namespace: 'notes:a', userId: 'u2', deviceId: 'd2', present: true },
        ]);
        expect(bob.sent.filter((m) => m.type === 'session.request')).toEqual([]);
        expect(await coordination.listPresence('chat:a')).toEqual([
          { appId: 'chat', userId: 'u1', deviceId: 'd1' },
        ]);
      });
    });

    it('counts created and terminated sessions once, on the requester side', async () => {
      const { alice, bob, sessionId, metrics } = await active();
      expect(alice.connection.requestedSessions.map(({ id }) => id)).toEqual([sessionId]);
      expect(bob.connection.requestedSessions).toEqual([]);
      await bob.request('session.close', { sessionId });
      await settle();
      expect(alice.connection.requestedSessions).toEqual([]);
      const text = await metrics.render();
      expect(text).toContain('blindsignal_sessions_created_total 1\n');
      expect(text).toContain('blindsignal_application_sessions_created_total{app_id="notes"} 1\n');
      expect(text).toContain('blindsignal_sessions_terminated_total{reason="closed_by_peer"} 1\n');
      expect(text).toContain('blindsignal_session_acceptance_seconds_count 1\n');
    });

    describe('registry reload (ADR 0005)', () => {
      const notes = devApplication('notes');
      // Like the server: every connection's check is queued before any of them closes.
      const enforce = (apps: readonly ApplicationRecord[], ...clients: Client[]) =>
        Promise.all(clients.map((client) => client.connection.enforce(apps)));

      it('closes a revoked device with device_revoked and tells its peers peer_revoked', async () => {
        const { alice, bob, sessionId, load } = await active();
        const apps = await load([{ ...notes, revokedDevices: [{ userId: 'u1', deviceId: 'd1' }] }]);
        await enforce(apps, alice, bob);
        await settle();
        expect(alice.last()).toEqual({
          version: 1,
          type: 'error',
          payload: { code: 'device_revoked' },
        });
        expect(alice.closes).toEqual([4002]);
        expect(sessionEvents(bob)).toEqual([terminated(sessionId, 'peer_revoked')]);
        expect(bob.closes).toEqual([]);
      });

      it.each([
        ['suspended', [{ ...notes, status: 'suspended' }]],
        ['revoked', [{ ...notes, status: 'revoked' }]],
        ['removed', []],
      ])(
        'closes every connection of a %s application, with no session.terminated',
        async (_, entries) => {
          const { alice, bob, load } = await active();
          await enforce(await load(entries), alice, bob);
          await settle();
          for (const client of [alice, bob]) {
            expect(client.errors()).toEqual(['application_unavailable']);
            expect(client.closes).toEqual([4002]);
            expect(sessionEvents(client)).toEqual([]);
          }
        },
      );

      it('leaves other devices, other applications, and unauthenticated connections open', async () => {
        const { connect, load } = await setup([notes, devApplication('chat')]);
        const alice = await member(connect, d1);
        const bob = await member(connect, bobClaims);
        const carol = connect();
        await carol.authenticate({ app_id: 'chat', namespaces: ['chat:a'] });
        const anonymous = connect();
        const apps = await load([
          { ...notes, revokedDevices: [{ userId: 'u1', deviceId: 'd9' }] },
          devApplication('chat'),
        ]);
        await enforce(apps, alice, bob, carol, anonymous);
        for (const client of [alice, bob, carol, anonymous]) {
          expect(client.errors()).toEqual([]);
          expect(client.closes).toEqual([]);
        }
      });

      it('checks an authentication still in flight', async () => {
        const { connect } = await setup();
        const alice = connect();
        const token = await mintDevToken(d1, { now: new Date() });
        // The repository still holds the active application, so the token verifies.
        const auth = alice.request('auth.authenticate', { token });
        const suspended = parseRegistry(
          JSON.stringify({ applications: [{ ...notes, status: 'suspended' }] }),
          { now: START, development: true },
        );
        if (!suspended.ok) throw new Error(suspended.error);
        await Promise.all([auth, enforce(suspended.registry.applications, alice)]);
        expect(alice.errors()).toEqual(['application_unavailable']);
        expect(alice.closes).toEqual([4002]);
      });
    });
  });

  describe('telemetry', () => {
    it('counts messages, authentications, and errors', async () => {
      const { connect, metrics } = await setup();
      const alice = connect();
      await alice.authenticate();
      await alice.request('namespace.join', { namespace: 'notes:other' });
      await connect().request('auth.authenticate', { token: 'not-a-jwt' });
      const text = await metrics.render();
      for (const line of [
        'blindsignal_messages_total{type="auth.authenticate"} 2',
        'blindsignal_messages_total{type="namespace.join"} 1',
        'blindsignal_authentications_total{result="ok"} 1',
        'blindsignal_authentications_total{result="invalid_token"} 1',
        'blindsignal_authentication_duration_seconds_count{result="ok"} 1',
        'blindsignal_authentication_duration_seconds_count{result="invalid_token"} 1',
        'blindsignal_errors_total{code="invalid_token"} 1',
        'blindsignal_errors_total{code="not_authorized"} 1',
        // The authenticating message comes before the context; the bad token names no application.
        'blindsignal_application_messages_total{app_id="notes"} 1',
        'blindsignal_application_errors_total{app_id="notes",code="not_authorized"} 1',
      ]) {
        expect(text).toContain(`${line}\n`);
      }
      expect(text).not.toMatch(/application_errors_total\{[^}]*invalid_token/);
    });

    it('counts an authentication refused by the device quota', async () => {
      const { connect, metrics } = await setup(undefined, {
        limits: limits(1),
      });
      await connect().authenticate();
      await connect().authenticate({ sub: 'u2', device_id: 'd2' });
      const text = await metrics.render();
      expect(text).toContain('blindsignal_authentications_total{result="quota_exceeded"} 1\n');
      expect(text).toContain(
        'blindsignal_authentication_duration_seconds_count{result="quota_exceeded"} 1\n',
      );
      expect(text).toContain(
        'blindsignal_application_errors_total{app_id="notes",code="quota_exceeded"} 1\n',
      );
    });

    it('never logs or counts a token, an identity, a namespace, or a relayed payload', async () => {
      const { connect, logs, metrics } = await setup();
      const namespace = 'notes:secret-namespace';
      const secrets = ['secret-sub', 'secret-device', namespace, 'secret-sdp', 'secret-candidate'];
      const mint = (claims: object) =>
        mintDevToken({ ...d1, namespaces: [namespace], ...claims }, { now: new Date() });
      const tokens = [
        await mint({ sub: 'secret-sub', device_id: 'secret-device' }),
        await mint({ sub: 'secret-sub', device_id: 'secret-device' }),
        await mint({ sub: 'u2', device_id: 'd2' }),
        await mint({ aud: 'other' }),
      ];
      const [aliceToken, refreshToken, bobToken, badToken] = tokens as [
        string,
        string,
        string,
        string,
      ];
      const alice = connect();
      const bob = connect();
      await alice.request('auth.authenticate', { token: aliceToken });
      await alice.request('auth.refresh', { token: refreshToken });
      await bob.request('auth.authenticate', { token: bobToken });
      await alice.request('namespace.join', { namespace });
      await bob.request('namespace.join', { namespace });
      await alice.request('session.create', { namespace, userId: 'u2', deviceId: 'd2' });
      await vi.advanceTimersByTimeAsync(0);
      const created = alice.sent.find((m) => m.type === 'session.created');
      if (created?.type !== 'session.created') throw new Error('no session');
      const { sessionId } = created.payload;
      await bob.request('session.accept', { sessionId });
      await alice.request('rtc.offer', { sessionId, sdp: 'v=0 secret-sdp' });
      await alice.request('rtc.ice_candidate', { sessionId, candidate: 'secret-candidate' });
      await vi.advanceTimersByTimeAsync(0);
      expect(bob.sent.map((m) => m.type)).toContain('rtc.ice_candidate');
      await connect().request('auth.authenticate', { token: badToken });
      await alice.connection.receive('{');
      const emitted = JSON.stringify(logs) + (await metrics.render());
      for (const value of [...tokens, ...secrets]) expect(emitted).not.toContain(value);
    });

    it('logs authentications and closing errors, never the user or the device', async () => {
      const { connect, logs } = await setup();
      const alice = connect();
      await alice.authenticate();
      await alice.request('namespace.join', { namespace: 'notes:other' });
      const bob = connect();
      await bob.connection.receive('{');
      expect(logs).toEqual([
        {
          level: 'info',
          event: 'connection.authenticated',
          connectionId: alice.connection.id,
          appId: 'notes',
        },
        {
          level: 'info',
          event: 'connection.error',
          connectionId: bob.connection.id,
          appId: undefined,
          code: 'malformed_frame',
        },
      ]);
      expect(JSON.stringify(logs)).not.toMatch(/"(u1|d1)"/);
    });
  });

  describe('token expiry', () => {
    it('closes with token_expired at exp plus the skew', async () => {
      const { connect } = await setup();
      const client = connect();
      await client.authenticate();
      await vi.advanceTimersByTimeAsync(LIFETIME_MS + SKEW_MS - 1);
      expect(client.closes).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(client.sent.at(-1)).toEqual({
        version: 1,
        type: 'error',
        payload: { code: 'token_expired' },
      });
      expect(client.closes).toEqual([4001]);
    });

    it('disarms the expiry when the transport closes', async () => {
      const { connect } = await setup();
      const client = connect();
      await client.authenticate();
      await client.connection.closed();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(LIFETIME_MS + SKEW_MS);
      expect(client.errors()).toEqual([]);
    });
  });

  it('sends nothing and keeps no claim when the socket closes during authentication', async () => {
    const { deps, coordination } = await setup();
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const verifier = {
      verify: async (token: string) => {
        await gate;
        return deps.verifier.verify(token);
      },
    };
    const sent: ServerMessage[] = [];
    const connection = new Connection(
      { clientIp: '192.0.2.1', send: (message) => sent.push(message), close: () => {} },
      { ...deps, verifier },
    );
    const token = await mintDevToken(d1, { now: new Date() });
    const auth = connection.receive(
      JSON.stringify({
        version: 1,
        type: 'auth.authenticate',
        requestId: 'r1',
        payload: { token },
      }),
    );
    await vi.waitFor(() => Promise.resolve());
    const closed = connection.closed();
    release();
    await Promise.all([auth, closed]);
    expect(sent).toEqual([]);
    expect(coordination.subscribedTopics).toBe(0);
    const device = { appId: 'notes', userId: 'u1', deviceId: 'd1' };
    expect(await coordination.claimDeviceConnection(device, 'probe')).toBeUndefined();
  });
});

describe('pairing (ADR 0042)', () => {
  const NS = 'notes:ws';
  const settle = () => vi.advanceTimersByTimeAsync(0);
  type Key = Awaited<ReturnType<typeof deviceKey>>;
  type Client = ReturnType<Connect>;

  /** A device of user u1 authenticated with a token bound to `key`, joined where it may be. */
  async function bound(connect: Connect, key: Key | undefined, claims: object) {
    const client = connect();
    client.connection.challenge();
    if (key === undefined) await client.authenticate(claims);
    else await client.request('auth.authenticate', await key.payload(client, claims));
    for (const namespace of (claims as { namespaces?: string[] }).namespaces ?? []) {
      await client.request('namespace.join', { namespace });
    }
    return client;
  }

  const of = <T extends ServerMessage['type']>(client: Client, type: T) =>
    client.sent.filter((message): message is ServerMessage & { type: T } => message.type === type);

  /** The new device d2, the approver d1 and, with `others`, d3, all of user u1. */
  async function devices(entries?: object[], approverClaims: object = {}) {
    const context = await setup(entries);
    const keys = { d1: await deviceKey(), d2: await deviceKey(), d3: await deviceKey() };
    const approver = await bound(context.connect, keys.d1, { namespaces: [NS], ...approverClaims });
    const other = await bound(context.connect, keys.d3, { device_id: 'd3', namespaces: [NS] });
    const requester = await bound(context.connect, keys.d2, { device_id: 'd2', pairing: [NS] });
    return { ...context, keys, approver, other, requester };
  }

  async function request(requester: Client) {
    await requester.request('pairing.create', { namespace: NS });
    await settle();
    const created = requester.last();
    if (created?.type !== 'pairing.created') throw new Error(`no pairing: ${created?.type}`);
    return created.payload.pairingId;
  }

  /** The claims an approval of `pairingId` for d2 carries. */
  const approvalOf = (pairingId: string, keys: { d2: Key }) => ({
    pairing_id: pairingId,
    namespace: NS,
    sub: 'u1',
    device_id: 'd2',
    jkt: keys.d2.cnf.jkt,
  });

  it("asks the user's devices, and relays the first approval to the requester", async () => {
    const { approver, other, requester, keys, metrics, logs } = await devices();
    const pairingId = await request(requester);
    const asked = { pairingId, namespace: NS, userId: 'u1', deviceId: 'd2', jkt: keys.d2.cnf.jkt };
    for (const client of [approver, other]) {
      expect(of(client, 'pairing.request').map((m) => m.payload)).toEqual([asked]);
    }
    const approval = await keys.d1.approve(approvalOf(pairingId, keys));
    await approver.request('pairing.approve', { pairingId, approval });
    await settle();
    expect(approver.last()?.type).toBe('ack');
    expect(requester.last()).toEqual({
      version: 1,
      type: 'pairing.approved',
      payload: { pairingId, approval },
    });
    expect(of(other, 'pairing.ended').map((m) => m.payload)).toEqual([
      { pairingId, reason: 'answered' },
    ]);
    // Answered already: a second answer finds nothing.
    await other.request('pairing.reject', { pairingId });
    expect(other.errors()).toEqual(['pairing_unavailable']);
    expect(await metrics.render()).toContain('blindsignal_pairings_total{result="approved"} 1\n');
    await vi.advanceTimersByTimeAsync(NEGOTIATION_MS);
    expect(of(approver, 'pairing.ended')).toEqual([]);
    expect(of(requester, 'pairing.ended')).toEqual([]);
    const audit = logs.filter((log) =>
      String((log as { event: string }).event).startsWith('pairing.'),
    );
    expect(audit).toEqual([
      { level: 'info', event: 'pairing.requested', appId: 'notes', pairingId },
      { level: 'info', event: 'pairing.approved', appId: 'notes', pairingId },
    ]);
  });

  it('relays only the first of two answers that cross', async () => {
    const { approver, other, requester, keys } = await devices();
    const pairingId = await request(requester);
    const approval = await keys.d1.approve(approvalOf(pairingId, keys));
    // Both answers leave before either reaches the requester.
    await Promise.all([
      approver.request('pairing.approve', { pairingId, approval }),
      other.request('pairing.reject', { pairingId }),
    ]);
    await settle();
    expect([...approver.errors(), ...other.errors(), ...requester.errors()]).toEqual([]);
    // The rejection, checked with no signature, arrives first.
    expect(of(requester, 'pairing.rejected')).toHaveLength(1);
    expect(of(requester, 'pairing.approved')).toEqual([]);
  });

  it('relays a rejection, and ends the request for the other devices', async () => {
    const { approver, other, requester, metrics } = await devices(undefined, {
      permissions: { [NS]: ['pairing.approve'] },
    });
    const pairingId = await request(requester);
    expect(of(approver, 'pairing.request')).toHaveLength(1);
    await other.request('pairing.reject', { pairingId });
    await settle();
    expect(requester.last()).toEqual({
      version: 1,
      type: 'pairing.rejected',
      payload: { pairingId },
    });
    expect(of(approver, 'pairing.ended').map((m) => m.payload.reason)).toEqual(['answered']);
    expect(await metrics.render()).toContain('blindsignal_pairings_total{result="rejected"} 1\n');
  });

  it.each([
    ['another type', {}, { typ: 'blindsignal-pop+jwt' }],
    ['another pairing', { pairing_id: '0b6c1a52-6f0c-4c1e-9f3a-2d7e8c4b5a61' }, {}],
    ['another namespace', { namespace: 'notes:other' }, {}],
    ['another user', { sub: 'u2' }, {}],
    ['another device', { device_id: 'd9' }, {}],
    ['another key to bind', { jkt: 'not-the-requester-key' }, {}],
  ])('refuses an approval naming %s, and keeps the request', async (_, claims, header) => {
    const { approver, requester, keys } = await devices();
    const pairingId = await request(requester);
    const wrong = await keys.d1.approve({ ...approvalOf(pairingId, keys), ...claims }, header);
    await approver.request('pairing.approve', { pairingId, approval: wrong });
    await settle();
    expect(approver.errors()).toEqual(['invalid_message']);
    expect(of(requester, 'pairing.approved')).toEqual([]);
    const approval = await keys.d1.approve(approvalOf(pairingId, keys));
    await approver.request('pairing.approve', { pairingId, approval });
    await settle();
    expect(of(requester, 'pairing.approved')).toHaveLength(1);
  });

  it('refuses an approval signed by another key or algorithm, expired, or without exp', async () => {
    const { approver, requester, keys } = await devices();
    const pairingId = await request(requester);
    const claims = approvalOf(pairingId, keys);
    const past = Math.floor(Date.now() / 1000) - 120;
    const symmetric = await new SignJWT(claims)
      .setProtectedHeader({ alg: 'HS256', typ: 'blindsignal-pairing+jwt' })
      .setExpirationTime('5m')
      .sign(new Uint8Array(32));
    for (const approval of [
      await keys.d3.approve(claims),
      await keys.d1.approve({ ...claims, exp: past }),
      await keys.d1.approve({ ...claims, exp: undefined }),
      symmetric,
      'not-a-jwt',
    ]) {
      await approver.request('pairing.approve', { pairingId, approval });
    }
    expect(approver.errors()).toEqual(Array(5).fill('invalid_message'));
  });

  it.each([
    ['no pairing claim', {}],
    ['a pairing claim for another namespace', { pairing: ['notes:other'] }],
  ])('refuses pairing.create with %s', async (_, claims) => {
    const context = await setup();
    await bound(context.connect, await deviceKey(), { namespaces: [NS] });
    const requester = await bound(context.connect, await deviceKey(), {
      device_id: 'd2',
      ...claims,
    });
    await requester.request('pairing.create', { namespace: NS });
    expect(requester.errors()).toEqual(['not_authorized']);
  });

  it('refuses pairing.create from a device whose token is not bound to a key', async () => {
    const context = await setup();
    await bound(context.connect, await deviceKey(), { namespaces: [NS] });
    const requester = await bound(context.connect, undefined, { device_id: 'd2', pairing: [NS] });
    await requester.request('pairing.create', { namespace: NS });
    expect(requester.errors()).toEqual(['not_authorized']);
  });

  it("answers peer_unavailable when none of the user's other devices is present", async () => {
    const context = await setup();
    await bound(context.connect, await deviceKey(), { sub: 'u2', namespaces: [NS] });
    const requester = await bound(context.connect, await deviceKey(), {
      device_id: 'd2',
      namespaces: [NS],
      pairing: [NS],
    });
    await requester.request('pairing.create', { namespace: NS });
    expect(requester.errors()).toEqual(['peer_unavailable']);
  });

  it('reaches no device without pairing.approve or a key, and times out', async () => {
    const context = await setup();
    const keys = [await deviceKey(), await deviceKey()];
    const unpermitted = await bound(context.connect, keys[0], {
      namespaces: [NS],
      permissions: { [NS]: ['session.create', 'session.accept'] },
    });
    const unbound = await bound(context.connect, undefined, { device_id: 'd3', namespaces: [NS] });
    const requester = await bound(context.connect, keys[1], { device_id: 'd2', pairing: [NS] });
    const pairingId = await request(requester);
    for (const client of [unpermitted, unbound]) expect(of(client, 'pairing.request')).toEqual([]);
    await vi.advanceTimersByTimeAsync(NEGOTIATION_MS - 1);
    expect(of(requester, 'pairing.ended')).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(requester.last()).toEqual({
      version: 1,
      type: 'pairing.ended',
      payload: { pairingId, reason: 'timeout' },
    });
    for (const client of [unpermitted, unbound]) expect(of(client, 'pairing.ended')).toEqual([]);
    expect(await context.metrics.render()).toContain(
      'blindsignal_pairings_total{result="timeout"} 1\n',
    );
    expect(context.logs).toContainEqual({
      level: 'info',
      event: 'pairing.expired',
      appId: 'notes',
      pairingId,
    });
  });

  it('tells the asked devices once when the request times out, and refuses a late answer', async () => {
    const { approver, other, requester } = await devices();
    const pairingId = await request(requester);
    await vi.advanceTimersByTimeAsync(NEGOTIATION_MS);
    for (const client of [approver, other, requester]) {
      expect(of(client, 'pairing.ended').map((m) => m.payload)).toEqual([
        { pairingId, reason: 'timeout' },
      ]);
    }
    await approver.request('pairing.reject', { pairingId });
    expect(approver.errors()).toEqual(['pairing_unavailable']);
    expect(of(requester, 'pairing.rejected')).toEqual([]);
  });

  it("ends an asked device's request on its own when the requester's timeout never comes", async () => {
    const { approver, requester, coordination } = await devices();
    const pairingId = await request(requester);
    // The requester's instance is gone: its events no longer arrive.
    vi.spyOn(coordination, 'publish').mockResolvedValue();
    await vi.advanceTimersByTimeAsync(NEGOTIATION_MS);
    expect(of(approver, 'pairing.ended').map((m) => m.payload)).toEqual([
      { pairingId, reason: 'timeout' },
    ]);
  });

  it('ends the request for the asked devices when the requester leaves', async () => {
    const { approver, other, requester } = await devices();
    const pairingId = await request(requester);
    await requester.connection.closed();
    await settle();
    for (const client of [approver, other]) {
      expect(of(client, 'pairing.ended').map((m) => m.payload)).toEqual([
        { pairingId, reason: 'requester_gone' },
      ]);
    }
    await vi.advanceTimersByTimeAsync(NEGOTIATION_MS);
    expect(of(approver, 'pairing.ended')).toHaveLength(1);
  });

  it('refuses an unknown pairing, and an approval after a refresh withdrew the permission', async () => {
    const { approver, requester, keys } = await devices();
    await approver.request('pairing.approve', {
      pairingId: '0b6c1a52-6f0c-4c1e-9f3a-2d7e8c4b5a61',
      approval: 'x',
    });
    expect(approver.errors()).toEqual(['pairing_unavailable']);
    const pairingId = await request(requester);
    await approver.request(
      'auth.refresh',
      await keys.d1.payload(approver, {
        namespaces: [NS],
        permissions: { [NS]: ['session.create'] },
      }),
    );
    const approval = await keys.d1.approve(approvalOf(pairingId, keys));
    await approver.request('pairing.approve', { pairingId, approval });
    expect(approver.errors()).toEqual(['pairing_unavailable', 'not_authorized']);
    // A rejection needs no permission.
    await approver.request('pairing.reject', { pairingId });
    await settle();
    expect(of(requester, 'pairing.rejected')).toHaveLength(1);
  });

  it('rate-limits pairing.create per connection', async () => {
    const { requester } = await devices(limited({ pairing: ONE_PER_SECOND }));
    await request(requester);
    await requester.request('pairing.create', { namespace: NS });
    expect(requester.last()).toEqual(rateLimited('r3'));
  });

  it.each([
    ['another application', { pairing: ['chat:ws'] }],
    [
      'more namespaces than allowed',
      { pairing: Array.from({ length: 101 }, (_, i) => `notes:${i}`) },
    ],
  ])('rejects a token whose pairing claim names %s', async (_, claims) => {
    const { connect } = await setup();
    const client = connect();
    await client.authenticate(claims);
    expect(client.errors()).toEqual(['invalid_token']);
  });
});
