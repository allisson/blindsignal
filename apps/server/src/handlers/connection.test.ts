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
import { Connection, connectionTopic, type ConnectionDependencies } from './connection.ts';

const START = new Date('2026-11-02T00:00:00Z');
const SKEW_MS = 60_000;
const LIFETIME_MS = 300_000;
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
    ...options,
  };

  /** A connection whose transport, like the real one, reports its own close. */
  const connect = () => {
    const sent: ServerMessage[] = [];
    const closes: number[] = [];
    const connection: Connection = new Connection(
      {
        send: (message) => sent.push(message),
        close: (code) => {
          closes.push(code);
          void connection.closed();
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
    return { connection, sent, closes, request, authenticate, refresh, errors };
  };

  return { connect, load, coordination, devices, deps };
}

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
      expect(touched.ok && touched.record.firstSeenAt).toEqual(START);
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

    it('denies a message type without a handler', async () => {
      const { connect } = await setup();
      const client = connect();
      await client.authenticate({ namespaces: ['notes:a'] });
      await client.request('namespace.join', { namespace: 'notes:a' });
      expect(client.errors()).toEqual(['not_authorized']);
      expect(client.closes).toEqual([]);
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
