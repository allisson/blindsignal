import { InMemoryCoordinationAdapter } from '@blindsignal/coordination-memory';
import { openRedisCoordination, type RedisCoordination } from '@blindsignal/coordination-redis';
import type { CoordinationAdapter } from '@blindsignal/core';
import { devApplication, mintDevToken } from '@blindsignal/dev-issuer';
import type { ServerMessage } from '@blindsignal/protocol';
import {
  BlindSignalClient,
  BlindSignalError,
  type Presence,
  type SessionRequest,
} from '@blindsignal/sdk';
import { FakePeerConnection } from '@blindsignal/sdk/testing';
import {
  InMemoryApplicationRepository,
  InMemoryDeviceRepository,
} from '@blindsignal/storage-memory';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { BlockList } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { loadConfig, type PreAuthentication } from './config.ts';
import { AbuseMonitor } from './domain/abuse.ts';
import { TokenVerifier } from './domain/auth.ts';
import { parseRegistry } from './domain/registry.ts';
import type { AllowedOrigins } from './domain/origin.ts';
import { GOING_AWAY, SignalingServer } from './server.ts';
import { Metrics } from './telemetry.ts';

interface Options {
  readonly allowedOrigins?: AllowedOrigins;
  readonly heartbeatIntervalMs?: number;
  readonly presenceLeaseMs?: number;
  readonly maxMessageBytes?: number;
  readonly trustedProxies?: BlockList;
  readonly preAuthentication?: Partial<PreAuthentication>;
  /** Shared by several servers to stand for several instances; in memory by default. */
  readonly coordination?: CoordinationAdapter;
}

const servers: SignalingServer[] = [];
const loaded = loadConfig({ BLINDSIGNAL_ENV: 'development', BLINDSIGNAL_REGISTRY_PATH: 'unused' });
if (!loaded.ok) throw new Error(loaded.error);
const defaults = loaded.config;

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

async function start(options: Options = {}) {
  const now = new Date();
  const registry = parseRegistry(JSON.stringify({ applications: [devApplication('notes')] }), {
    now,
    development: true,
  });
  if (!registry.ok) throw new Error(registry.error);
  const applications = new InMemoryApplicationRepository();
  await applications.replaceAll(registry.registry.applications);
  const coordination = options.coordination ?? new InMemoryCoordinationAdapter();
  const logs: Record<string, unknown>[] = [];
  const preAuthentication = { ...defaults.preAuthentication, ...options.preAuthentication };
  const server = new SignalingServer({
    allowedOrigins: options.allowedOrigins ?? '*',
    proxyTrust: {
      proxies: options.trustedProxies ?? new BlockList(),
      header: 'x-forwarded-for',
    },
    heartbeatIntervalMs: options.heartbeatIntervalMs ?? 60_000,
    preAuthentication,
    coordination,
    connection: {
      verifier: new TokenVerifier({
        applications,
        coordination,
        maxLifetimeSeconds: 600,
        clockSkewSeconds: 60,
        maxNamespaces: 100,
        // The dev tokens' iat is truncated to the second.
        startedAt: new Date(now.getTime() - 1_000),
      }),
      devices: new InMemoryDeviceRepository(),
      coordination,
      iceServers: [],
      clockSkewSeconds: 60,
      authenticationTimeoutMs: 10_000,
      authenticationAttempts: preAuthentication.authenticationAttempts,
      deviceTtlMs: 86_400_000,
      limits: defaults.limits,
      presenceLeaseMs: options.presenceLeaseMs ?? 90_000,
      negotiationTimeoutMs: 30_000,
      maxMessageBytes: options.maxMessageBytes,
      maxQueuedMessages: defaults.maxQueuedMessages,
      maxBufferedBytes: defaults.maxBufferedBytes,
      abuse: new AbuseMonitor(defaults.abuseAlerts),
      metrics: new Metrics(),
      logger: { log: (level, event, fields) => logs.push({ level, event, ...fields }) },
    },
  });
  servers.push(server);
  const port = await server.listen(0, '127.0.0.1');
  const base = `127.0.0.1:${port}`;

  /** An open client that records what it receives and how it closed. */
  const client = async (wsOptions: WebSocket.ClientOptions = {}) => {
    const ws = new WebSocket(`ws://${base}/`, wsOptions);
    const received: ServerMessage[] = [];
    const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
    ws.on('message', (data) =>
      received.push(JSON.parse((data as Buffer).toString()) as ServerMessage),
    );
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    let n = 0;
    const send = (type: string, payload: object = {}) =>
      ws.send(JSON.stringify({ version: 1, type, requestId: `r${++n}`, payload }));
    /** Resolves to the first message of the type received from now on, or already received. */
    const next = (type: string) =>
      vi.waitFor(() => {
        const message = received.find((m) => m.type === type);
        if (message === undefined) throw new Error(`no ${type}`);
        received.splice(received.indexOf(message), 1);
        return message;
      });
    const authenticate = async (claims: {
      sub: string;
      device_id: string;
      namespaces: string[];
    }) => {
      send('auth.authenticate', {
        token: await mintDevToken({ app_id: 'notes', ...claims }, { now: new Date() }),
      });
      await next('rtc.ice_config');
    };
    return { ws, received, closed, send, next, authenticate };
  };

  /** Resolves to the HTTP response of a refused upgrade. */
  const refusal = (headers: Record<string, string> = {}) =>
    new Promise<IncomingMessage>((resolve, reject) => {
      const ws = new WebSocket(`ws://${base}/`, { headers });
      ws.once('unexpected-response', (_, response) => resolve(response));
      ws.once('open', () => reject(new Error('upgrade accepted')));
      ws.once('error', () => {});
    });
  const refusedUpgrade = (headers: Record<string, string> = {}) =>
    refusal(headers).then((response) => response.statusCode);

  const http = (path: string) => fetch(`http://${base}${path}`).then((r) => r.status);

  return {
    server,
    coordination,
    client,
    refusal,
    refusedUpgrade,
    http,
    logs,
    url: `ws://${base}/`,
  };
}

describe('SignalingServer', () => {
  it('serves health and readiness, and 404 elsewhere', async () => {
    const { http } = await start();
    expect(await http('/healthz')).toBe(200);
    expect(await http('/readyz')).toBe(200);
    expect(await http('/')).toBe(404);
  });

  describe('Origin at the upgrade', () => {
    const allowed = new Set(['https://app.example']);

    it('refuses a disallowed origin with 403', async () => {
      const { refusedUpgrade } = await start({ allowedOrigins: allowed });
      expect(await refusedUpgrade({ origin: 'https://evil.example' })).toBe(403);
    });

    it('accepts an allowed origin and a request without one', async () => {
      const { client } = await start({ allowedOrigins: allowed });
      await client({ headers: { origin: 'https://app.example' } });
      await client();
    });
  });

  describe('before authentication', () => {
    const proxied = new BlockList();
    proxied.addAddress('127.0.0.1');
    const from = (ip: string) => ({ headers: { 'x-forwarded-for': ip } });
    const ip = (address: string) => from(address).headers;
    const claims = { sub: 'u1', device_id: 'd1', namespaces: [] };

    it('caps unauthenticated connections per client IP', async () => {
      const { client, refusal, refusedUpgrade } = await start({
        trustedProxies: proxied,
        preAuthentication: { maxUnauthenticatedPerIp: 2 },
      });
      const first = await client(from('203.0.113.1'));
      await client(from('203.0.113.1'));
      const refused = await refusal(ip('203.0.113.1'));
      expect(refused.statusCode).toBe(429);
      expect(refused.headers['retry-after']).toBeUndefined();
      await client(from('203.0.113.2'));
      first.ws.close();
      await first.closed;
      await vi.waitFor(() => client(from('203.0.113.1')));
      expect(await refusedUpgrade(ip('203.0.113.1'))).toBe(429);
    });

    it('stops counting a connection once it authenticates, and counts it once', async () => {
      const { server, client, refusedUpgrade } = await start({
        preAuthentication: { maxUnauthenticated: 1 },
      });
      const alice = await client();
      await alice.authenticate(claims);
      alice.ws.close();
      await vi.waitFor(() => expect(server.connections).toBe(0));
      await client();
      expect(await refusedUpgrade()).toBe(429);
    });

    it('stops counting a connection that closes unauthenticated', async () => {
      const { client } = await start({ preAuthentication: { maxUnauthenticatedPerIp: 1 } });
      const alice = await client();
      alice.ws.close();
      await alice.closed;
      await vi.waitFor(() => client());
    });

    it('caps unauthenticated connections in all', async () => {
      const { client, refusedUpgrade } = await start({
        trustedProxies: proxied,
        preAuthentication: { maxUnauthenticated: 2 },
      });
      await client(from('203.0.113.1'));
      await client(from('203.0.113.2'));
      expect(await refusedUpgrade(ip('203.0.113.3'))).toBe(429);
    });

    it('limits connection attempts per client IP, with Retry-After', async () => {
      const { client, refusal } = await start({
        trustedProxies: proxied,
        preAuthentication: { connectionAttempts: { ratePerSecond: 0.5, burst: 2 } },
      });
      (await client(from('203.0.113.1'))).ws.close();
      (await client(from('203.0.113.1'))).ws.close();
      const refused = await refusal(ip('203.0.113.1'));
      expect(refused.statusCode).toBe(429);
      expect(refused.headers['retry-after']).toBe('2');
      await client(from('203.0.113.2'));
    });

    it('limits authentication attempts per client IP', async () => {
      const { client } = await start({
        trustedProxies: proxied,
        preAuthentication: { authenticationAttempts: { ratePerSecond: 0.001, burst: 1 } },
      });
      await (await client(from('203.0.113.1'))).authenticate(claims);
      await (await client(from('203.0.113.2'))).authenticate({ ...claims, device_id: 'd2' });
      const limited = await client(from('203.0.113.1'));
      limited.send('auth.authenticate', { token: 'unverified' });
      expect(await limited.next('error')).toMatchObject({ payload: { code: 'rate_limited' } });
    });

    it('releases the count of an attempt refused by the rate limit', async () => {
      const { client, refusedUpgrade } = await start({
        trustedProxies: proxied,
        preAuthentication: {
          maxUnauthenticated: 1,
          connectionAttempts: { ratePerSecond: 0.001, burst: 1 },
        },
      });
      const first = await client(from('203.0.113.1'));
      first.ws.close();
      await first.closed;
      await vi.waitFor(async () => expect(await refusedUpgrade(ip('203.0.113.1'))).toBe(429));
      await vi.waitFor(() => client(from('203.0.113.2')));
    });
  });

  it('signals a session between two clients end to end', async () => {
    const { client } = await start();
    const alice = await client();
    const bob = await client();
    await alice.authenticate({ sub: 'u1', device_id: 'd1', namespaces: ['notes:a'] });
    await bob.authenticate({ sub: 'u2', device_id: 'd2', namespaces: ['notes:a'] });
    alice.send('namespace.join', { namespace: 'notes:a' });
    await alice.next('ack');
    bob.send('namespace.join', { namespace: 'notes:a' });
    await bob.next('ack');
    expect(await alice.next('presence.changed')).toMatchObject({
      payload: { userId: 'u2', deviceId: 'd2', present: true },
    });

    alice.send('session.create', { namespace: 'notes:a', userId: 'u2', deviceId: 'd2' });
    const created = await alice.next('session.created');
    const sessionId = (created.payload as { sessionId: string }).sessionId;
    expect(await bob.next('session.request')).toMatchObject({ payload: { sessionId } });
    bob.send('session.accept', { sessionId });
    await alice.next('session.accepted');

    alice.send('rtc.offer', { sessionId, sdp: 'v=0' });
    expect(await bob.next('rtc.offer')).toEqual({
      version: 1,
      type: 'rtc.offer',
      payload: { sessionId, sdp: 'v=0' },
    });

    alice.ws.close();
    expect(await bob.next('session.terminated')).toMatchObject({
      payload: { sessionId, reason: 'peer_disconnected' },
    });
  });

  it('closes on a binary frame with malformed_frame', async () => {
    const { client } = await start();
    const alice = await client();
    alice.ws.send(Buffer.from('{}'), { binary: true });
    expect(await alice.closed).toBe(4002);
    expect(alice.received).toEqual([
      { version: 1, type: 'error', payload: { code: 'malformed_frame' } },
    ]);
  });

  it('closes on an oversized message with message_too_large', async () => {
    const { client } = await start({ maxMessageBytes: 256 });
    const alice = await client();
    alice.send('connection.ping', { pad: 'x'.repeat(300) });
    expect(await alice.closed).toBe(4002);
    expect(alice.received).toMatchObject([
      { type: 'error', payload: { code: 'message_too_large' } },
    ]);
  });

  it('cuts a frame far above the limit with 1009', async () => {
    const { client } = await start({ maxMessageBytes: 256 });
    const alice = await client();
    alice.send('connection.ping', { pad: 'x'.repeat(1_000) });
    expect(await alice.closed).toBe(1009);
  });

  it('terminates a client that stops answering pings, and renews the others', async () => {
    const { client, coordination } = await start({ heartbeatIntervalMs: 50, presenceLeaseMs: 120 });
    const alive = await client();
    const dead = await client({ autoPong: false });
    await alive.authenticate({ sub: 'u1', device_id: 'd1', namespaces: ['notes:a'] });
    alive.send('namespace.join', { namespace: 'notes:a' });
    await alive.next('ack');
    expect(await dead.closed).toBe(1006);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await coordination.listPresence('notes:a')).toEqual([
      { appId: 'notes', userId: 'u1', deviceId: 'd1' },
    ]);
  });

  it('logs the client IP, read through a trusted proxy, and the close code', async () => {
    const trustedProxies = new BlockList();
    trustedProxies.addAddress('127.0.0.1');
    const { server, client, logs } = await start({ trustedProxies });
    const proxied = await client({ headers: { 'x-forwarded-for': '203.0.113.7' } });
    expect(server.connections).toBe(1);
    proxied.ws.close(1000);
    await vi.waitFor(() => {
      if (!logs.some((l) => l.event === 'connection.closed')) throw new Error('not closed');
    });
    expect(server.connections).toBe(0);
    const connectionId = logs[0]?.connectionId;
    expect(connectionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(logs).toEqual([
      {
        level: 'info',
        event: 'connection.opened',
        connectionId,
        ip: '203.0.113.7',
      },
      {
        level: 'info',
        event: 'connection.closed',
        connectionId,
        appId: undefined,
        code: 1000,
      },
    ]);
  });

  it('logs the TCP peer when no proxy is trusted', async () => {
    const { client, logs } = await start();
    await client({ headers: { 'x-forwarded-for': '203.0.113.7' } });
    expect(logs).toMatchObject([{ event: 'connection.opened', ip: '127.0.0.1' }]);
  });

  it('counts authenticated connections by application', async () => {
    const { server, client } = await start();
    const alice = await client();
    const bob = await client();
    await client();
    expect(server.connectionsByApplication()).toEqual(new Map());
    await alice.authenticate({ sub: 'u1', device_id: 'd1', namespaces: ['notes:a'] });
    await bob.authenticate({ sub: 'u2', device_id: 'd2', namespaces: ['notes:a'] });
    expect(server.connectionsByApplication()).toEqual(new Map([['notes', 2]]));
  });

  it('closes the connections a reloaded registry makes unavailable', async () => {
    const { server, client } = await start();
    const alice = await client();
    await alice.authenticate({ sub: 'u1', device_id: 'd1', namespaces: ['notes:a'] });
    await server.enforce([]);
    expect(await alice.next('error')).toMatchObject({
      payload: { code: 'application_unavailable' },
    });
    expect(await alice.closed).toBe(4002);
  });

  it('drains: fails readiness, refuses upgrades, and closes clients with 1001', async () => {
    const { server, client, coordination, refusedUpgrade, http } = await start();
    const alice = await client();
    await alice.authenticate({ sub: 'u1', device_id: 'd1', namespaces: ['notes:a'] });
    alice.send('namespace.join', { namespace: 'notes:a' });
    await alice.next('ack');
    // A slow adapter: drain still waits until the connection released its presence.
    const release = coordination.releasePresence.bind(coordination);
    coordination.releasePresence = async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return release(...args);
    };
    await server.drain();
    expect(await alice.closed).toBe(GOING_AWAY);
    expect(await coordination.listPresence('notes:a')).toEqual([]);
    expect(await http('/readyz')).toBe(503);
    expect(await http('/healthz')).toBe(200);
    expect(await refusedUpgrade()).toBe(503);
  });
});

describe('SignalingServer with the SDK', () => {
  const sdks: BlindSignalClient[] = [];

  afterEach(() => {
    for (const sdk of sdks.splice(0)) sdk.close();
  });

  function sdk(url: string, sub: string, device_id: string, namespaces = ['notes:a']) {
    const peers: FakePeerConnection[] = [];
    const client = new BlindSignalClient({
      serverUrl: url,
      accessTokenProvider: () => mintDevToken({ app_id: 'notes', sub, device_id, namespaces }),
      createPeerConnection: (configuration) => {
        const pc = new FakePeerConnection(configuration);
        peers.push(pc);
        return pc as unknown as RTCPeerConnection;
      },
    });
    sdks.push(client);
    const presence: Presence[] = [];
    client.on('presence', (p) => presence.push(p));
    return { client, presence, peers };
  }

  it('authenticates, joins, sees presence, discovers, and leaves', async () => {
    const { url } = await start();
    const alice = sdk(url, 'alice', 'laptop');
    const bob = sdk(url, 'bob', 'phone');
    await expect(alice.client.connect()).resolves.toEqual({ userId: 'alice', deviceId: 'laptop' });
    expect(alice.client.iceConfig).toEqual({ iceServers: [] });
    await alice.client.join('notes:a');
    await bob.client.connect();
    await bob.client.join('notes:a');

    const bobPresent = { namespace: 'notes:a', userId: 'bob', deviceId: 'phone', present: true };
    await vi.waitFor(() => expect(alice.presence).toEqual([bobPresent]));
    expect(await alice.client.discover('notes:a')).toEqual([{ userId: 'bob', deviceId: 'phone' }]);
    expect(await bob.client.discover('notes:a')).toEqual([{ userId: 'alice', deviceId: 'laptop' }]);
    expect(bob.presence).toEqual([]);

    await bob.client.leave('notes:a');
    await vi.waitFor(() =>
      expect(alice.presence).toEqual([bobPresent, { ...bobPresent, present: false }]),
    );
    expect(await alice.client.discover('notes:a')).toEqual([]);
  });

  it('rejects an unauthorized join and a discovery outside a joined namespace', async () => {
    const { url } = await start();
    const alice = sdk(url, 'alice', 'laptop');
    await alice.client.connect();
    await expect(alice.client.join('notes:b')).rejects.toEqual(
      new BlindSignalError('not_authorized'),
    );
    await expect(alice.client.discover('notes:a')).rejects.toEqual(
      new BlindSignalError('not_joined'),
    );
  });

  it('stops when a newer connection of the same device supersedes it', async () => {
    const { url } = await start();
    const first = sdk(url, 'alice', 'laptop');
    const states: unknown[] = [];
    first.client.on('state', (s) => states.push(s));
    await first.client.connect();
    await sdk(url, 'alice', 'laptop').client.connect();
    await vi.waitFor(() =>
      expect(states.at(-1)).toEqual({ state: 'disconnected', error: 'superseded' }),
    );
  });

  describe('sessions', () => {
    async function pair() {
      const { url } = await start();
      const alice = sdk(url, 'alice', 'laptop');
      const bob = sdk(url, 'bob', 'phone');
      const requests: SessionRequest[] = [];
      bob.client.on('sessionRequest', (r) => requests.push(r));
      for (const { client } of [alice, bob]) {
        await client.connect();
        await client.join('notes:a');
      }
      const session = await alice.client.createSession({
        namespace: 'notes:a',
        userId: 'bob',
        deviceId: 'phone',
      });
      const request = await vi.waitFor(() => {
        expect(requests).toHaveLength(1);
        return requests[0]!;
      });
      const ended: unknown[] = [];
      session.on('ended', (e) => ended.push(e));
      return { alice, bob, session, request, ended };
    }

    it('connects a requester and a target, and closes', async () => {
      const { session, request, ended } = await pair();
      expect(request).toMatchObject({
        sessionId: session.id,
        namespace: 'notes:a',
        userId: 'alice',
        deviceId: 'laptop',
      });
      const accepted = new Promise((resolve) => session.on('accepted', resolve));
      const target = await request.accept();
      await accepted;
      expect(session.state).toBe('active');
      expect(target.state).toBe('active');
      const targetEnded = new Promise((resolve) => target.on('ended', resolve));
      session.close();
      await expect(targetEnded).resolves.toEqual({ reason: 'closed_by_peer' });
      expect(ended).toEqual([{ reason: 'closed' }]);
    });

    it('relays the offer, the answer, and candidates between the two peers', async () => {
      const { alice, bob, request } = await pair();
      await request.accept();
      const [offerer] = alice.peers;
      const [answerer] = bob.peers;
      await vi.waitFor(() =>
        expect(answerer!.remoteDescription).toEqual({ type: 'offer', sdp: 'offer sdp' }),
      );
      await vi.waitFor(() =>
        expect(offerer!.remoteDescription).toEqual({ type: 'answer', sdp: 'answer sdp' }),
      );
      const candidate = { candidate: 'candidate:1 1 udp 1 192.0.2.1 9 typ host', sdpMid: '0' };
      offerer!.gather(candidate);
      answerer!.gather({ ...candidate, sdpMid: '1' });
      await vi.waitFor(() => expect(answerer!.candidates).toEqual([candidate]));
      await vi.waitFor(() => expect(offerer!.candidates).toEqual([{ ...candidate, sdpMid: '1' }]));
    });

    it('reports a rejection to the requester', async () => {
      const { request, ended } = await pair();
      await request.reject();
      await vi.waitFor(() => expect(ended).toEqual([{ reason: 'rejected' }]));
    });

    it('ends the session when the target disconnects', async () => {
      const { bob, request, ended } = await pair();
      await request.accept();
      bob.client.close();
      await vi.waitFor(() => expect(ended).toEqual([{ reason: 'peer_disconnected' }]));
    });

    it('refuses a session with an absent device', async () => {
      const { url } = await start();
      const alice = sdk(url, 'alice', 'laptop');
      await alice.client.connect();
      await alice.client.join('notes:a');
      await expect(
        alice.client.createSession({ namespace: 'notes:a', userId: 'bob', deviceId: 'phone' }),
      ).rejects.toEqual(new BlindSignalError('peer_unavailable'));
    });
  });

  // Runs only against a server: `docker compose --profile valkey up --wait valkey` (ADR 0019).
  const redisUrl = process.env.BLINDSIGNAL_TEST_REDIS_URL;

  describe.skipIf(redisUrl === undefined)('on two instances sharing Redis (ADR 0023)', () => {
    const opened: RedisCoordination[] = [];

    // Servers release their connections through Redis, so they drain before it closes.
    afterEach(async () => {
      for (const client of sdks.splice(0)) client.close();
      for (const server of servers.splice(0)) {
        await server.drain();
        await server.close();
      }
      await Promise.all(opened.splice(0).map((redis) => redis.end()));
    });

    async function instance(prefix: string) {
      const redis = await openRedisCoordination({
        url: redisUrl as string,
        prefix,
        onError: () => {},
      });
      opened.push(redis);
      return start({ coordination: redis.coordination });
    }

    it('discovers, connects, signals, and closes devices on different instances', async () => {
      const prefix = `test:${randomUUID()}:`;
      const [one, two] = await Promise.all([instance(prefix), instance(prefix)]);
      const alice = sdk(one.url, 'alice', 'laptop');
      const bob = sdk(two.url, 'bob', 'phone');
      const requests: SessionRequest[] = [];
      bob.client.on('sessionRequest', (r) => requests.push(r));
      for (const { client } of [alice, bob]) {
        await client.connect();
        await client.join('notes:a');
      }
      await vi.waitFor(() =>
        expect(alice.presence).toEqual([
          { namespace: 'notes:a', userId: 'bob', deviceId: 'phone', present: true },
        ]),
      );
      expect(await alice.client.discover('notes:a')).toEqual([
        { userId: 'bob', deviceId: 'phone' },
      ]);

      const session = await alice.client.createSession({
        namespace: 'notes:a',
        userId: 'bob',
        deviceId: 'phone',
      });
      const request = await vi.waitFor(() => {
        expect(requests).toHaveLength(1);
        return requests[0]!;
      });
      const accepted = new Promise((resolve) => session.on('accepted', resolve));
      const target = await request.accept();
      await accepted;
      const [offerer] = alice.peers;
      const [answerer] = bob.peers;
      await vi.waitFor(() =>
        expect(offerer!.remoteDescription).toEqual({ type: 'answer', sdp: 'answer sdp' }),
      );
      const candidate = { candidate: 'candidate:1 1 udp 1 192.0.2.1 9 typ host', sdpMid: '0' };
      offerer!.gather(candidate);
      await vi.waitFor(() => expect(answerer!.candidates).toEqual([candidate]));
      expect(one.server.sessionsByApplication()).toEqual(new Map([['notes', 1]]));
      expect(two.server.sessionsByApplication()).toEqual(new Map());

      const targetEnded = new Promise((resolve) => target.on('ended', resolve));
      session.close();
      await expect(targetEnded).resolves.toEqual({ reason: 'closed_by_peer' });
      await vi.waitFor(() => expect(one.server.sessionsByApplication()).toEqual(new Map()));
    });

    it('supersedes a device that connects again on another instance', async () => {
      const prefix = `test:${randomUUID()}:`;
      const [one, two] = await Promise.all([instance(prefix), instance(prefix)]);
      const first = await one.client();
      await first.authenticate({ sub: 'alice', device_id: 'laptop', namespaces: ['notes:a'] });
      const second = await two.client();
      await second.authenticate({ sub: 'alice', device_id: 'laptop', namespaces: ['notes:a'] });
      expect(await first.closed).toBe(4003);
    });
  });
});
