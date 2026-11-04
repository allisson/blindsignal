import { createHash } from 'node:crypto';
import type {
  CoordinationAdapter,
  DeviceIdentity,
  RateLimitDecision,
  RateLimitPolicy,
  Slot,
} from '@blindsignal/core';
import { createClient, type RedisClientType } from '@redis/client';

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

/** KEYS: the device's claim. ARGV: the connection, the ttl. */
const RENEW_DEVICE_CONNECTION = script(`
local holder = redis.call('GET', KEYS[1])
if holder and holder ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
return 1`);

/**
 * KEYS: the namespace's leases (a sorted set scored by expiry), their holders (a hash), and the
 * device's user's leases in the namespace (a sorted set like the first, for `listPresence` by
 * user). ARGV: the device, the connection, the ttl.
 */
const ACQUIRE_PRESENCE = script(`
local ttl = tonumber(ARGV[3])
for _, device in ipairs(redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', now)) do
  redis.call('HDEL', KEYS[2], device)
end
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', now)
redis.call('ZADD', KEYS[1], now + ttl, ARGV[1])
redis.call('ZADD', KEYS[3], now + ttl, ARGV[1])
redis.call('HSET', KEYS[2], ARGV[1], ARGV[2])
extend(KEYS[1], ttl)
extend(KEYS[2], ttl)
extend(KEYS[3], ttl)
return 0`);

/** KEYS: as for `ACQUIRE_PRESENCE`. ARGV: the device, the connection. */
const RELEASE_PRESENCE = script(`
if redis.call('HGET', KEYS[2], ARGV[1]) ~= ARGV[2] then return 0 end
redis.call('HDEL', KEYS[2], ARGV[1])
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('ZREM', KEYS[3], ARGV[1])
return 1`);

/** KEYS: the namespace's leases, or one user's. */
const LIST_PRESENCE = script(`
return redis.call('ZRANGEBYSCORE', KEYS[1], '(' .. now, '+inf')`);

/** KEYS: the namespace's leases. ARGV: the device. */
const IS_PRESENT = script(`
local expiry = redis.call('ZSCORE', KEYS[1], ARGV[1])
if expiry and tonumber(expiry) > now then return 1 end
return 0`);

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

export interface RedisCoordination {
  readonly coordination: RedisCoordinationAdapter;
  /** Rejects when either connection is down: commands, or the subscriptions (ADR 0028). */
  ping(): Promise<void>;
  end(): Promise<void>;
}

/**
 * Connects the server's two connections, for commands and for subscriptions. While the server is
 * unreachable, commands fail at once instead of waiting in a queue, and `onError` receives each
 * failed attempt to reconnect; the client resubscribes once it is back. A command the server does
 * not answer within `commandTimeoutMs` fails too (ADR 0023).
 */
export async function openRedisCoordination(options: {
  readonly url: string;
  readonly onError: (error: Error) => void;
  readonly prefix?: string;
  readonly commandTimeoutMs?: number;
}): Promise<RedisCoordination> {
  const client = createClient({ url: options.url, disableOfflineQueue: true });
  const subscriber = client.duplicate();
  for (const connection of [client, subscriber]) connection.on('error', options.onError);
  await Promise.all([client.connect(), subscriber.connect()]);
  return {
    coordination: new RedisCoordinationAdapter({
      client,
      subscriber,
      prefix: options.prefix,
      commandTimeoutMs: options.commandTimeoutMs,
    }),
    async ping() {
      if (!subscriber.isReady) throw new Error('the subscriber connection is down');
      await client.ping();
    },
    end: async () => {
      await Promise.all([client.close(), subscriber.close()]);
    },
  };
}

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
  /**
   * Each operation rejects once the server has not answered within it. The client's own command
   * timeout stops at the write, so it never bounds a server that takes a command and hangs.
   */
  readonly commandTimeoutMs?: number | undefined;
}

/**
 * Coordination shared by every instance through a Redis-compatible server (spec §10.2, ADR 0022).
 * Each operation is one command, one script, or one transaction.
 */
export class RedisCoordinationAdapter implements CoordinationAdapter {
  readonly #client: RedisClient;
  readonly #subscriber: RedisClient;
  readonly #prefix: string;
  readonly #commandTimeoutMs: number | undefined;

  constructor({
    client,
    subscriber,
    prefix = 'blindsignal:',
    commandTimeoutMs,
  }: RedisCoordinationOptions) {
    this.#client = client;
    this.#subscriber = subscriber;
    this.#prefix = prefix;
    this.#commandTimeoutMs = commandTimeoutMs;
  }

  async claimJti(issuer: string, jti: string, ttlMs: number): Promise<boolean> {
    const key = this.#key('jti', JSON.stringify([issuer, jti]));
    const reply = await this.#bound(
      this.#client.set(key, '1', {
        expiration: { type: 'PX', value: Number(ms(ttlMs)) },
        condition: 'NX',
      }),
    );
    return reply === 'OK';
  }

  async claimDeviceConnection(
    device: DeviceIdentity,
    connectionId: string,
    ttlMs: number,
  ): Promise<string | undefined> {
    const key = this.#key('device', deviceKey(device));
    const previous = await this.#bound(
      this.#client.set(key, connectionId, {
        expiration: { type: 'PX', value: Number(ms(ttlMs)) },
        GET: true,
      }),
    );
    return previous === null || previous === connectionId ? undefined : String(previous);
  }

  async renewDeviceConnection(
    device: DeviceIdentity,
    connectionId: string,
    ttlMs: number,
  ): Promise<boolean> {
    const key = this.#key('device', deviceKey(device));
    return (await this.#run(RENEW_DEVICE_CONNECTION, [key], [connectionId, ms(ttlMs)])) === 1;
  }

  async releaseDeviceConnection(device: DeviceIdentity, connectionId: string): Promise<void> {
    await this.#run(
      RELEASE_DEVICE_CONNECTION,
      [this.#key('device', deviceKey(device))],
      [connectionId],
    );
  }

  async connectionOf(device: DeviceIdentity): Promise<string | undefined> {
    return (
      (await this.#bound(this.#client.get(this.#key('device', deviceKey(device))))) ?? undefined
    );
  }

  async acquirePresence(
    namespace: string,
    device: DeviceIdentity,
    connectionId: string,
    ttlMs: number,
  ): Promise<void> {
    await this.#run(ACQUIRE_PRESENCE, this.#presenceKeys(namespace, device.userId), [
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
    const released = await this.#run(
      RELEASE_PRESENCE,
      this.#presenceKeys(namespace, device.userId),
      [deviceKey(device), connectionId],
    );
    return released === 1;
  }

  async listPresence(
    namespace: string,
    filter?: { readonly userId: string },
  ): Promise<readonly DeviceIdentity[]> {
    const keys = this.#presenceKeys(namespace, filter?.userId ?? '');
    const leases = filter === undefined ? keys[0] : keys[2];
    const devices = (await this.#run(LIST_PRESENCE, [leases], [])) as string[];
    return devices.map((device) => {
      const [appId, userId, deviceId] = JSON.parse(device) as [string, string, string];
      return { appId, userId, deviceId };
    });
  }

  async isPresent(namespace: string, device: DeviceIdentity): Promise<boolean> {
    const [leases] = this.#presenceKeys(namespace, device.userId);
    return (await this.#run(IS_PRESENT, [leases], [deviceKey(device)])) === 1;
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
    await this.#bound(transaction.exec());
  }

  async publish(topic: string, event: unknown): Promise<void> {
    await this.#bound(this.#client.publish(this.#key('topic', topic), JSON.stringify(event)));
  }

  async subscribe(topic: string, handler: (event: unknown) => void): Promise<() => Promise<void>> {
    const channel = this.#key('topic', topic);
    // One listener per call, so subscribing the same handler twice needs two unsubscribes. The
    // client ignores an unsubscribe of a listener it no longer has.
    const listener = (message: string) => {
      let event: unknown;
      // A message that is not JSON came from no instance: dropped, as an event nobody expects.
      try {
        event = JSON.parse(message);
      } catch {
        return;
      }
      handler(event);
    };
    await this.#bound(this.#subscriber.subscribe(channel, listener));
    return () => this.#subscriber.unsubscribe(channel, listener);
  }

  #key(kind: string, name: string): string {
    return `${this.#prefix}${kind}:${name}`;
  }

  #presenceKeys(namespace: string, userId: string): [string, string, string] {
    return [
      this.#key('presence', namespace),
      this.#key('presence_holders', namespace),
      this.#key('presence_user', JSON.stringify([namespace, userId])),
    ];
  }

  /** Runs a script by its hash, and sends its source once the server does not know it. */
  #run(script: Script, keys: string[], args: string[]): Promise<unknown> {
    const options = { keys, arguments: args };
    return this.#bound(
      this.#client.evalSha(script.sha, options).catch((error: unknown) => {
        if (!(error instanceof Error) || !error.message.startsWith('NOSCRIPT')) throw error;
        return this.#client.eval(script.source, options);
      }),
    );
  }

  /** The reply, or a rejection once the timeout passes; a late reply is then discarded. */
  async #bound<T>(reply: Promise<T>): Promise<T> {
    const timeoutMs = this.#commandTimeoutMs;
    if (timeoutMs === undefined) return reply;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Redis did not answer in time')), timeoutMs);
    });
    try {
      return await Promise.race([reply, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}
