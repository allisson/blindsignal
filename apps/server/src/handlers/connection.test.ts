import { InMemoryCoordinationAdapter } from '@blindsignal/coordination-memory';
import { devApplication, mintDevToken } from '@blindsignal/dev-issuer';
import type { ServerMessage } from '@blindsignal/protocol';
import {
  InMemoryApplicationRepository,
  InMemoryDeviceRepository,
} from '@blindsignal/storage-memory';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TokenVerifier } from '../domain/auth.ts';
import { parseRegistry } from '../domain/registry.ts';
import { SessionRegistry } from '../domain/sessions.ts';
import {
  Connection,
  connectionTopic,
  presenceTopic,
  type ConnectionDependencies,
} from './connection.ts';

const START = new Date('2026-11-02T00:00:00Z');
const SKEW_MS = 60_000;
const LIFETIME_MS = 300_000;
const LEASE_MS = 90_000;
const NEGOTIATION_MS = 30_000;
const ICE = [{ urls: ['stun:stun.example:3478'] }];
const d1 = { app_id: 'notes', sub: 'u1', device_id: 'd1' };

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
  };
  await load(entries);
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
    deviceLimits: { ttlMs: 86_400_000, maxDevices: 10 },
    presenceLeaseMs: LEASE_MS,
    sessions: new SessionRegistry(),
    negotiationTimeoutMs: NEGOTIATION_MS,
    ...options,
  };

  /** A connection whose transport, like the real one, reports its own close unless told not to. */
  const connect = ({ reportsClose = true } = {}) => {
    const sent: ServerMessage[] = [];
    const closes: number[] = [];
    const connection: Connection = new Connection(
      {
        send: (message) => sent.push(message),
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
    return { connection, sent, closes, request, authenticate, refresh, errors, presence, last };
  };

  return { connect, load, coordination, devices, deps };
}

type Connect = Awaited<ReturnType<typeof setup>>['connect'];

describe('Connection', () => {
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
        deviceLimits: { ttlMs: 86_400_000, maxDevices: 1 },
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
    it.each(['connection.ping', 'auth.refresh', 'namespace.join'])(
      'closes on %s with not_authenticated',
      async (type) => {
        const { connect } = await setup();
        const client = connect();
        const payload =
          type === 'auth.refresh'
            ? { token: 'x' }
            : type === 'namespace.join'
              ? { namespace: 'notes:a' }
              : {};
        await client.request(type, payload);
        expect(client.sent).toEqual([
          { version: 1, type: 'error', requestId: 'r1', payload: { code: 'not_authenticated' } },
        ]);
        expect(client.closes).toEqual([4002]);
      },
    );

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

    it('keeps the connection on quota_exceeded', async () => {
      const { connect, devices } = await setup(undefined, {
        deviceLimits: { ttlMs: 1_000, maxDevices: 1 },
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

    async function pair() {
      const context = await setup();
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

    async function active() {
      const context = await pair();
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

    it('ends a session once when its timeout races an answer', async () => {
      const { alice, bob } = await pair();
      const sessionId = await create(alice);
      vi.advanceTimersByTime(NEGOTIATION_MS - 1);
      // The reject is handled first, then the timeout queued behind it finds the session gone.
      const reject = bob.request('session.reject', { sessionId });
      vi.advanceTimersByTime(1);
      await reject;
      await settle();
      const types = (client: Client) =>
        client.sent.map((message) => message.type).filter((type) => type.startsWith('session.'));
      expect(types(alice)).toEqual(['session.created', 'session.rejected']);
      expect(types(bob)).toEqual(['session.request']);
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
      { send: (message) => sent.push(message), close: () => {} },
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
