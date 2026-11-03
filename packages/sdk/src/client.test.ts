import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { backoffDelay } from './backoff.ts';
import { BlindSignalClient, type BlindSignalClientOptions, type SessionRequest } from './client.ts';
import type { DeviceKey } from './device-key.ts';
import { BlindSignalError } from './errors.ts';
import { FakePeerConnection } from './testing/fake-peer.ts';
import { FakeSocket } from './testing/fake-socket.ts';

const identity = { userId: 'alice', deviceId: 'laptop' };
const iceConfig = { iceServers: [{ urls: ['turn:turn.example'], username: 'u', credential: 'c' }] };
const day = 86_400_000;

type Sent = { type: string; requestId: string; payload: object };

function setup(options: Partial<BlindSignalClientOptions> = {}) {
  const sockets: FakeSocket[] = [];
  const peers: FakePeerConnection[] = [];
  /** Sockets that fail to open, in creation order; the rest open, unless `hold` keeps them pending. */
  const failOpen: boolean[] = [];
  const control = { hold: false };
  let issued = 0;
  const accessTokenProvider = vi.fn(() => Promise.resolve(`t${++issued}`));
  const client = new BlindSignalClient({
    serverUrl: 'wss://signal.example/',
    accessTokenProvider,
    // Off unless a test turns it on, so long timer advances do not trip it.
    heartbeat: { intervalMs: day, timeoutMs: 10_000 },
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      const fail = failOpen[sockets.length] ?? false;
      sockets.push(socket);
      if (!control.hold) queueMicrotask(() => (fail ? socket.drop(1006) : socket.open()));
      return socket as unknown as WebSocket;
    },
    createPeerConnection: (configuration) => {
      const pc = new FakePeerConnection(configuration);
      peers.push(pc);
      return pc as unknown as RTCPeerConnection;
    },
    ...options,
  });
  const states: unknown[] = [];
  client.on('state', (s) => states.push(s));
  const socket = () => sockets.at(-1)!;
  const last = () => socket().sent.at(-1) as Sent;
  const sent = (type: string) => socket().sent.filter((m) => (m as Sent).type === type);
  const reply = (type: string, payload: object) =>
    socket().receive({ version: 1, type, requestId: last().requestId, payload });
  return {
    client,
    sockets,
    peers,
    failOpen,
    control,
    socket,
    last,
    sent,
    reply,
    states,
    accessTokenProvider,
  };
}

type Harness = ReturnType<typeof setup>;

/** Runs due timers and the promise chains they start. */
async function flush() {
  for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0);
}

/** Answers the pending `auth.authenticate` on the latest socket. */
async function authenticate(harness: Harness, expiresInMs = 300_000) {
  await flush();
  expect(harness.last().type).toBe('auth.authenticate');
  harness.reply('auth.result', { ...identity, expiresInMs });
  harness.socket().receive({ version: 1, type: 'rtc.ice_config', payload: iceConfig });
  await flush();
}

async function connected(expiresInMs = 300_000, options?: Partial<BlindSignalClientOptions>) {
  const harness = setup(options);
  const connecting = harness.client.connect();
  await authenticate(harness, expiresInMs);
  await connecting;
  return harness;
}

let random: MockInstance<() => number>;

beforeEach(() => {
  vi.useFakeTimers();
  random = vi.spyOn(Math, 'random').mockReturnValue(0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('BlindSignalClient connection', () => {
  it('refuses an insecure server URL', () => {
    expect(() => setup({ serverUrl: 'ws://signal.example/' })).toThrow(TypeError);
  });

  it('authenticates with a fresh token and keeps the ICE configuration', async () => {
    const { client, socket, states, accessTokenProvider } = setup();
    expect(client.state).toBe('disconnected');
    const connecting = client.connect();
    await flush();
    expect(socket().url.href).toBe('wss://signal.example/');
    expect(socket().sent).toEqual([
      { version: 1, type: 'auth.authenticate', requestId: 'r1', payload: { token: 't1' } },
    ]);
    socket().receive({
      version: 1,
      type: 'auth.result',
      requestId: 'r1',
      payload: { ...identity, expiresInMs: 300_000 },
    });
    socket().receive({ version: 1, type: 'rtc.ice_config', payload: iceConfig });
    await expect(connecting).resolves.toEqual(identity);
    expect(client.iceConfig).toEqual(iceConfig);
    expect(client.state).toBe('connected');
    expect(states).toEqual([{ state: 'connecting' }, { state: 'connected' }]);
    expect(accessTokenProvider).toHaveBeenCalledTimes(1);
  });

  it('resolves connect at once when connected, and joins an attempt in progress', async () => {
    const harness = setup();
    const first = harness.client.connect();
    const second = harness.client.connect();
    await authenticate(harness);
    await expect(Promise.all([first, second])).resolves.toEqual([identity, identity]);
    await expect(harness.client.connect()).resolves.toEqual(identity);
    expect(harness.sockets).toHaveLength(1);
  });

  it('retries with backoff when the provider fails, before opening a socket', async () => {
    random.mockReturnValue(0.5);
    const harness = setup();
    harness.accessTokenProvider.mockRejectedValueOnce(new Error('backend down'));
    const connecting = harness.client.connect();
    await flush();
    expect(harness.sockets).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(499);
    expect(harness.sockets).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await authenticate(harness);
    await expect(connecting).resolves.toEqual(identity);
  });

  it('retries with backoff when the socket fails to open', async () => {
    const harness = setup();
    harness.failOpen.push(true);
    const connecting = harness.client.connect();
    await flush();
    await authenticate(harness);
    await expect(connecting).resolves.toEqual(identity);
    expect(harness.sockets).toHaveLength(2);
    expect(harness.states).toEqual([{ state: 'connecting' }, { state: 'connected' }]);
  });

  it('closes the socket and retries after a retryable authentication error', async () => {
    const harness = setup();
    const connecting = harness.client.connect();
    await flush();
    harness.reply('error', { code: 'invalid_token' });
    await flush();
    expect(harness.sockets[0]!.closedWith).toBe(1000);
    await authenticate(harness);
    await expect(connecting).resolves.toEqual(identity);
    expect(harness.sockets).toHaveLength(2);
    expect(harness.sent('auth.authenticate')).toMatchObject([{ payload: { token: 't2' } }]);
  });

  it('waits retryAfterMs after rate_limited when it exceeds the backoff', async () => {
    const harness = setup();
    harness.client.connect().catch(() => undefined);
    await flush();
    harness.reply('error', { code: 'rate_limited', retryAfterMs: 5_000 });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(harness.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(harness.sockets).toHaveLength(2);
  });

  it('stops after a terminal authentication error', async () => {
    const harness = setup();
    const connecting = harness.client.connect();
    await flush();
    harness.reply('error', { code: 'application_unavailable' });
    await expect(connecting).rejects.toEqual(new BlindSignalError('application_unavailable'));
    expect(harness.socket().closedWith).toBe(1000);
    expect(harness.client.state).toBe('disconnected');
    expect(harness.states.at(-1)).toEqual({
      state: 'disconnected',
      error: 'application_unavailable',
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.sockets).toHaveLength(1);
  });

  it('starts the backoff over when connect() follows a stop', async () => {
    random.mockReturnValue(0.5);
    const harness = setup();
    harness.failOpen.push(true, true);
    harness.client.connect().catch(() => undefined);
    await vi.advanceTimersByTimeAsync(1_500);
    await flush();
    harness.reply('error', { code: 'application_unavailable' });
    await flush();
    expect(harness.client.state).toBe('disconnected');
    harness.failOpen[3] = true;
    harness.client.connect().catch(() => undefined);
    await flush();
    expect(harness.sockets).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(500);
    await flush();
    expect(harness.sockets).toHaveLength(5);
  });

  it('does not retry a provider failure that close() interrupted', async () => {
    const harness = setup();
    let fail!: (error: Error) => void;
    harness.accessTokenProvider.mockReturnValueOnce(new Promise((_, reject) => (fail = reject)));
    harness.client.connect().catch(() => undefined);
    harness.client.close();
    fail(new Error('backend down'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.sockets).toHaveLength(0);
    expect(harness.client.state).toBe('disconnected');
  });

  it.each([1006, 1001, 1013, 4001])('reconnects with a new token after close %i', async (code) => {
    const harness = await connected();
    harness.socket().drop(code);
    expect(harness.client.state).toBe('connecting');
    await authenticate(harness);
    expect(harness.client.state).toBe('connected');
    expect(harness.sockets).toHaveLength(2);
    expect(harness.sent('auth.authenticate')).toMatchObject([{ payload: { token: 't2' } }]);
    expect(harness.states).toEqual([
      { state: 'connecting' },
      { state: 'connected' },
      { state: 'connecting' },
      { state: 'connected' },
    ]);
  });

  it.each([
    [4002, 'device_revoked', 'device_revoked'],
    [4003, 'superseded', 'superseded'],
    [4002, undefined, 'connection_closed'],
    [1009, undefined, 'message_too_large'],
  ])('stops after close %i with error %s', async (code, sent, reported) => {
    const harness = await connected();
    if (sent) harness.socket().receive({ version: 1, type: 'error', payload: { code: sent } });
    harness.socket().drop(code);
    expect(harness.states.at(-1)).toEqual({ state: 'disconnected', error: reported });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.sockets).toHaveLength(1);
  });

  it('connects again when the application asks after a superseded close', async () => {
    const harness = await connected();
    harness.socket().receive({ version: 1, type: 'error', payload: { code: 'superseded' } });
    harness.socket().drop(4003);
    const connecting = harness.client.connect();
    await authenticate(harness);
    await expect(connecting).resolves.toEqual(identity);
    expect(harness.sockets).toHaveLength(2);
  });

  it('grows the backoff across failed attempts and resets it after a stable connection', async () => {
    random.mockReturnValue(0.5);
    const harness = setup();
    harness.failOpen.push(true, true, true);
    harness.client.connect().catch(() => undefined);
    await flush();
    // Delays 500, 1000, 2000 after each failed open.
    for (const [i, delay] of [500, 1_000, 2_000].entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(harness.sockets).toHaveLength(i + 1);
      await vi.advanceTimersByTimeAsync(1);
      await flush();
    }
    await authenticate(harness);
    // Dropped before 30 s: the count keeps growing (attempt 3, 4000).
    harness.socket().drop(1006);
    await vi.advanceTimersByTimeAsync(3_999);
    expect(harness.sockets).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(1);
    await authenticate(harness);
    // Dropped after 30 s: back to attempt 0, 500.
    await vi.advanceTimersByTimeAsync(30_000);
    harness.socket().drop(1006);
    await vi.advanceTimersByTimeAsync(499);
    expect(harness.sockets).toHaveLength(5);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(harness.sockets).toHaveLength(6);
  });

  it('closes and stops reconnecting on close()', async () => {
    random.mockReturnValue(0.5);
    const harness = await connected();
    harness.socket().drop(1006);
    const connecting = harness.client.connect();
    harness.client.close();
    await expect(connecting).rejects.toEqual(new BlindSignalError('connection_closed'));
    expect(harness.states.at(-1)).toEqual({ state: 'disconnected' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.sockets).toHaveLength(1);
  });

  it('closes an open connection on close()', async () => {
    const harness = await connected();
    harness.client.close();
    expect(harness.socket().closedWith).toBe(1000);
    expect(harness.client.state).toBe('disconnected');
    harness.client.close();
    expect(harness.states).toHaveLength(3);
  });

  it('discards an attempt that close() interrupts', async () => {
    const harness = setup();
    harness.client.connect().catch(() => undefined);
    harness.client.close();
    await flush();
    expect(harness.sockets).toHaveLength(0);

    harness.control.hold = true;
    harness.client.connect().catch(() => undefined);
    await flush();
    harness.client.close();
    harness.socket().open();
    await flush();
    expect(harness.socket().closedWith).toBe(1000);
    expect(harness.socket().sent).toEqual([]);
    harness.control.hold = false;

    harness.client.connect().catch(() => undefined);
    await flush();
    harness.client.close();
    harness.reply('auth.result', { ...identity, expiresInMs: 300_000 });
    await flush();
    expect(harness.socket().closedWith).toBe(1000);
    expect(harness.client.state).toBe('disconnected');
  });
});

describe('BlindSignalClient heartbeat', () => {
  const heartbeat = { intervalMs: 25_000, timeoutMs: 10_000 };

  it('pings on the interval while the server answers', async () => {
    const harness = await connected(day * 2, { heartbeat });
    await vi.advanceTimersByTimeAsync(24_999);
    expect(harness.sent('connection.ping')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.sent('connection.ping')).toHaveLength(1);
    harness.reply('connection.pong', {});
    await vi.advanceTimersByTimeAsync(25_000);
    expect(harness.sent('connection.ping')).toHaveLength(2);
    harness.reply('error', { code: 'rate_limited', retryAfterMs: 1_000 });
    await vi.advanceTimersByTimeAsync(25_000);
    expect(harness.sent('connection.ping')).toHaveLength(3);
    expect(harness.client.state).toBe('connected');
  });

  it('drops the connection and reconnects when a pong is missed', async () => {
    const harness = await connected(day * 2, { heartbeat });
    await vi.advanceTimersByTimeAsync(25_000 + 9_999);
    expect(harness.client.state).toBe('connected');
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.socket().closedWith).toBe(1000);
    expect(harness.client.state).toBe('connecting');
    // Timers nested this deep are clamped to 4 ms, as in browsers.
    await vi.advanceTimersByTimeAsync(4);
    await authenticate(harness);
    expect(harness.sockets).toHaveLength(2);
    // The dead socket's own close arrives late and changes nothing.
    harness.sockets[0]!.drop(1006);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.sockets).toHaveLength(2);
    expect(harness.client.state).toBe('connected');
  });

  it('leaves no timer behind when a ping in flight ends after close()', async () => {
    const harness = await connected(day * 2, { heartbeat });
    await vi.advanceTimersByTimeAsync(25_000);
    harness.client.close();
    harness.socket().drop(1000);
    await flush();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops pinging once closed', async () => {
    const harness = await connected(day * 2, { heartbeat });
    harness.client.close();
    await vi.advanceTimersByTimeAsync(100_000);
    expect(harness.sent('connection.ping')).toHaveLength(0);
  });
});

describe('BlindSignalClient device key', () => {
  const challenge = (harness: Harness, nonce: string) =>
    harness.socket().receive({ version: 1, type: 'auth.challenge', payload: { nonce } });

  function deviceKey() {
    const proof = vi.fn((token: string, nonce: string) => Promise.resolve(`${token}@${nonce}`));
    return { proof, deviceKey: { thumbprint: 'jkt', proof } as unknown as DeviceKey };
  }

  it('waits for the challenge and proves possession for every token', async () => {
    const harness = setup(deviceKey());
    const connecting = harness.client.connect();
    await flush();
    expect(harness.socket().sent).toEqual([]);
    challenge(harness, 'n1');
    await authenticate(harness);
    await connecting;
    expect(harness.sent('auth.authenticate')).toMatchObject([
      { payload: { token: 't1', proof: 't1@n1' } },
    ]);
    // The refresh and the heartbeat: the challenge's timeout is gone.
    expect(vi.getTimerCount()).toBe(2);
    await vi.advanceTimersByTimeAsync(240_000);
    expect(harness.last()).toMatchObject({
      type: 'auth.refresh',
      payload: { token: 't2', proof: 't2@n1' },
    });
  });

  it('gives up on a connection whose challenge does not come in time', async () => {
    const harness = setup(deviceKey());
    void harness.client.connect();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(harness.socket().closedWith).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.socket().closedWith).toBe(1000);
    expect(harness.socket().sent).toEqual([]);
    expect(harness.client.state).toBe('connecting');
    await vi.advanceTimersByTimeAsync(4);
    expect(harness.sockets).toHaveLength(2);
    challenge(harness, 'n2');
    await authenticate(harness);
    expect(harness.client.state).toBe('connected');
  });

  it('reconnects at once when the connection closes before its challenge', async () => {
    const harness = setup(deviceKey());
    void harness.client.connect();
    await flush();
    harness.socket().drop(1006);
    await vi.advanceTimersByTimeAsync(4);
    expect(harness.sockets).toHaveLength(2);
  });

  it('drops an attempt closed while it waits for the challenge', async () => {
    const harness = setup(deviceKey());
    const connecting = harness.client.connect();
    await flush();
    harness.client.close();
    await expect(connecting).rejects.toThrow('connection_closed');
    challenge(harness, 'n1');
    await flush();
    expect(harness.socket().sent).toEqual([]);
    expect(harness.socket().closedWith).toBe(1000);
  });

  it('ignores the challenge without a device key', async () => {
    const harness = setup();
    void harness.client.connect();
    await flush();
    challenge(harness, 'n1');
    await authenticate(harness);
    expect(harness.sent('auth.authenticate')).toMatchObject([{ payload: { token: 't1' } }]);
    expect(harness.sent('auth.authenticate')[0]).not.toHaveProperty('payload.proof');
  });
});

describe('BlindSignalClient refresh', () => {
  it('refreshes with a new token before expiry and reschedules from the new result', async () => {
    const { last, reply, accessTokenProvider } = await connected(300_000);
    await vi.advanceTimersByTimeAsync(239_999);
    expect(last().type).toBe('auth.authenticate');
    await vi.advanceTimersByTimeAsync(1);
    expect(last()).toMatchObject({ type: 'auth.refresh', payload: { token: 't2' } });
    reply('auth.result', { ...identity, expiresInMs: 100_000 });
    await vi.advanceTimersByTimeAsync(39_999);
    expect(accessTokenProvider).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(last()).toMatchObject({ type: 'auth.refresh', payload: { token: 't3' } });
  });

  it('refreshes at once when the token expires within the margin', async () => {
    const { last } = await connected(30_000, { refreshMarginMs: 60_000 });
    await flush();
    expect(last().type).toBe('auth.refresh');
  });

  it('retries a failed refresh with backoff until the token expires', async () => {
    random.mockReturnValue(0.5);
    const backoff = { baseMs: 1_000, maxMs: 4_000 };
    const { sent, reply } = await connected(70_000, { backoff });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent('auth.refresh')).toHaveLength(1);
    // Delays: 500, 1000, 2000, then 2000 (capped), until the 60 s left run out.
    const delays = [500, 1_000, 2_000, 2_000];
    for (const [i, delay] of delays.entries()) {
      reply('error', { code: 'identity_mismatch' });
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(sent('auth.refresh')).toHaveLength(i + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(sent('auth.refresh')).toHaveLength(i + 2);
    }
    await vi.advanceTimersByTimeAsync(53_499);
    reply('error', { code: 'identity_mismatch' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sent('auth.refresh')).toHaveLength(delays.length + 1);
  });

  it('waits retryAfterMs after a rate-limited refresh', async () => {
    const { sent, reply } = await connected(70_000);
    await vi.advanceTimersByTimeAsync(10_000);
    reply('error', { code: 'rate_limited', retryAfterMs: 3_000 });
    await vi.advanceTimersByTimeAsync(2_999);
    expect(sent('auth.refresh')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent('auth.refresh')).toHaveLength(2);
  });

  it('retries when the provider fails during a refresh', async () => {
    random.mockReturnValue(0.5);
    const { accessTokenProvider, last } = await connected(70_000);
    accessTokenProvider.mockRejectedValueOnce(new Error('backend down'));
    await vi.advanceTimersByTimeAsync(10_499);
    expect(last().type).toBe('auth.authenticate');
    await vi.advanceTimersByTimeAsync(1);
    expect(last()).toMatchObject({ type: 'auth.refresh', payload: { token: 't2' } });
  });

  it('stops refreshing once closed', async () => {
    const { client, accessTokenProvider } = await connected(70_000);
    client.close();
    await vi.advanceTimersByTimeAsync(70_000);
    expect(accessTokenProvider).toHaveBeenCalledTimes(1);
  });
});

describe('BlindSignalClient after a reconnect', () => {
  /** Authenticates the new connection with a long-lived token; any refresh on it is a leftover. */
  async function leftovers(harness: Harness) {
    await authenticate(harness, day);
    await vi.advanceTimersByTimeAsync(120_000);
    return harness.sent('auth.refresh');
  }

  it('drops the refresh scheduled by a closed connection', async () => {
    const harness = await connected(70_000);
    harness.client.close();
    void harness.client.connect();
    expect(await leftovers(harness)).toEqual([]);
  });

  it('drops the refresh scheduled by a dropped connection', async () => {
    const harness = await connected(70_000);
    harness.socket().drop(1006);
    expect(await leftovers(harness)).toEqual([]);
  });

  it('drops a refresh result that arrives after close', async () => {
    const harness = await connected(70_000);
    await vi.advanceTimersByTimeAsync(10_000);
    harness.client.close();
    harness.reply('auth.result', { ...identity, expiresInMs: 70_000 });
    void harness.client.connect();
    expect(await leftovers(harness)).toEqual([]);
  });

  it('drops the retry of a refresh cut by a dropped connection', async () => {
    const harness = await connected(70_000);
    await vi.advanceTimersByTimeAsync(10_000);
    // The reconnect draws first and goes at once; the refresh retry would come 900 ms later.
    random.mockReturnValueOnce(0).mockReturnValueOnce(0.9);
    harness.socket().drop(4001);
    expect(await leftovers(harness)).toEqual([]);
  });
});

describe('BlindSignalClient namespaces', () => {
  /** Replies to the request on the latest socket that asked for `namespace`. */
  function answer(harness: Harness, namespace: string, type: string, payload: object = {}) {
    const request = harness
      .socket()
      .sent.findLast(
        (m) => ((m as Sent).payload as { namespace?: string }).namespace === namespace,
      );
    harness.socket().receive({ version: 1, type, requestId: (request as Sent).requestId, payload });
  }

  it('joins, discovers, and leaves', async () => {
    const harness = await connected();
    const joining = harness.client.join('notes:a');
    expect(harness.last()).toMatchObject({
      type: 'namespace.join',
      payload: { namespace: 'notes:a' },
    });
    harness.reply('ack', {});
    await joining;
    const discovering = harness.client.discover('notes:a');
    expect(harness.last()).toMatchObject({
      type: 'discovery.request',
      payload: { namespace: 'notes:a' },
    });
    const devices = [{ userId: 'bob', deviceId: 'phone' }];
    harness.reply('discovery.result', { namespace: 'notes:a', devices });
    await expect(discovering).resolves.toEqual(devices);
    const leaving = harness.client.leave('notes:a');
    expect(harness.last()).toMatchObject({
      type: 'namespace.leave',
      payload: { namespace: 'notes:a' },
    });
    harness.reply('ack', {});
    await leaving;
  });

  it('rejects with the server error', async () => {
    const harness = await connected();
    const joining = harness.client.join('notes:x');
    harness.reply('error', { code: 'not_authorized' });
    await expect(joining).rejects.toEqual(new BlindSignalError('not_authorized'));
    const discovering = harness.client.discover('notes:x');
    harness.reply('error', { code: 'not_joined' });
    await expect(discovering).rejects.toEqual(new BlindSignalError('not_joined'));
    const leaving = harness.client.leave('notes:x');
    harness.reply('error', { code: 'rate_limited', retryAfterMs: 1_000 });
    await expect(leaving).rejects.toEqual(new BlindSignalError('rate_limited', 1_000));
  });

  it('rejects join and discover without a connection, and leaves locally', async () => {
    const { client } = setup();
    await expect(client.join('notes:a')).rejects.toEqual(new BlindSignalError('connection_closed'));
    await expect(client.discover('notes:a')).rejects.toEqual(
      new BlindSignalError('connection_closed'),
    );
    await expect(client.leave('notes:a')).resolves.toBeUndefined();
  });

  it('emits presence changes', async () => {
    const harness = await connected();
    const presence: unknown[] = [];
    harness.client.on('presence', (p) => presence.push(p));
    const payload = { namespace: 'notes:a', userId: 'bob', deviceId: 'phone', present: true };
    harness.socket().receive({ version: 1, type: 'presence.changed', payload });
    expect(presence).toEqual([payload]);
  });

  it('joins again after a reconnect before reporting connected', async () => {
    const harness = await connected();
    const failures: unknown[] = [];
    harness.client.on('rejoinFailed', (f) => failures.push(f));
    for (const namespace of ['notes:a', 'notes:b', 'notes:c', 'notes:x']) {
      const joining = harness.client.join(namespace);
      if (namespace === 'notes:x') harness.reply('error', { code: 'not_authorized' });
      else harness.reply('ack', {});
      await joining.catch(() => undefined);
    }
    const leaving = harness.client.leave('notes:c');
    harness.reply('ack', {});
    await leaving;

    harness.socket().drop(1006);
    await authenticate(harness);
    expect(harness.sent('namespace.join').map((m) => (m as Sent).payload)).toEqual([
      { namespace: 'notes:a' },
      { namespace: 'notes:b' },
    ]);
    expect(harness.client.state).toBe('connecting');
    answer(harness, 'notes:a', 'ack');
    answer(harness, 'notes:b', 'error', { code: 'not_authorized' });
    await flush();
    expect(harness.client.state).toBe('connected');
    expect(failures).toEqual([{ namespace: 'notes:b', error: 'not_authorized' }]);

    harness.socket().drop(1006);
    await authenticate(harness);
    expect(harness.sent('namespace.join').map((m) => (m as Sent).payload)).toEqual([
      { namespace: 'notes:a' },
    ]);
  });

  it('keeps a namespace whose rejoin a dropped connection cut', async () => {
    const harness = await connected();
    const failures: unknown[] = [];
    harness.client.on('rejoinFailed', (f) => failures.push(f));
    const joining = harness.client.join('notes:a');
    harness.reply('ack', {});
    await joining;
    harness.socket().drop(1006);
    await authenticate(harness);
    harness.socket().drop(1006);
    await authenticate(harness);
    expect(harness.sent('namespace.join')).toHaveLength(1);
    expect(failures).toEqual([]);
    expect(harness.sockets).toHaveLength(3);
  });

  it('does not report connected when closed while rejoining', async () => {
    const harness = await connected();
    const joining = harness.client.join('notes:a');
    harness.reply('ack', {});
    await joining;
    harness.socket().drop(1006);
    await authenticate(harness);
    harness.client.close();
    answer(harness, 'notes:a', 'ack');
    await flush();
    expect(harness.client.state).toBe('disconnected');
    expect(harness.states.at(-1)).toEqual({ state: 'disconnected' });
  });
});

describe('BlindSignalClient sessions', () => {
  const peer = { namespace: 'notes:a', userId: 'bob', deviceId: 'phone' };
  const event = (type: string, payload: object) => ({ version: 1, type, payload });

  async function created(harness: Harness) {
    const creating = harness.client.createSession({ ...peer, extra: 'x' } as typeof peer);
    expect(harness.last()).toMatchObject({ type: 'session.create', payload: peer });
    expect((harness.last().payload as Record<string, unknown>).extra).toBeUndefined();
    const sessionId = crypto.randomUUID();
    harness.reply('session.created', { sessionId });
    const session = await creating;
    const ended: unknown[] = [];
    session.on('ended', (e) => ended.push(e));
    return { session, sessionId, ended };
  }

  function requested(harness: Harness) {
    const requests: SessionRequest[] = [];
    harness.client.on('sessionRequest', (r) => requests.push(r));
    const sessionId = crypto.randomUUID();
    harness.socket().receive(event('session.request', { sessionId, ...peer }));
    expect(requests).toHaveLength(1);
    return { request: requests[0]!, sessionId };
  }

  it('creates a pending session that the target accepts', async () => {
    const harness = await connected();
    const { session, sessionId } = await created(harness);
    expect(session).toMatchObject({ id: sessionId, peer, role: 'requester', state: 'pending' });
    let accepted = 0;
    session.on('accepted', () => accepted++);
    harness.socket().receive(event('session.accepted', { sessionId }));
    harness.socket().receive(event('session.accepted', { sessionId }));
    expect(session.state).toBe('active');
    expect(accepted).toBe(1);
  });

  it('ends a session the target rejects', async () => {
    const harness = await connected();
    const { session, sessionId, ended } = await created(harness);
    harness.socket().receive(event('session.rejected', { sessionId }));
    expect(session.state).toBe('ended');
    expect(ended).toEqual([{ reason: 'rejected' }]);
    harness.socket().receive(event('session.accepted', { sessionId }));
    expect(session.state).toBe('ended');
  });

  it.each(['closed_by_peer', 'peer_disconnected', 'peer_revoked', 'timeout'])(
    'ends a session terminated with %s',
    async (reason) => {
      const harness = await connected();
      const { session, sessionId, ended } = await created(harness);
      harness.socket().receive(event('session.terminated', { sessionId, reason }));
      harness.socket().receive(event('session.terminated', { sessionId, reason: 'timeout' }));
      expect(session.state).toBe('ended');
      expect(ended).toEqual([{ reason }]);
    },
  );

  it('rejects createSession with the server error or without a connection', async () => {
    const harness = await connected();
    const creating = harness.client.createSession(peer);
    harness.reply('error', { code: 'peer_unavailable' });
    await expect(creating).rejects.toEqual(new BlindSignalError('peer_unavailable'));
    harness.client.close();
    await expect(harness.client.createSession(peer)).rejects.toEqual(
      new BlindSignalError('connection_closed'),
    );
  });

  it('rejects createSession when the connection drops before the reply is handled', async () => {
    const harness = await connected();
    const creating = harness.client.createSession(peer);
    harness.reply('session.created', { sessionId: crypto.randomUUID() });
    harness.socket().drop(1006);
    await expect(creating).rejects.toEqual(new BlindSignalError('connection_closed'));
  });

  it('closes a session, telling the server, once', async () => {
    const harness = await connected();
    const { session, sessionId, ended } = await created(harness);
    session.close();
    expect(harness.last()).toMatchObject({ type: 'session.close', payload: { sessionId } });
    harness.reply('error', { code: 'session_unavailable' });
    session.close();
    expect(harness.sent('session.close')).toHaveLength(1);
    expect(ended).toEqual([{ reason: 'closed' }]);
    harness.socket().receive(event('session.terminated', { sessionId, reason: 'timeout' }));
    expect(ended).toHaveLength(1);
    await flush();
  });

  it('accepts a session request', async () => {
    const harness = await connected();
    const { request, sessionId } = requested(harness);
    expect(request).toMatchObject({ sessionId, ...peer });
    const accepting = request.accept();
    expect(harness.last()).toMatchObject({ type: 'session.accept', payload: { sessionId } });
    harness.reply('ack', {});
    const session = await accepting;
    expect(session).toMatchObject({ id: sessionId, peer, role: 'target', state: 'active' });
    const ended: unknown[] = [];
    session.on('ended', (e) => ended.push(e));
    harness.socket().receive(event('session.terminated', { sessionId, reason: 'closed_by_peer' }));
    expect(ended).toEqual([{ reason: 'closed_by_peer' }]);
  });

  it('rejects a session request', async () => {
    const harness = await connected();
    const { request, sessionId } = requested(harness);
    const rejecting = request.reject();
    expect(harness.last()).toMatchObject({ type: 'session.reject', payload: { sessionId } });
    harness.reply('ack', {});
    await expect(rejecting).resolves.toBeUndefined();
  });

  it('fails to accept a request that timed out or lost its connection', async () => {
    const harness = await connected();
    const { request } = requested(harness);
    const accepting = request.accept();
    harness.reply('error', { code: 'session_unavailable' });
    await expect(accepting).rejects.toEqual(new BlindSignalError('session_unavailable'));

    const late = request.accept();
    harness.reply('ack', {});
    harness.socket().drop(1006);
    await expect(late).rejects.toEqual(new BlindSignalError('connection_closed'));
    await expect(request.accept()).rejects.toEqual(new BlindSignalError('connection_closed'));
    await expect(request.reject()).rejects.toEqual(new BlindSignalError('connection_closed'));
  });

  it('ends every session when the connection drops or the client closes', async () => {
    const harness = await connected();
    const first = await created(harness);
    const second = await created(harness);
    harness.socket().drop(1006);
    expect(first.ended).toEqual([{ reason: 'disconnected' }]);
    expect(second.ended).toEqual([{ reason: 'disconnected' }]);
    await authenticate(harness);
    harness.socket().receive(event('session.accepted', { sessionId: first.sessionId }));
    expect(first.session.state).toBe('ended');

    const third = await created(harness);
    harness.client.close();
    expect(third.ended).toEqual([{ reason: 'disconnected' }]);
    third.session.close();
    expect(harness.sent('session.close')).toHaveLength(0);
  });
});

describe('BlindSignalClient WebRTC', () => {
  const peer = { namespace: 'notes:a', userId: 'bob', deviceId: 'phone' };
  const event = (type: string, payload: object) => ({ version: 1, type, payload });
  const candidate = { candidate: 'candidate:1 1 udp 1 192.0.2.1 9 typ host', sdpMid: '0' };

  /** A requester session the target accepted, with its offer sent. */
  async function accepted(harness: Harness) {
    const creating = harness.client.createSession(peer);
    const sessionId = crypto.randomUUID();
    harness.reply('session.created', { sessionId });
    const session = await creating;
    const pc = harness.peers.at(-1)!;
    const channel = pc.channels[0]!;
    const events: unknown[] = [];
    session.on('open', () => events.push('open'));
    session.on('data', (data) => events.push(data));
    session.on('close', () => events.push('close'));
    harness.socket().receive(event('session.accepted', { sessionId }));
    await flush();
    return { session, sessionId, pc, channel, events };
  }

  it('refuses TURN in iceServers', () => {
    for (const urls of [
      'turn:turn.example',
      'turn:stun:turn.example',
      ['stun:stun.example', 'turns:turn.example'],
    ]) {
      expect(() => setup({ iceServers: [{ urls }] })).toThrow(TypeError);
    }
    expect(() =>
      setup({ iceServers: [{ urls: ['STUN:a.example', 'stuns:b.example'] }] }),
    ).not.toThrow();
  });

  it('applies iceTransportPolicy to every peer connection', async () => {
    const harness = await connected(300_000, { iceTransportPolicy: 'relay' });
    await accepted(harness);
    expect(harness.peers[0]!.configuration).toEqual({
      iceServers: iceConfig.iceServers,
      iceTransportPolicy: 'relay',
    });
  });

  it('merges the STUN servers with the latest rtc.ice_config', async () => {
    const stun = { urls: 'stun:stun.example' };
    const harness = await connected(300_000, { iceServers: [stun] });
    await accepted(harness);
    expect(harness.peers[0]!.configuration).toEqual({
      iceServers: [stun, ...iceConfig.iceServers],
    });
    const fresh = {
      iceServers: [{ urls: ['turn:other.example'], username: 'v', credential: 'd' }],
    };
    harness.socket().receive(event('rtc.ice_config', fresh));
    await accepted(harness);
    expect(harness.peers[1]!.configuration).toEqual({ iceServers: [stun, ...fresh.iceServers] });
  });

  it('defaults to no ICE servers before any rtc.ice_config', async () => {
    const harness = setup();
    const connecting = harness.client.connect();
    await flush();
    harness.reply('auth.result', { ...identity, expiresInMs: 300_000 });
    await connecting;
    await accepted(harness);
    expect(harness.peers[0]!.configuration).toEqual({ iceServers: [] });
  });

  it('negotiates through the signaling connection and exchanges data', async () => {
    const harness = await connected();
    const { session, sessionId, pc, channel, events } = await accepted(harness);
    expect(harness.last()).toMatchObject({
      type: 'rtc.offer',
      payload: { sessionId, sdp: 'offer sdp' },
    });
    harness.socket().receive(event('rtc.answer', { sessionId, sdp: 'answer sdp' }));
    harness
      .socket()
      .receive(event('rtc.ice_candidate', { sessionId, candidate: JSON.stringify(candidate) }));
    harness.socket().receive(event('rtc.answer', { sessionId: crypto.randomUUID(), sdp: 'x' }));
    await flush();
    expect(pc.remoteDescription).toEqual({ type: 'answer', sdp: 'answer sdp' });
    expect(pc.candidates).toEqual([candidate]);
    pc.gather(candidate);
    expect(harness.last()).toMatchObject({
      type: 'rtc.ice_candidate',
      payload: { sessionId, candidate: JSON.stringify(candidate) },
    });
    channel.open();
    session.send('hi');
    channel.receive('hello');
    expect(channel.sent).toEqual(['hi']);
    expect(events).toEqual(['open', 'hello']);
  });

  it('answers as the target', async () => {
    const harness = await connected();
    let accepting!: Promise<unknown>;
    const sessionId = crypto.randomUUID();
    harness.client.on('sessionRequest', (request) => {
      accepting = request.accept();
    });
    harness.socket().receive(event('session.request', { sessionId, ...peer }));
    harness.reply('ack', {});
    await accepting;
    harness.socket().receive(event('rtc.offer', { sessionId, sdp: 'offer sdp' }));
    await flush();
    expect(harness.last()).toMatchObject({
      type: 'rtc.answer',
      payload: { sessionId, sdp: 'answer sdp' },
    });
    expect(harness.peers[0]!.channels).toEqual([]);
  });

  it('relays nothing once the session ended', async () => {
    const harness = await connected();
    const { sessionId, pc } = await accepted(harness);
    pc.channels[0]!.open();
    harness
      .socket()
      .receive(event('session.terminated', { sessionId, reason: 'peer_disconnected' }));
    const before = harness.socket().sent.length;
    pc.gather(candidate);
    expect(harness.socket().sent).toHaveLength(before);
    harness.socket().receive(event('rtc.answer', { sessionId, sdp: 'answer sdp' }));
    await flush();
    expect(pc.remoteDescription).toBeNull();
  });

  it.each(['closed_by_peer', 'peer_revoked', 'namespace_unauthorized', 'timeout'])(
    'closes an open DataChannel on %s',
    async (reason) => {
      const harness = await connected();
      const { sessionId, channel, events } = await accepted(harness);
      channel.open();
      harness.socket().receive(event('session.terminated', { sessionId, reason }));
      expect(channel.readyState).toBe('closed');
      expect(events).toEqual(['open', 'close']);
    },
  );

  it('keeps an open DataChannel when only signaling is lost, and closes one still opening', async () => {
    const harness = await connected();
    const open = await accepted(harness);
    const opening = await accepted(harness);
    const disconnected = await accepted(harness);
    open.channel.open();
    disconnected.channel.open();
    harness
      .socket()
      .receive(
        event('session.terminated', { sessionId: open.sessionId, reason: 'peer_disconnected' }),
      );
    harness
      .socket()
      .receive(
        event('session.terminated', { sessionId: opening.sessionId, reason: 'peer_disconnected' }),
      );
    harness.socket().drop(1006);
    expect(open.channel.readyState).toBe('open');
    expect(disconnected.channel.readyState).toBe('open');
    expect(opening.channel.readyState).toBe('closed');
    expect(opening.events).toEqual(['close']);

    open.session.send('still here');
    expect(open.channel.sent).toEqual(['still here']);
    open.session.close();
    expect(open.channel.readyState).toBe('closed');
    expect(open.events).toEqual(['open', 'close']);
  });

  it('closes the DataChannel with the session, and on rejection', async () => {
    const harness = await connected();
    const closed = await accepted(harness);
    closed.channel.open();
    closed.session.close();
    expect(closed.channel.readyState).toBe('closed');
    expect(harness.last()).toMatchObject({
      type: 'session.close',
      payload: { sessionId: closed.sessionId },
    });

    const creating = harness.client.createSession(peer);
    const sessionId = crypto.randomUUID();
    harness.reply('session.created', { sessionId });
    await creating;
    harness.socket().receive(event('session.rejected', { sessionId }));
    expect(harness.peers.at(-1)!.connectionState).toBe('closed');
  });

  it.each([
    [4002, 'device_revoked', 'closed'],
    [1009, undefined, 'closed'],
    [4003, 'superseded', 'open'],
  ])('after close %i, leaves open DataChannels %s', async (code, sent, state) => {
    const harness = await connected();
    const ended = await accepted(harness);
    const active = await accepted(harness);
    ended.channel.open();
    active.channel.open();
    harness
      .socket()
      .receive(
        event('session.terminated', { sessionId: ended.sessionId, reason: 'peer_disconnected' }),
      );
    if (sent) harness.socket().receive({ version: 1, type: 'error', payload: { code: sent } });
    harness.socket().drop(code);
    expect(ended.channel.readyState).toBe(state);
    expect(active.channel.readyState).toBe(state);
  });

  it('closes open DataChannels when reauthentication is rejected as terminal, not as superseded', async () => {
    for (const [code, state] of [
      ['device_revoked', 'closed'],
      ['superseded', 'open'],
    ] as const) {
      const harness = await connected();
      const { channel } = await accepted(harness);
      channel.open();
      harness.socket().drop(1006);
      await flush();
      harness.reply('error', { code });
      await flush();
      expect(harness.client.state).toBe('disconnected');
      expect(channel.readyState).toBe(state);
    }
  });

  it('restarts ICE up to 3 times with the latest rtc.ice_config, then ends the session', async () => {
    const harness = await connected();
    const { session, sessionId, pc, events } = await accepted(harness);
    const ended: unknown[] = [];
    session.on('ended', (e) => ended.push(e));
    const fresh = {
      iceServers: [{ urls: ['turn:other.example'], username: 'v', credential: 'd' }],
    };
    harness.socket().receive(event('rtc.ice_config', fresh));
    for (let i = 0; i < 3; i++) {
      pc.state('failed');
      await flush();
    }
    expect(pc.iceRestarts).toBe(3);
    expect(pc.configuration).toEqual(fresh);
    expect(harness.sent('rtc.offer')).toHaveLength(4);
    pc.state('failed');
    expect(events).toEqual(['close']);
    expect(ended).toEqual([{ reason: 'closed' }]);
    expect(harness.last()).toMatchObject({ type: 'session.close', payload: { sessionId } });
  });

  it('restarts ICE when the connection does not connect in time, 30 s by default', async () => {
    for (const [options, timeoutMs] of [
      [undefined, 30_000],
      [{ connectTimeoutMs: 5_000 }, 5_000],
    ] as const) {
      const harness = await connected(300_000, options);
      const { sessionId, pc } = await accepted(harness);
      harness.socket().receive(event('rtc.answer', { sessionId, sdp: 'answer sdp' }));
      await vi.advanceTimersByTimeAsync(timeoutMs - 1);
      expect(pc.iceRestarts).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(pc.iceRestarts).toBe(1);
    }
  });

  it('does not restart ICE once the session ended', async () => {
    const harness = await connected();
    const { sessionId, pc, channel, events } = await accepted(harness);
    channel.open();
    harness
      .socket()
      .receive(event('session.terminated', { sessionId, reason: 'peer_disconnected' }));
    pc.state('failed');
    expect(pc.iceRestarts).toBe(0);
    expect(events).toEqual(['open', 'close']);
    expect(harness.sent('session.close')).toHaveLength(0);
  });

  it('reports the connection type', async () => {
    const harness = await connected();
    const { session, pc } = await accepted(harness);
    const types: unknown[] = [];
    session.on('connectionType', (type) => types.push(type));
    pc.stats = new Map(
      Object.entries({
        p: { type: 'candidate-pair', selected: true, localCandidateId: 'r' },
        r: { type: 'local-candidate', candidateType: 'relay' },
      }),
    );
    pc.state('connected');
    await flush();
    expect(session.connectionType).toBe('relay');
    expect(types).toEqual(['relay']);
  });

  it('leaves open DataChannels to their sessions on close()', async () => {
    const harness = await connected();
    const { channel } = await accepted(harness);
    channel.open();
    harness.client.close();
    expect(channel.readyState).toBe('open');
  });
});

describe('backoffDelay', () => {
  it('draws a full-jitter delay below the doubling, capped bound', () => {
    random.mockReturnValue(0.25);
    const options = { baseMs: 1_000, maxMs: 30_000 };
    expect([0, 1, 4, 5, 10].map((attempt) => backoffDelay(attempt, options))).toEqual([
      250, 500, 4_000, 7_500, 7_500,
    ]);
  });
});
