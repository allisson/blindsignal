import { randomUUID } from 'node:crypto';
import { connect, createServer, type AddressInfo, type Socket } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { describeCoordinationContract } from '@blindsignal/core/testing';
import { createClient } from '@redis/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { openRedisCoordination, RedisCoordinationAdapter, type RedisClient } from './index.ts';

// Runs only against a server: `docker compose --profile valkey up --wait valkey` (ADR 0019).
const url = process.env.BLINDSIGNAL_TEST_REDIS_URL;
const clients: RedisClient[] = [];

async function connected(): Promise<RedisClient> {
  const client = createClient({ url });
  clients.push(client);
  await client.connect();
  return client;
}

/** An instance's adapter, on its own connections; tests share a prefix to share state. */
async function instance(prefix = `test:${randomUUID()}:`) {
  const [client, subscriber] = await Promise.all([connected(), connected()]);
  const coordination = new RedisCoordinationAdapter({ client, subscriber, prefix });
  return { client, subscriber, prefix, coordination };
}

/**
 * A TCP proxy to the server that tells the subscriber's connection, the one that sent SUBSCRIBE,
 * from the command connection, so a test can cut either and refuse its reconnection, or stall
 * every reply, as a server that stops answering.
 */
async function proxy() {
  const target = new URL(url!);
  const pairs: { sockets: Socket[]; subscriber: boolean }[] = [];
  let refusing = false;
  let stalled = false;
  const held: [Socket, Buffer][] = [];
  const server = createServer((downstream) => {
    if (refusing) return void downstream.destroy();
    const upstream = connect(Number(target.port), target.hostname);
    const pair = { sockets: [downstream, upstream], subscriber: false };
    pairs.push(pair);
    for (const socket of pair.sockets) socket.on('error', () => {});
    downstream.on('data', (chunk: Buffer) => {
      if (chunk.toString().toUpperCase().includes('SUBSCRIBE')) pair.subscriber = true;
    });
    downstream.pipe(upstream);
    upstream.on('data', (chunk: Buffer) =>
      stalled ? held.push([downstream, chunk]) : downstream.write(chunk),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `redis://127.0.0.1:${(server.address() as AddressInfo).port}`,
    cut(subscriber: boolean) {
      refusing = true;
      for (const pair of pairs) {
        if (pair.subscriber === subscriber) for (const socket of pair.sockets) socket.destroy();
      }
    },
    stall() {
      stalled = true;
    },
    /** Delivers the replies held since the stall, and every reply after them. */
    resume() {
      stalled = false;
      for (const [socket, chunk] of held.splice(0)) socket.write(chunk);
    },
    close() {
      for (const socket of pairs.flatMap((pair) => pair.sockets)) socket.destroy();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

afterAll(async () => {
  await Promise.all(clients.map((client) => client.close()));
});

describe.skipIf(url === undefined)('RedisCoordinationAdapter', () => {
  let shared: Awaited<ReturnType<typeof instance>>;
  beforeAll(async () => {
    shared = await instance();
  });

  describeCoordinationContract('RedisCoordinationAdapter', () => {
    const prefix = `test:${randomUUID()}:`;
    const { client, subscriber } = shared;
    return Promise.resolve({
      coordination: new RedisCoordinationAdapter({ client, subscriber, prefix }),
      elapse: (ms: number) => sleep(ms),
    });
  });

  it('leaves no key behind once every lease, slot, claim, and bucket expires', async () => {
    const { client, prefix, coordination } = await instance();
    const device = { appId: 'notes', userId: 'u1', deviceId: 'd1' };
    await coordination.claimJti('iss', 'j1', 100);
    await coordination.claimDeviceConnection(device, 'c1', 100);
    await coordination.renewDeviceConnection({ ...device, deviceId: 'd2' }, 'c2', 100);
    await coordination.acquirePresence('notes:a', device, 'c1', 100);
    await coordination.acquireSlots('h1', [{ key: 'app', limit: 1 }], 100);
    await coordination.consumeRateLimit('k', { ratePerSecond: 10, burst: 1 });
    expect((await client.keys(`${prefix}*`)).length).toBe(7);
    await sleep(250);
    expect(await client.keys(`${prefix}*`)).toEqual([]);
  });

  it('sends a script again once the server has forgotten it', async () => {
    const { client, coordination } = await instance();
    await coordination.acquireSlots('h1', [{ key: 'app', limit: 1 }], 1000);
    await client.scriptFlush();
    expect(await coordination.acquireSlots('h2', [{ key: 'app', limit: 1 }], 1000)).toBe(false);
  });

  it('lets one holder of many, on different instances, take the last slot', async () => {
    const a = await instance();
    const b = await instance(a.prefix);
    const slot = [{ key: 'app', limit: 1 }];
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        (i % 2 === 0 ? a : b).coordination.acquireSlots(`h${i}`, slot, 1000),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('delivers an event published on another instance', async () => {
    const a = await instance();
    const b = await instance(a.prefix);
    const seen: unknown[] = [];
    await a.coordination.subscribe('connection:c1', (event) => seen.push(event));
    await b.coordination.publish('connection:c1', { type: 'superseded' });
    await vi.waitFor(() => expect(seen).toEqual([{ type: 'superseded' }]));
  });

  it('drops a message that is not JSON, and delivers the next event', async () => {
    const { client, prefix, coordination } = await instance();
    const seen: unknown[] = [];
    await coordination.subscribe('connection:c1', (event) => seen.push(event));
    await client.publish(`${prefix}topic:connection:c1`, '{');
    await coordination.publish('connection:c1', { type: 'superseded' });
    await vi.waitFor(() => expect(seen).toEqual([{ type: 'superseded' }]));
  });

  it('pings both connections, and rejects once they have ended (ADR 0028)', async () => {
    const opened = await openRedisCoordination({ url: url!, onError: () => {} });
    await expect(opened.ping()).resolves.toBeUndefined();
    await opened.end();
    await expect(opened.ping()).rejects.toThrow();
  });

  it.each([
    ['the subscriber connection', true],
    ['the command connection', false],
  ])('rejects a ping while %s is down', async (_, subscriber) => {
    const tcp = await proxy();
    const opened = await openRedisCoordination({ url: tcp.url, onError: () => {} });
    try {
      await opened.coordination.subscribe('t', () => {});
      await expect(opened.ping()).resolves.toBeUndefined();
      tcp.cut(subscriber);
      await vi.waitFor(() => expect(opened.ping()).rejects.toThrow());
    } finally {
      await opened.end().catch(() => {});
      await tcp.close();
    }
  });

  it('fails a command the server does not answer within the timeout (ADR 0023)', async () => {
    const tcp = await proxy();
    const opened = await openRedisCoordination({
      url: tcp.url,
      onError: () => {},
      commandTimeoutMs: 200,
    });
    try {
      await expect(opened.coordination.claimJti('i', randomUUID(), 1000)).resolves.toBe(true);
      tcp.stall();
      const started = Date.now();
      await expect(
        opened.coordination.consumeRateLimit('k', { ratePerSecond: 1, burst: 1 }),
      ).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(2000);
      // The late reply goes to the command that timed out, not to the next one.
      tcp.resume();
      await expect(opened.coordination.claimJti('i', randomUUID(), 1000)).resolves.toBe(true);
    } finally {
      // A close waits for the replies held, which the client discards once they arrive.
      tcp.resume();
      await opened.end().catch(() => {});
      await tcp.close();
    }
  });
});
