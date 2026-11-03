import { createHash } from 'node:crypto';
import type {
  CoordinationAdapter,
  DeviceIdentity,
  RateLimitDecision,
  RateLimitPolicy,
  Slot,
} from '@blindsignal/core';
import type { RedisClientType } from '@redis/client';

export type RedisClient = RedisClientType;

interface Script {
  readonly source: string;
  readonly sha: string;
}

/** Every script reads the time from the server, so every instance shares one clock (ADR 0022). */
const script = (body: string): Script => {
  const source = `local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local function extend(key, ttl)
  if redis.call('PTTL', key) < ttl then redis.call('PEXPIRE', key, ttl) end
end
${body}`;
  return { source, sha: createHash('sha1').update(source).digest('hex') };
};

/** KEYS: the device's claim. ARGV: the connection. */
const RELEASE_DEVICE_CONNECTION = script(`
if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('DEL', KEYS[1]) end
return 0`);

/**
 * KEYS: the namespace's leases (a sorted set scored by expiry) and their holders (a hash).
 * ARGV: the device, the connection, the ttl.
 */
const ACQUIRE_PRESENCE = script(`
local ttl = tonumber(ARGV[3])
for _, device in ipairs(redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', now)) do
  redis.call('HDEL', KEYS[2], device)
end
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
redis.call('ZADD', KEYS[1], now + ttl, ARGV[1])
redis.call('HSET', KEYS[2], ARGV[1], ARGV[2])
extend(KEYS[1], ttl)
extend(KEYS[2], ttl)
return 0`);

/** KEYS: as for `ACQUIRE_PRESENCE`. ARGV: the device, the connection. */
const RELEASE_PRESENCE = script(`
if redis.call('HGET', KEYS[2], ARGV[1]) ~= ARGV[2] then return 0 end
redis.call('HDEL', KEYS[2], ARGV[1])
redis.call('ZREM', KEYS[1], ARGV[1])
return 1`);

/** KEYS: the namespace's leases. */
const LIST_PRESENCE = script(`
return redis.call('ZRANGEBYSCORE', KEYS[1], '(' .. now, '+inf')`);

/**
 * A token bucket per key, created full (ADR 0011), kept until it is full again. KEYS: the bucket.
 * ARGV: the rate per second, the burst.
 */
const CONSUME_RATE_LIMIT = script(`
local rate = tonumber(ARGV[1])
local burst = tonumber(ARGV[2])
local bucket = redis.call('HMGET', KEYS[1], 'tokens', 'updated')
local available = burst
if bucket[1] then
  available = math.min(burst, tonumber(bucket[1]) + (now - tonumber(bucket[2])) / 1000 * rate)
end
if available < 1 then return {0, math.ceil((1 - available) / rate * 1000)} end
local tokens = available - 1
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'updated', tostring(now))
redis.call('PEXPIRE', KEYS[1], math.ceil((burst - tokens) / rate * 1000))
return {1}`);

/**
 * KEYS: each slot key's holders (a sorted set scored by expiry). ARGV: the holder, the ttl, then
 * each key's limit. A slot the holder already has stays its own, without taking a second one.
 */
const ACQUIRE_SLOTS = script(`
local ttl = tonumber(ARGV[2])
for i, key in ipairs(KEYS) do
  redis.call('ZREMRANGEBYSCORE', key, '-inf', now)
  if not redis.call('ZSCORE', key, ARGV[1]) and redis.call('ZCARD', key) >= tonumber(ARGV[i + 2]) then
    return 0
  end
end
for _, key in ipairs(KEYS) do
  redis.call('ZADD', key, now + ttl, ARGV[1])
  extend(key, ttl)
end
return 1`);

const deviceKey = ({ appId, userId, deviceId }: DeviceIdentity) =>
  JSON.stringify([appId, userId, deviceId]);

/** Redis takes whole milliseconds, at least one. */
const ms = (ttlMs: number) => String(Math.max(1, Math.ceil(ttlMs)));

export interface RedisCoordinationOptions {
  /** Runs commands and scripts. */
  readonly client: RedisClient;
  /** A connection of its own, in subscriber mode; one per instance serves every topic. */
  readonly subscriber: RedisClient;
  /** Starts every key and channel, so deployments and tests can share one server. */
  readonly prefix?: string;
}

/**
 * Coordination shared by every instance through a Redis-compatible server (spec §10.2, ADR 0022).
 * Each operation is one command, one script, or one transaction.
 */
export class RedisCoordinationAdapter implements CoordinationAdapter {
  readonly #client: RedisClient;
  readonly #subscriber: RedisClient;
  readonly #prefix: string;

  constructor({ client, subscriber, prefix = 'blindsignal:' }: RedisCoordinationOptions) {
    this.#client = client;
    this.#subscriber = subscriber;
    this.#prefix = prefix;
  }

  async claimJti(issuer: string, jti: string, ttlMs: number): Promise<boolean> {
    const key = this.#key('jti', JSON.stringify([issuer, jti]));
    const reply = await this.#client.set(key, '1', {
      expiration: { type: 'PX', value: Number(ms(ttlMs)) },
      condition: 'NX',
    });
    return reply === 'OK';
  }

  async claimDeviceConnection(
    device: DeviceIdentity,
    connectionId: string,
  ): Promise<string | undefined> {
    const key = this.#key('device', deviceKey(device));
    const previous = await this.#client.set(key, connectionId, { GET: true });
    return previous === null || previous === connectionId ? undefined : String(previous);
  }

  async releaseDeviceConnection(device: DeviceIdentity, connectionId: string): Promise<void> {
    await this.#run(
      RELEASE_DEVICE_CONNECTION,
      [this.#key('device', deviceKey(device))],
      [connectionId],
    );
  }

  async acquirePresence(
    namespace: string,
    device: DeviceIdentity,
    connectionId: string,
    ttlMs: number,
  ): Promise<void> {
    await this.#run(ACQUIRE_PRESENCE, this.#presenceKeys(namespace), [
      deviceKey(device),
      connectionId,
      ms(ttlMs),
    ]);
  }

  async releasePresence(
    namespace: string,
    device: DeviceIdentity,
    connectionId: string,
  ): Promise<boolean> {
    const released = await this.#run(RELEASE_PRESENCE, this.#presenceKeys(namespace), [
      deviceKey(device),
      connectionId,
    ]);
    return released === 1;
  }

  async listPresence(namespace: string): Promise<readonly DeviceIdentity[]> {
    const [leases] = this.#presenceKeys(namespace);
    const devices = (await this.#run(LIST_PRESENCE, [leases], [])) as string[];
    return devices.map((device) => {
      const [appId, userId, deviceId] = JSON.parse(device) as [string, string, string];
      return { appId, userId, deviceId };
    });
  }

  async consumeRateLimit(
    key: string,
    { ratePerSecond, burst }: RateLimitPolicy,
  ): Promise<RateLimitDecision> {
    const [allowed, retryAfterMs] = (await this.#run(
      CONSUME_RATE_LIMIT,
      [this.#key('rate', key)],
      [String(ratePerSecond), String(burst)],
    )) as [number, number?];
    return allowed === 1 ? { allowed: true } : { allowed: false, retryAfterMs: retryAfterMs ?? 0 };
  }

  async acquireSlots(holder: string, slots: readonly Slot[], ttlMs: number): Promise<boolean> {
    const keys = slots.map(({ key }) => this.#key('slots', key));
    const limits = slots.map(({ limit }) => String(limit));
    return (await this.#run(ACQUIRE_SLOTS, keys, [holder, ms(ttlMs), ...limits])) === 1;
  }

  async releaseSlots(holder: string, keys: readonly string[]): Promise<void> {
    const transaction = this.#client.multi();
    for (const key of keys) transaction.zRem(this.#key('slots', key), holder);
    await transaction.exec();
  }

  async publish(topic: string, event: unknown): Promise<void> {
    await this.#client.publish(this.#key('topic', topic), JSON.stringify(event));
  }

  async subscribe(topic: string, handler: (event: unknown) => void): Promise<() => Promise<void>> {
    const channel = this.#key('topic', topic);
    // One listener per call, so subscribing the same handler twice needs two unsubscribes. The
    // client ignores an unsubscribe of a listener it no longer has.
    const listener = (message: string) => handler(JSON.parse(message));
    await this.#subscriber.subscribe(channel, listener);
    return () => this.#subscriber.unsubscribe(channel, listener);
  }

  #key(kind: string, name: string): string {
    return `${this.#prefix}${kind}:${name}`;
  }

  #presenceKeys(namespace: string): [string, string] {
    return [this.#key('presence', namespace), this.#key('presence_holders', namespace)];
  }

  /** Runs a script by its hash, and sends its source once the server does not know it. */
  async #run(script: Script, keys: string[], args: string[]): Promise<unknown> {
    const options = { keys, arguments: args };
    try {
      return await this.#client.evalSha(script.sha, options);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith('NOSCRIPT')) throw error;
      return this.#client.eval(script.source, options);
    }
  }
}
