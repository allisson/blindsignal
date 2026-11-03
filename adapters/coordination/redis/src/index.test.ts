import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { describeCoordinationContract } from '@blindsignal/core/testing';
import { createClient } from '@redis/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RedisCoordinationAdapter, type RedisClient } from './index.ts';

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
    await coordination.acquirePresence('notes:a', device, 'c1', 100);
    await coordination.acquireSlots('h1', [{ key: 'app', limit: 1 }], 100);
    await coordination.consumeRateLimit('k', { ratePerSecond: 10, burst: 1 });
    expect((await client.keys(`${prefix}*`)).length).toBe(5);
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
});
