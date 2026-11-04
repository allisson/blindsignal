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
import { BlockList, connect, createServer, type Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { loadConfig, type PreAuthentication } from './config.ts';
import { AbuseMonitor } from './domain/abuse.ts';
import { TokenVerifier } from './domain/auth.ts';
import {
  followRegistry,
  parseRegistry,
  REGISTRY_CHANGED,
  REGISTRY_TOPIC,
  syncRegistry,
  type Registry,
} from './domain/registry.ts';
import type { AllowedOrigins } from './domain/origin.ts';
import { connectionLifetime, GOING_AWAY, SignalingServer } from './server.ts';
import { Metrics } from './telemetry.ts';

interface Options {
  readonly allowedOrigins?: AllowedOrigins;
  readonly heartbeatIntervalMs?: number;
  readonly closeTimeoutMs?: number;
  readonly authenticationTimeoutMs?: number;
  readonly maxConnectionMs?: number;
  readonly maxConnections?: number;
  readonly presenceLeaseMs?: number;
  readonly maxMessageBytes?: number;
  readonly maxBufferedBytes?: number;
  readonly trustedProxies?: BlockList;
  readonly preAuthentication?: Partial<PreAuthentication>;
  /** Shared by several servers to stand for several instances; in memory by default. */
  readonly coordination?: CoordinationAdapter;
  /** Registry entries; `notes` alone by default. */
  readonly applications?: object[];
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
  const registry = parseRegistry(
    JSON.stringify({ applications: options.applications ?? [devApplication('notes')] }),
    { now, development: true },
  );
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
    closeTimeoutMs: options.closeTimeoutMs ?? defaults.closeTimeoutMs,
    maxConnectionMs: options.maxConnectionMs,
    maxConnections: options.maxConnections,
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
      authenticationTimeoutMs: options.authenticationTimeoutMs ?? 10_000,
      authenticationAttempts: preAuthentication.authenticationAttempts,
      deviceTtlMs: 86_400_000,
      limits: defaults.limits,
      presenceLeaseMs: options.presenceLeaseMs ?? 90_000,
      negotiationTimeoutMs: 30_000,
      maxMessageBytes: options.maxMessageBytes,
      maxQueuedMessages: defaults.maxQueuedMessages,
      maxBufferedBytes: options.maxBufferedBytes ?? defaults.maxBufferedBytes,
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
      app_id?: string;
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
    applications,
    client,
    refusal,
    refusedUpgrade,
    http,
    logs,
    url: `ws://${base}/`,
  };
}

const twoApplications = [devApplication('notes'), devApplication('chat')];

/**
 * Two `notes` devices in a session on `one`, and a `chat` device on `two` with the first one's sub
 * and device_id: the `chat` device reaches nothing of `notes`, and `notes` sees nothing of it.
 */
async function isolatesApplications(
  one: Awaited<ReturnType<typeof start>>,
  two: Awaited<ReturnType<typeof start>>,
) {
  const alice = await one.client();
  const bob = await one.client();
  await alice.authenticate({ sub: 'u1', device_id: 'd1', namespaces: ['notes:a'] });
  await bob.authenticate({ sub: 'u2', device_id: 'd2', namespaces: ['notes:a'] });
  for (const client of [alice, bob]) {
    client.send('namespace.join', { namespace: 'notes:a' });
    await client.next('ack');
  }
  await alice.next('presence.changed');
  const target = { namespace: 'notes:a', userId: 'u2', deviceId: 'd2' };
  alice.send('session.create', target);
  const { sessionId } = (await alice.next('session.created')).payload as { sessionId: string };
  await bob.next('session.request');
  bob.send('session.accept', { sessionId });
  await bob.next('ack');
  await alice.next('session.accepted');

  // The same sub and device_id in another application is another device (spec §6.1).
  const twin = await two.client();
  await twin.authenticate({ app_id: 'chat', sub: 'u1', device_id: 'd1', namespaces: ['chat:a'] });
  twin.send('namespace.join', { namespace: 'chat:a' });
  await twin.next('ack');
  const refused: [string, object][] = [
    ['namespace.join', { namespace: 'notes:a' }],
    ['discovery.request', { namespace: 'notes:a' }],
    ['session.create', target],
    ['pairing.create', { namespace: 'notes:a' }],
  ];
  for (const [type, payload] of refused) {
    twin.send(type, payload);
    expect(await twin.next('error')).toMatchObject({ payload: { code: 'not_authorized' } });
  }
  // The other application's session relays nothing for it.
  twin.send('rtc.offer', { sessionId, sdp: 'v=0' });
  expect(await twin.next('error')).toMatchObject({ payload: { code: 'session_unavailable' } });
  // Its own namespace holds none of the other application's devices.
  twin.send('session.create', { ...target, namespace: 'chat:a' });
  expect(await twin.next('error')).toMatchObject({ payload: { code: 'peer_unavailable' } });
  twin.send('discovery.request', { namespace: 'chat:a' });
  expect(await twin.next('discovery.result')).toMatchObject({ payload: { devices: [] } });
  alice.send('discovery.request', { namespace: 'notes:a' });
  expect(await alice.next('discovery.result')).toMatchObject({
    payload: { devices: [{ userId: 'u2', deviceId: 'd2' }] },
  });

  // Beyond the handshake, nothing reached `notes`, and the twin superseded no one.
  const handshake = new Set(['auth.challenge', 'auth.result']);
  for (const client of [alice, bob, twin]) {
    expect(client.received.filter((m) => !handshake.has(m.type))).toEqual([]);
    expect(client.ws.readyState).toBe(WebSocket.OPEN);
  }
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

    it('caps open connections on the instance, authenticated or not, with 503 (ADR 0030)', async () => {
      const { server, client, refusal, logs } = await start({
        trustedProxies: proxied,
        maxConnections: 2,
      });
      const alice = await client(from('203.0.113.1'));
      await alice.authenticate(claims);
      await client(from('203.0.113.2'));
      const refused = await refusal(ip('203.0.113.3'));
      expect(refused.statusCode).toBe(503);
      expect(refused.headers['retry-after']).toBeUndefined();
      expect(server.connections).toBe(2);
      expect(logs.filter((l) => l.event === 'connection.opened')).toHaveLength(2);
      alice.ws.close();
      await alice.closed;
      await vi.waitFor(() => client(from('203.0.113.3')));
      expect((await refusal(ip('203.0.113.4'))).statusCode).toBe(503);
    });

    it('counts upgrades in progress against the cap', async () => {
      // Upgrades wait on the connection-attempt rate limit until the gate opens.
      const coordination = new InMemoryCoordinationAdapter();
      const consume = coordination.consumeRateLimit.bind(coordination);
      let open = () => {};
      const gate = new Promise<void>((resolve) => (open = resolve));
      let reached = () => {};
      const waiting = new Promise<void>((resolve) => (reached = resolve));
      coordination.consumeRateLimit = async (...args) => {
        reached();
        await gate;
        return consume(...args);
      };
      const { client, refusedUpgrade } = await start({ coordination, maxConnections: 1 });
      const pending = client();
      await waiting;
      expect(await refusedUpgrade()).toBe(503);
      open();
      await pending;
    });

    it('frees the slot of an upgrade refused after it was counted', async () => {
      const { client, refusedUpgrade } = await start({
        trustedProxies: proxied,
        maxConnections: 2,
        preAuthentication: { maxUnauthenticatedPerIp: 1 },
      });
      await client(from('203.0.113.1'));
      // The server frees a refused slot when the socket closes, just after the client reads 429.
      for (let i = 0; i < 2; i++) {
        await vi.waitFor(async () => expect(await refusedUpgrade(ip('203.0.113.1'))).toBe(429));
      }
      await vi.waitFor(() => client(from('203.0.113.2')));
      expect(await refusedUpgrade(ip('203.0.113.3'))).toBe(503);
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

    /**
     * Sends an upgrade over raw TCP and resolves to the response's status line and a socket that
     * never closes its side; `ended` resolves once the server closes its own.
     */
    const rawUpgrade = (url: string, headers: Record<string, string> = {}) =>
      new Promise<{ socket: Socket; status: string; ended: Promise<void> }>((resolve) => {
        const { hostname, port } = new URL(url);
        const socket = connect({ host: hostname, port: Number(port), allowHalfOpen: true });
        const ended = new Promise<void>((done) => socket.once('end', () => done()));
        socket.on('error', () => {});
        socket.once('connect', () => {
          const lines = Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`);
          socket.write(
            'GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
              'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
              `${lines.join('')}\r\n`,
          );
        });
        socket.once('data', (data) =>
          resolve({ socket, status: data.toString().split('\r\n')[0] ?? '', ended }),
        );
      });

    it('frees the slot of a refused upgrade whose client never closes its side', async () => {
      const { client, url } = await start({
        trustedProxies: proxied,
        maxConnections: 2,
        preAuthentication: { maxUnauthenticatedPerIp: 1 },
      });
      await client(from('203.0.113.1'));
      const refused = await rawUpgrade(url, ip('203.0.113.1'));
      expect(refused.status).toBe('HTTP/1.1 429 Too Many Requests');
      await refused.ended;
      await vi.waitFor(() => client(from('203.0.113.2')));
      refused.socket.destroy();
    });

    it('terminates a client that misses the deadline and never answers the close', async () => {
      const { server, url } = await start({ authenticationTimeoutMs: 50, closeTimeoutMs: 100 });
      const opened = await rawUpgrade(url);
      expect(opened.status).toBe('HTTP/1.1 101 Switching Protocols');
      expect(server.connections).toBe(1);
      await opened.ended;
      await vi.waitFor(() => expect(server.connections).toBe(0));
      opened.socket.destroy();
    });

    it('survives a client that resets its socket during the upgrade', async () => {
      // The upgrade waits on the connection-attempt rate limit until the client has reset.
      const coordination = new InMemoryCoordinationAdapter();
      const consume = coordination.consumeRateLimit.bind(coordination);
      let reached = () => {};
      const waiting = new Promise<void>((resolve) => (reached = resolve));
      let reset = () => {};
      const gate = new Promise<void>((resolve) => (reset = resolve));
      coordination.consumeRateLimit = async (...args) => {
        reached();
        await gate;
        return consume(...args);
      };
      const { http, url } = await start({ coordination });
      const { hostname, port } = new URL(url);
      const socket = connect({ host: hostname, port: Number(port) });
      socket.on('error', () => {});
      socket.once('connect', () =>
        socket.write(
          'GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
        ),
      );
      await waiting;
      socket.resetAndDestroy();
      await new Promise((resolve) => setTimeout(resolve, 50));
      reset();
      expect(await http('/healthz')).toBe(200);
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

  it('isolates applications that share instances (spec §7.3)', async () => {
    const coordination = new InMemoryCoordinationAdapter();
    const [one, two] = await Promise.all([
      start({ coordination, applications: twoApplications }),
      start({ coordination, applications: twoApplications }),
    ]);
    await isolatesApplications(one, two);
  });

  it('closes on a binary frame with malformed_frame', async () => {
    const { client } = await start();
    const alice = await client();
    alice.ws.send(Buffer.from('{}'), { binary: true });
    expect(await alice.closed).toBe(4002);
    // The challenge comes first, sent on open (ADR 0041).
    expect(alice.received).toMatchObject([
      { version: 1, type: 'auth.challenge' },
      { version: 1, type: 'error', payload: { code: 'malformed_frame' } },
    ]);
  });

  it('closes on an oversized message with message_too_large', async () => {
    const { client } = await start({ maxMessageBytes: 256 });
    const alice = await client();
    alice.send('connection.ping', { pad: 'x'.repeat(300) });
    expect(await alice.closed).toBe(4002);
    expect(alice.received).toMatchObject([
      { type: 'auth.challenge' },
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

  it('renews leases only on the pong that answers its own ping', async () => {
    const coordination = new InMemoryCoordinationAdapter();
    const { client } = await start({ coordination });
    const alice = await client();
    await alice.authenticate({ sub: 'u1', device_id: 'd1', namespaces: ['notes:a'] });
    alice.send('namespace.join', { namespace: 'notes:a' });
    await alice.next('ack');
    const acquire = vi.spyOn(coordination, 'acquirePresence');
    for (let i = 0; i < 50; i++) alice.ws.pong();
    // Frames are handled in order: the reply comes after every pong was.
    alice.send('connection.ping');
    await alice.next('connection.pong');
    expect(acquire).not.toHaveBeenCalled();
  });

  it('terminates a client whose pings fill the send buffer it never reads', async () => {
    const { server, client } = await start({ maxBufferedBytes: 1_000 });
    const alice = await client();
    alice.ws.pause();
    for (let i = 0; i < 40_000; i++) alice.ws.ping(Buffer.alloc(125));
    await vi.waitFor(() => expect(server.connections).toBe(0), { timeout: 5_000 });
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

  it('drains with a delay: fails readiness at once, closes connections after (ADR 0031)', async () => {
    const { server, client, refusedUpgrade, http } = await start();
    const alice = await client();
    await alice.authenticate({ sub: 'u1', device_id: 'd1', namespaces: ['notes:a'] });
    const draining = server.drain(300);
    expect(await http('/readyz')).toBe(503);
    expect(await refusedUpgrade()).toBe(503);
    // The open connection still works while load balancers stop routing here.
    alice.send('namespace.join', { namespace: 'notes:a' });
    await alice.next('ack');
    await draining;
    expect(await alice.closed).toBe(GOING_AWAY);
  });
});

describe('connectionLifetime', () => {
  it('spreads closures between 90% and 100% of the maximum lifetime (ADR 0029)', () => {
    expect(connectionLifetime(1_000, () => 0)).toBe(900);
    expect(connectionLifetime(1_000, () => 0.5)).toBe(950);
    expect(connectionLifetime(1_000, () => 1)).toBe(1_000);
  });
});

describe('SignalingServer with a maximum connection lifetime', () => {
  it('closes a connection with 1001 within its lifetime and releases its presence', async () => {
    const { client, coordination, logs } = await start({ maxConnectionMs: 300 });
    const opened = Date.now();
    const alice = await client();
    await alice.authenticate({ sub: 'u1', device_id: 'd1', namespaces: ['notes:a'] });
    alice.send('namespace.join', { namespace: 'notes:a' });
    await alice.next('ack');
    expect(await alice.closed).toBe(GOING_AWAY);
    const elapsed = Date.now() - opened;
    expect(elapsed).toBeGreaterThanOrEqual(260);
    await vi.waitFor(async () => expect(await coordination.listPresence('notes:a')).toEqual([]));
    expect(logs).toContainEqual(
      expect.objectContaining({ event: 'connection.closed', code: 1001 }),
    );
  });

  it('stops the lifetime timer of a connection that closes first', async () => {
    const { client, server } = await start({ maxConnectionMs: 600_000 });
    const timers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    const before = timers();
    const alice = await client();
    expect(timers()).toBeGreaterThan(before);
    alice.ws.close();
    await alice.closed;
    await vi.waitFor(() => expect(server.connections).toBe(0));
    await vi.waitFor(() => expect(timers()).toBe(before));
  });

  it('keeps a connection open with no maximum lifetime', async () => {
    const { client } = await start({ maxConnectionMs: 0 });
    const alice = await client();
    const closed = await Promise.race([
      alice.closed,
      new Promise<'open'>((resolve) => setTimeout(() => resolve('open'), 100)),
    ]);
    expect(closed).toBe('open');
    alice.ws.close();
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
      backoff: { baseMs: 20, maxMs: 100 },
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

  it('reconnects and joins again once the connection reaches its maximum lifetime', async () => {
    const { url, logs } = await start({ maxConnectionMs: 300 });
    const alice = sdk(url, 'alice', 'laptop');
    const bob = sdk(url, 'bob', 'phone');
    await alice.client.connect();
    await alice.client.join('notes:a');
    await bob.client.connect();
    await bob.client.join('notes:a');
    await vi.waitFor(() => {
      expect(logs.filter((l) => l.event === 'connection.closed' && l.code === 1001)).not.toEqual(
        [],
      );
      expect(logs.filter((l) => l.event === 'connection.authenticated').length).toBeGreaterThan(2);
    });
    await vi.waitFor(async () =>
      expect(await alice.client.discover('notes:a')).toEqual([
        { userId: 'bob', deviceId: 'phone' },
      ]),
    );
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

    async function instance(prefix: string, options: Options = {}) {
      const redis = await openRedisCoordination({
        url: redisUrl as string,
        prefix,
        onError: () => {},
      });
      opened.push(redis);
      return { ...(await start({ ...options, coordination: redis.coordination })), redis };
    }

    /**
     * Stands for a load balancer: the client keeps one URL, and each connection reaches whichever
     * instance `target` names when it opens. `cut` drops every connection, as a failing network or
     * a stopped instance would.
     */
    async function balancer(first: string) {
      let target = new URL(first);
      const sockets = new Set<Socket>();
      const proxy = createServer((downstream) => {
        const upstream = connect(Number(target.port), target.hostname);
        for (const socket of [downstream, upstream]) {
          sockets.add(socket);
          socket.on('close', () => sockets.delete(socket));
          socket.on('error', () => {});
        }
        downstream.pipe(upstream).pipe(downstream);
        downstream.on('close', () => upstream.destroy());
        upstream.on('close', () => downstream.destroy());
      });
      await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
      const { port } = proxy.address() as { port: number };
      const cut = () => sockets.forEach((socket) => socket.destroy());
      return {
        url: `ws://127.0.0.1:${port}/`,
        route: (url: string) => (target = new URL(url)),
        cut,
        close: () => {
          const closed = new Promise<void>((resolve) => proxy.close(() => resolve()));
          cut();
          return closed;
        },
      };
    }

    /** Alice on `one` through the balancer, Bob on `two`, in an established session. */
    async function establish(one: { url: string }, two: { url: string }) {
      const lb = await balancer(one.url);
      const alice = sdk(lb.url, 'alice', 'laptop');
      const bob = sdk(two.url, 'bob', 'phone');
      const requests: SessionRequest[] = [];
      bob.client.on('sessionRequest', (r) => requests.push(r));
      for (const { client } of [alice, bob]) {
        await client.connect();
        await client.join('notes:a');
      }
      const peer = { namespace: 'notes:a', userId: 'bob', deviceId: 'phone' };
      await vi.waitFor(() => expect(alice.presence).toEqual([{ ...peer, present: true }]));
      const session = await alice.client.createSession(peer);
      const request = await vi.waitFor(() => {
        expect(requests).toHaveLength(1);
        return requests[0]!;
      });
      const accepted = new Promise((resolve) => session.on('accepted', resolve));
      const target = await request.accept();
      await accepted;
      return { lb, alice, bob, session, target, requests };
    }

    /** Alice, back on `two`, sees Bob again and opens a new session with him. */
    async function recovered({ alice, requests }: Awaited<ReturnType<typeof establish>>) {
      const peer = { namespace: 'notes:a', userId: 'bob', deviceId: 'phone' };
      await vi.waitFor(() => expect(alice.client.state).toBe('connected'));
      expect(await alice.client.discover('notes:a')).toEqual([
        { userId: 'bob', deviceId: 'phone' },
      ]);
      const again = await alice.client.createSession(peer);
      const request = await vi.waitFor(() => {
        expect(requests).toHaveLength(2);
        return requests[1]!;
      });
      const accepted = new Promise((resolve) => again.on('accepted', resolve));
      await request.accept();
      await accepted;
    }

    it('recovers a client whose instance drains onto another instance', async () => {
      const prefix = `test:${randomUUID()}:`;
      const [one, two] = await Promise.all([instance(prefix), instance(prefix)]);
      const established = await establish(one, two);
      const { lb, alice, bob, session, target } = established;
      const ended = new Promise((resolve) => session.on('ended', resolve));
      const targetEnded = new Promise((resolve) => target.on('ended', resolve));

      lb.route(two.url);
      await one.server.drain();
      await expect(targetEnded).resolves.toEqual({ reason: 'peer_disconnected' });
      await ended;
      await recovered(established);
      const alicePresent = { namespace: 'notes:a', userId: 'alice', deviceId: 'laptop' };
      await vi.waitFor(() =>
        expect(bob.presence).toEqual([
          { ...alicePresent, present: false },
          { ...alicePresent, present: true },
        ]),
      );
      expect(alice.client.state).toBe('connected');
      await lb.close();
    });

    it('recovers a client whose instance fails without releasing anything', async () => {
      const prefix = `test:${randomUUID()}:`;
      // Bob's instance checks his session's peer on every heartbeat (ADR 0026).
      const [one, two] = await Promise.all([
        instance(prefix),
        instance(prefix, { heartbeatIntervalMs: 100 }),
      ]);
      const established = await establish(one, two);
      const { lb, session, target } = established;
      const ended = new Promise((resolve) => session.on('ended', resolve));
      const targetEnded = new Promise((resolve) => target.on('ended', resolve));

      // The failed instance loses Redis first, so it cannot release its claim, presence, or sessions.
      opened.splice(opened.indexOf(one.redis), 1);
      await one.redis.end();
      lb.route(two.url);
      lb.cut();
      await ended;
      await recovered(established);
      await expect(targetEnded).resolves.toEqual({ reason: 'peer_disconnected' });
      await lb.close();
    });

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

    it('isolates applications that share instances (spec §7.3)', async () => {
      const prefix = `test:${randomUUID()}:`;
      const options = { applications: twoApplications };
      const [one, two] = await Promise.all([instance(prefix, options), instance(prefix, options)]);
      await isolatesApplications(one, two);
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

    it("applies another instance's reload: closes connections and refuses tokens", async () => {
      const prefix = `test:${randomUUID()}:`;
      const [one, two] = await Promise.all([instance(prefix), instance(prefix)]);
      // Stands for PostgreSQL, where every instance stores the registry it installs (ADR 0021).
      const stored = new InMemoryApplicationRepository();
      const [notes] = await two.applications.getAll();
      let registry: Registry = { applications: [notes!], revoked: new Set() };
      const stop = await followRegistry(two.coordination, 60_000, () => {
        void syncRegistry(stored, two.applications, registry, true).then((next) => {
          registry = next;
          return two.server.enforce(next.applications);
        });
      });
      const alice = await two.client();
      await alice.authenticate({ sub: 'alice', device_id: 'laptop', namespaces: ['notes:a'] });

      await stored.replaceAll([{ ...notes!, status: 'suspended' }]);
      await one.coordination.publish(REGISTRY_TOPIC, REGISTRY_CHANGED);
      expect(await alice.next('error')).toMatchObject({
        payload: { code: 'application_unavailable' },
      });
      expect(await alice.closed).toBe(4002);
      const bob = await two.client();
      bob.send('auth.authenticate', {
        token: await mintDevToken(
          { app_id: 'notes', sub: 'bob', device_id: 'phone', namespaces: ['notes:a'] },
          { now: new Date() },
        ),
      });
      expect(await bob.next('error')).toMatchObject({
        payload: { code: 'application_unavailable' },
      });
      await stop();
    });
  });
});
