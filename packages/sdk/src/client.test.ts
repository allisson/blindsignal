import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { backoffDelay } from './backoff.ts';
import { BlindSignalClient, type BlindSignalClientOptions } from './client.ts';
import { BlindSignalError } from './errors.ts';
import { FakeSocket } from './testing/fake-socket.ts';

const identity = { userId: 'alice', deviceId: 'laptop' };
const iceConfig = { iceServers: [{ urls: ['turn:turn.example'], username: 'u', credential: 'c' }] };
const day = 86_400_000;

type Sent = { type: string; requestId: string; payload: object };

function setup(options: Partial<BlindSignalClientOptions> = {}) {
  const sockets: FakeSocket[] = [];
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

  it.each([1006, 1001, 4001])('reconnects with a new token after close %i', async (code) => {
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

describe('backoffDelay', () => {
  it('draws a full-jitter delay below the doubling, capped bound', () => {
    random.mockReturnValue(0.25);
    const options = { baseMs: 1_000, maxMs: 30_000 };
    expect([0, 1, 4, 5, 10].map((attempt) => backoffDelay(attempt, options))).toEqual([
      250, 500, 4_000, 7_500, 7_500,
    ]);
  });
});
